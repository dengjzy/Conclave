import { CoreEndpoint, PROTOCOL_VERSION } from '@conclave/protocol'

// Inside Electron the preload bridge reads core.json; in a plain browser
// (Conclave web client) the endpoint comes from ?port=&token=, localStorage, or same-origin HTTP.
export async function resolveCoreEndpoint(): Promise<CoreEndpoint | null> {
  if (window.conclave) {
    const parsed = CoreEndpoint.nullable().safeParse(await window.conclave.getCoreEndpoint())
    if (parsed.success && parsed.data) return parsed.data
  }

  const query = new URLSearchParams(window.location.search)
  const queryPort = query.get('port')
  const queryToken = query.get('token')

  if (queryToken) {
    try {
      localStorage.setItem('conclave_token', queryToken)
      if (queryPort) localStorage.setItem('conclave_port', queryPort)
      const cleanUrl = new URL(window.location.href)
      cleanUrl.searchParams.delete('token')
      cleanUrl.searchParams.delete('port')
      window.history.replaceState({}, document.title, cleanUrl.toString())
    } catch {}
  }

  // 1. Try to fetch /api/auth/session from current origin
  try {
    const res = await fetch('/api/auth/session')
    if (res.ok) {
      const data = await res.json()
      if (data && data.token) {
        try {
          localStorage.setItem('conclave_token', data.token)
        } catch {}
        const hostPort = window.location.port ? Number(window.location.port) : 43551
        return { port: hostPort, token: data.token, pid: 0, protocolVersion: PROTOCOL_VERSION }
      }
    }
  } catch {}

  const savedToken = queryToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('conclave_token') : null)
  const hostPort = window.location.port ? Number(window.location.port) : 43551
  const port = queryPort ? Number(queryPort) : (typeof localStorage !== 'undefined' && localStorage.getItem('conclave_port') ? Number(localStorage.getItem('conclave_port')) : hostPort)

  if (savedToken && port) {
    return { port, token: savedToken, pid: 0, protocolVersion: PROTOCOL_VERSION }
  }

  const entered = window.prompt('请输入 Conclave 核心通信 Token (在终端启动日志中打印的 token):')
  if (entered && entered.trim()) {
    const token = entered.trim()
    try {
      localStorage.setItem('conclave_token', token)
    } catch {}
    return { port: port || 43551, token, pid: 0, protocolVersion: PROTOCOL_VERSION }
  }

  return null
}
