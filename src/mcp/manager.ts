import type { McpServer } from '@/config/config'

import { connectMcpServer, type McpConnection } from './client'

const TOOL_NAMESPACE_SEPARATOR = '__'

export type McpConnectResult =
  | { ok: true; name: string; connection: McpConnection; toolCount: number }
  | { ok: false; name: string; error: Error }

export type McpManager = {
  connectAll(): Promise<McpConnectResult[]>
  getConnection(name: string): McpConnection | undefined
  listServers(): { name: string; description?: string; connected: boolean; toolCount?: number }[]
  closeAll(): Promise<void>
}

export type ConnectMcpServerFn = (server: McpServer, opts: { env: NodeJS.ProcessEnv }) => Promise<McpConnection>

export function createMcpManager(
  servers: McpServer[],
  opts: { env: NodeJS.ProcessEnv; connect?: ConnectMcpServerFn },
): McpManager {
  const connect = opts.connect ?? connectMcpServer
  const connections = new Map<string, McpConnection>()
  const toolCounts = new Map<string, number>()

  return {
    async connectAll(): Promise<McpConnectResult[]> {
      const results = await Promise.all(servers.map((server) => connectOne(server, opts.env, connect)))
      for (const result of results) {
        if (!result.ok) continue
        connections.set(result.name, result.connection)
        toolCounts.set(result.name, result.toolCount)
      }
      return results
    },
    getConnection(name: string): McpConnection | undefined {
      return connections.get(name)
    },
    listServers(): { name: string; description?: string; connected: boolean; toolCount?: number }[] {
      return servers.map((server) => {
        const toolCount = toolCounts.get(server.name)
        return {
          name: server.name,
          connected: connections.has(server.name),
          ...(toolCount === undefined ? {} : { toolCount }),
        }
      })
    },
    async closeAll(): Promise<void> {
      await Promise.allSettled([...connections.values()].map((connection) => connection.close()))
      connections.clear()
      toolCounts.clear()
    },
  }
}

export function namespaceToolName(server: string, tool: string): string {
  return `${server}${TOOL_NAMESPACE_SEPARATOR}${tool}`
}

export function parseNamespacedTool(namespaced: string): { server: string; tool: string } | undefined {
  const separatorIndex = namespaced.indexOf(TOOL_NAMESPACE_SEPARATOR)
  if (separatorIndex <= 0) return undefined

  const toolStart = separatorIndex + TOOL_NAMESPACE_SEPARATOR.length
  if (toolStart >= namespaced.length) return undefined

  return { server: namespaced.slice(0, separatorIndex), tool: namespaced.slice(toolStart) }
}

async function connectOne(
  server: McpServer,
  env: NodeJS.ProcessEnv,
  connect: ConnectMcpServerFn,
): Promise<McpConnectResult> {
  let connection: McpConnection | undefined
  try {
    connection = await connect(server, { env })
    const tools = await connection.listTools()
    return { ok: true, name: server.name, connection, toolCount: tools.length }
  } catch (cause) {
    const closeError = connection === undefined ? undefined : await closeAfterFailedCatalog(connection)
    if (closeError !== undefined) {
      return {
        ok: false,
        name: server.name,
        error: new Error(`MCP server "${server.name}" failed to connect and then failed to close`, {
          cause: { original: cause, close: closeError },
        }),
      }
    }
    return { ok: false, name: server.name, error: normalizeError(cause) }
  }
}

async function closeAfterFailedCatalog(connection: McpConnection): Promise<Error | undefined> {
  try {
    await connection.close()
    return undefined
  } catch (cause) {
    return normalizeError(cause)
  }
}

function normalizeError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  return new Error(String(cause))
}
