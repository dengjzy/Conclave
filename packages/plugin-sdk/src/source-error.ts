import type { SourceFailure, SourceProblem } from '../../protocol/src/source.js'

export class SourceError extends Error {
  constructor(readonly code: SourceFailure, message: string) {
    super(message)
    this.name = 'SourceError'
  }
}

export function sourceProblem(error: unknown): SourceProblem {
  if (error instanceof SourceError) return { code: error.code, message: error.message }
  // Validation and transport errors may contain credentials or upstream response bodies.
  return { code: 'request-failed', message: '插件请求失败，请检查插件配置或重试' }
}
