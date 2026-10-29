import { z } from 'zod'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'

// A secret a provider signed in with. Storage treats its provider-defined payload as opaque.
export const CredentialRecord = z.object({
  kind: z.string().max(32),
  payload: z.record(z.string(), z.string()),
  // Who the credential belongs to, as the provider reported it at sign-in.
  account: z.string().max(200).nullable(),
  updatedAt: z.number()
})
export type CredentialRecord = z.infer<typeof CredentialRecord>

const CredentialFile = z.object({ version: z.literal(1), records: z.record(z.string(), CredentialRecord) })

const recordKey = (provider: string, instance: string) => `${provider}/${instance}`

// Records per provider instance in one owner-only file. Configuration elsewhere never holds secrets.
// Writes go one at a time, each from the records as the last one left them: two callers saving at
// once (a source and a model provider, say) would otherwise each write the file without the other.
export class CredentialStore {
  private records: Record<string, CredentialRecord> = {}
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.file)
      const parsed = raw === undefined ? null : CredentialFile.safeParse(raw)
      if (parsed && !parsed.success) {
        console.error(`[conclave-core] ${this.file} is not a credential file; ignoring it until the next sign-in`)
      }
      this.records = parsed?.success ? parsed.data.records : {}
    } catch (error) {
      console.error(`[conclave-core] cannot read ${this.file}:`, error instanceof Error ? error.message : error)
      this.records = {}
    }
  }

  get(provider: string, instance: string): CredentialRecord | null {
    return this.records[recordKey(provider, instance)] ?? null
  }

  // The instances a provider has records under, to find the ones nothing names any more.
  instances(provider: string): string[] {
    const prefix = `${provider}/`
    return Object.keys(this.records).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }

  // Memory changes only once the file does, so a failed write keeps the credential that worked.
  set(provider: string, instance: string, record: CredentialRecord): Promise<void> {
    return this.write((records) => ({ ...records, [recordKey(provider, instance)]: record }))
  }

  delete(provider: string, instance: string): Promise<void> {
    return this.write(({ [recordKey(provider, instance)]: _removed, ...records }) => records)
  }

  private write(change: (records: Record<string, CredentialRecord>) => Record<string, CredentialRecord>): Promise<void> {
    const next = this.queue.then(async () => {
      const records = change(this.records)
      await writePrivateJson(this.file, { version: 1, records })
      this.records = records
    })
    this.queue = next.catch(() => {})
    return next
  }
}
