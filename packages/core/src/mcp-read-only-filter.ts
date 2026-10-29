// Stands between an agent and one of the user's MCP servers for an agent that may only read (a group
// chat member): the tool list keeps only the tools the server marks read-only, and a call to any other
// is answered here without reaching the server. A tool with no annotations counts as one that acts.

type Message = Record<string, unknown>

// JSON-RPC ids are strings or numbers; 1 and '1' are different requests.
const key = (id: unknown) => `${typeof id}:${String(id)}`

const isObject = (value: unknown): value is Message => typeof value === 'object' && value !== null && !Array.isArray(value)

function readOnly(tool: unknown): boolean {
  return isObject(tool) && isObject(tool.annotations) && tool.annotations.readOnlyHint === true
}

export class ReadOnlyToolFilter {
  private readonly listing = new Set<string>()
  private readonly allowed = new Set<string>()

  // A message from the agent: passed on to the server, or answered straight back.
  fromAgent(message: Message): { forward: Message } | { reply: Message } {
    if (message.method === 'tools/list' && message.id !== undefined) this.listing.add(key(message.id))
    if (message.method === 'tools/call' && message.id !== undefined) {
      const name = isObject(message.params) ? message.params.name : undefined
      if (typeof name !== 'string' || !this.allowed.has(name)) {
        return { reply: { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `这里只能用只读工具，${String(name)} 不在其中` } } }
      }
    }
    return { forward: message }
  }

  // A message from the server: a tool list answering the agent loses the tools that act.
  fromServer(message: Message): Message {
    if (message.method !== undefined || message.id === undefined || !this.listing.delete(key(message.id))) return message
    const result = message.result
    if (!isObject(result) || !Array.isArray(result.tools)) return message
    const tools = result.tools.filter(readOnly)
    for (const tool of result.tools) {
      const name = isObject(tool) ? tool.name : undefined
      if (typeof name !== 'string') continue
      if (readOnly(tool)) this.allowed.add(name)
      else this.allowed.delete(name)
    }
    return { ...message, result: { ...result, tools } }
  }
}
