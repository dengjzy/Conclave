// The client side of MCP's streamable HTTP transport: each JSON-RPC message is POSTed to the
// server's one address, and what comes back, a JSON body or an event stream, is the server's
// messages. The session the server names at initialize goes on every later request.

const SESSION_HEADER = 'mcp-session-id'
const VERSION_HEADER = 'mcp-protocol-version'

type Message = Record<string, unknown>

const isRequest = (message: Message) => typeof message.method === 'string' && message.id !== undefined

export class McpHttpSession {
  private session: string | null = null
  private version: string | null = null

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  // Sends one message, handing each message the server answers with to `received`; resolves once
  // the server has said all it will for it. A request the server fails is answered with an error
  // here, so whoever sent it is not left waiting.
  async send(message: Message, received: (message: Message) => void, signal?: AbortSignal): Promise<void> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.requestHeaders({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        body: JSON.stringify(message),
        ...(signal ? { signal } : {})
      })
    } catch (error) {
      if (isRequest(message)) received(failure(message, `连不上 ${this.url}：${reason(error)}`))
      throw error
    }
    const session = response.headers.get(SESSION_HEADER)
    if (session) this.session = session
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 500)
      const error = new Error(`HTTP ${response.status}${text ? `：${text}` : ''}`)
      if (isRequest(message)) received(failure(message, error.message))
      throw error
    }
    const take = (reply: Message) => {
      // Later requests state the revision the server agreed to.
      const result = reply.result
      if (message.method === 'initialize' && result && typeof result === 'object' && 'protocolVersion' in result && typeof result.protocolVersion === 'string') {
        this.version = result.protocolVersion
      }
      received(reply)
    }
    const type = response.headers.get('content-type') ?? ''
    if (response.status === 202 || !response.body) return
    if (type.includes('text/event-stream')) {
      for await (const data of events(response.body)) {
        const parsed = parseMessage(data)
        if (parsed) take(parsed)
      }
      return
    }
    const text = await response.text()
    if (!text.trim()) return
    const body: unknown = JSON.parse(text)
    for (const reply of Array.isArray(body) ? body : [body]) {
      if (reply && typeof reply === 'object') take(reply)
    }
  }

  // Ends the session on the server, where it keeps one; a server that does not answers 405.
  async close(): Promise<void> {
    if (!this.session) return
    await this.fetchImpl(this.url, { method: 'DELETE', headers: this.requestHeaders({}) }).catch(() => {})
  }

  private requestHeaders(base: Record<string, string>): Record<string, string> {
    return {
      ...this.headers,
      ...base,
      ...(this.session ? { [SESSION_HEADER]: this.session } : {}),
      ...(this.version ? { [VERSION_HEADER]: this.version } : {})
    }
  }
}

function failure(request: Message, text: string): Message {
  return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: text } }
}

function reason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : ''
  return `${error instanceof Error ? error.message : String(error)}${cause}`
}

function parseMessage(text: string): Message | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null
  } catch {
    return null
  }
}

// The data of each server-sent event: its `data:` lines joined, an event being ended by a blank line.
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        if (data.length) yield data.join('\n')
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''))
      }
      newline = buffer.indexOf('\n')
    }
  }
  if (data.length) yield data.join('\n')
}
