import type { ChatPermissionMode } from '@conclave/protocol'

// ZCode's collaboration modes, and plan apart from them: planning is a flag over the mode it then
// carries the plan out in. readOnly runs in build, where every change asks, and Conclave refuses
// each ask; ZCode has no read-only mode of its own.
export type ZCodeMode = { mode: 'build' | 'edit' | 'guarded' | 'yolo'; planEnabled: boolean }

export const ZCODE_MODES = {
  ask: { mode: 'build', planEnabled: false },
  acceptEdits: { mode: 'edit', planEnabled: false },
  plan: { mode: 'build', planEnabled: true },
  auto: { mode: 'guarded', planEnabled: false },
  readOnly: { mode: 'build', planEnabled: false },
  bypass: { mode: 'yolo', planEnabled: false }
} as const satisfies Partial<Record<ChatPermissionMode, ZCodeMode>>

export type ZCodePermissionMode = keyof typeof ZCODE_MODES

export function isZCodeMode(mode: string): mode is ZCodePermissionMode {
  return Object.hasOwn(ZCODE_MODES, mode)
}

// The Conclave mode a session's config amounts to; build reads as readOnly where the stage chose that.
export function conclaveMode(config: { mode?: string; planEnabled?: boolean }, readOnly: boolean): ZCodePermissionMode | null {
  if (config.planEnabled || config.mode === 'plan') return 'plan'
  switch (config.mode) {
    case 'build': return readOnly ? 'readOnly' : 'ask'
    case 'edit': return 'acceptEdits'
    case 'guarded': return 'auto'
    case 'yolo': return 'bypass'
    default: return null
  }
}
