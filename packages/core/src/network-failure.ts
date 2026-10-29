import { currentProxyFor } from './system-proxy'

// Node's fetch says only "fetch failed"; what went wrong is a code on its cause, a level or two down.
const REASONS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  ETIMEDOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应超时',
  UND_ERR_BODY_TIMEOUT: '下载中途超时',
  ECONNRESET: '连接被中断',
  UND_ERR_SOCKET: '连接被中断',
  EPIPE: '连接被中断',
  ECONNREFUSED: '连接被拒绝',
  ENOTFOUND: '找不到这个地址',
  EAI_AGAIN: '域名解析失败',
  ENETUNREACH: '网络不可达',
  EHOSTUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: '证书校验失败，可能被代理或安全软件拦截',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败，可能被代理或安全软件拦截',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '证书校验失败，可能被代理或安全软件拦截',
  SELF_SIGNED_CERT_IN_CHAIN: '证书校验失败，可能被代理或安全软件拦截',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书校验失败，可能被代理或安全软件拦截'
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '等待超时'
  let cause: unknown = error
  let message: string | null = null
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth++) {
    if ('code' in cause && typeof cause.code === 'string' && REASONS[cause.code]) return REASONS[cause.code] ?? ''
    if (cause instanceof Error && cause.message && cause.message !== 'fetch failed') message = cause.message
    cause = 'cause' in cause ? cause.cause : null
  }
  return message ?? '网络错误'
}

// A request to `url` that never got an answer, as an error saying where it went, through which
// proxy, why, and what to try.
export function networkFailure(url: string, error: unknown): Error {
  let host = url
  try { host = new URL(url).host } catch { /* Keep the text as given. */ }
  const proxy = currentProxyFor(url)
  let via = ''
  if (proxy) {
    try { via = `（经代理 ${new URL(proxy).host}）` } catch { via = '（经代理）' }
  }
  return new Error(`连不上 ${host}${via}：${reasonOf(error)}。换个网络或开关 VPN 后重试`, { cause: error })
}
