import { z } from 'zod'

// A session config option (mode, model, reasoning level) as ACP lists it, its values flat or grouped.
export const AcpOptionValue = z.looseObject({ value: z.string(), name: z.string(), description: z.string().nullish() })
export type AcpOptionValue = z.infer<typeof AcpOptionValue>
export const AcpConfig = z.looseObject({ id: z.string(), category: z.string().optional(), name: z.string(), currentValue: z.string(), options: z.array(z.union([AcpOptionValue, z.looseObject({ group: z.string(), options: z.array(AcpOptionValue) })])).catch([]) })
export type AcpConfig = z.infer<typeof AcpConfig>

export const valuesOf = (config: AcpConfig): AcpOptionValue[] => config.options.flatMap((option) => {
  const single = AcpOptionValue.safeParse(option)
  if (single.success) return [single.data]
  return z.looseObject({ options: z.array(AcpOptionValue) }).safeParse(option).data?.options ?? []
})

// A model an agent lists beyond its session config, with the config options (its reasoning
// levels) it takes.
export type AcpModel = { value: string; name: string; configOptions: AcpConfig[] }
