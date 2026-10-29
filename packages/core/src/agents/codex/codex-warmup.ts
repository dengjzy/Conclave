import { z } from 'zod'

// An empty mcp_servers table merges with the user's table; disable each entry explicitly.
export function codexWarmupArgs(printed: string): string[] {
  const servers = z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/) })).parse(JSON.parse(printed))
  return servers.flatMap((server) => ['-c', `mcp_servers.${server.name}.enabled=false`])
}
