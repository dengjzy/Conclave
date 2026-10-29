import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { DSH_CONFIG_ENV, DSH_PROVIDER_KEY_ENV } from '@conclave/protocol'
import { operationPolicy, runtimeConfig } from './policy'

export default class ConclavePowerShell extends SandboxPwshExecutor {
  private readonly conclave = runtimeConfig()

  override execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = operationPolicy(spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(), spec.workdir, this.conclave, true)
    return super.execute({ ...spec, sandboxPolicy: policy, env: { ...spec.env, [DSH_PROVIDER_KEY_ENV]: '', [DSH_CONFIG_ENV]: '' } })
  }
}
