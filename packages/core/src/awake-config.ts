import { z } from 'zod'
import { ComputerAwakeMode, type ComputerAwakeMode as ComputerAwakeModeValue } from '@conclave/protocol'
import { readJsonIfExists, writePrivateJson } from '@conclave/protocol/node'

const AwakeConfig = z.object({ version: z.literal(1), mode: ComputerAwakeMode }).catch({ version: 1, mode: 'auto' })

export class AwakeConfigStore {
  private mode: ComputerAwakeModeValue = 'auto'

  constructor(private readonly file: string) {}

  async load(): Promise<ComputerAwakeModeValue> {
    this.mode = AwakeConfig.parse(await readJsonIfExists(this.file)).mode
    return this.mode
  }

  async save(mode: ComputerAwakeModeValue): Promise<void> {
    await writePrivateJson(this.file, { version: 1, mode })
    this.mode = mode
  }
}
