import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { FsTarget, FsWriteIntent, FsEditRequest, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { operationPolicy, runtimeConfig } from './policy'

export default class ConclaveFileSystem extends SandboxedFileSystem {
  private readonly conclave = runtimeConfig()

  private async policy(target: FsTarget, policy?: SandboxExecutionPolicy): Promise<SandboxExecutionPolicy> {
    const current = await this.resolve(this.processPath(target))
    return operationPolicy(policy ?? this.ctx.sandboxPolicy.resolve(), this.processPath(current), this.conclave)
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.writeText(target, content, expected, signal, await this.policy(target, policy))
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy) {
    return super.editText(target, edit, expected, signal, await this.policy(target, policy))
  }
}
