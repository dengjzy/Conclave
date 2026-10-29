import type { ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { cursorDialect } from './cursor-dialect'

export const CURSOR_MODES = cursorDialect.modes

export class CursorAcp extends AcpDriver {
  constructor(stageId: string, options: ChatStageOptions, catalogOnly = false) {
    super(cursorDialect, stageId, options, catalogOnly)
  }
}
