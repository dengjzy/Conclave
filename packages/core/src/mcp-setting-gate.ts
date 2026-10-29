import type { RpcConnection } from '@conclave/protocol'

// Tools the user can turn off in settings. An agent keeps the tools it started with, so turning one
// off mid-conversation would hold only from its next start; each call asks core first instead.
type Gated = 'userTodos' | 'readHistory'

const REFUSAL: Record<Gated, string> = {
  userTodos: '用户已在设置里关闭了待办：不要再查看、记录或勾选待办，要用户之后做的事在回复里说明即可。',
  readHistory: '用户已在设置里关闭了读取 Conclave 记录：不要再调用这些工具。'
}

// The refusal to answer with when the user has turned the setting off, else null. A core that cannot
// say leaves the tools as they started.
export async function turnedOff(rpc: Pick<RpcConnection, 'call'>, setting: Gated): Promise<string | null> {
  const settings = await rpc.call('system.chatSettings', {}).catch(() => null)
  return settings?.[setting] === false ? REFUSAL[setting] : null
}
