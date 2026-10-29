import type { ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { opencodeDialect } from './opencode-dialect'

export const OPENCODE_MODES = opencodeDialect.modes

export class OpenCodeAcp extends AcpDriver {
  constructor(stageId: string, options: ChatStageOptions) {
    super(opencodeDialect, stageId, options)
  }
}
