import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult, type ListToolsRequest } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'
import { resolveSecret } from '@/secrets/resolve'

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: unknown
}

export type McpConnection = {
  name: string
  listTools(): Promise<McpToolInfo[]>
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export type McpSdkClient = {
  listTools(params?: ListToolsRequest['params']): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[]
    nextCursor?: string
  }>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>
  close(): Promise<void>
}

export async function connectMcpServer(
  server: McpServer,
  opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<McpConnection> {
  const client = new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
  const transport = server.command
    ? new StdioClientTransport({ command: server.command, args: server.args, env: resolveServerEnv(server, opts.env) })
    : new StreamableHTTPClientTransport(new URL(requiredUrl(server)))

  await client.connect(transport, { signal: opts.signal })

  return createMcpConnection(server.name, {
    listTools: (params) => client.listTools(params),
    async callTool(params) {
      const result = await client.callTool(params, CallToolResultSchema)
      return CallToolResultSchema.parse(result)
    },
    close: () => client.close(),
  })
}

export function createMcpConnection(name: string, client: McpSdkClient): McpConnection {
  let cachedTools: McpToolInfo[] | undefined

  return {
    name,
    async listTools(): Promise<McpToolInfo[]> {
      if (cachedTools !== undefined) return cachedTools

      const tools: McpToolInfo[] = []
      let cursor: string | undefined
      do {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor })
        tools.push(
          ...result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
          })),
        )
        cursor = result.nextCursor
      } while (cursor !== undefined)

      cachedTools = tools
      return cachedTools
    },
    callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      return client.callTool({ name: toolName, arguments: args })
    },
    close(): Promise<void> {
      return client.close()
    },
  }
}

export function resolveServerEnv(server: Pick<McpServer, 'env'>, env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value
  }

  for (const [key, secret] of Object.entries(server.env)) {
    const explicitKeyValue = env[key]
    const resolved =
      explicitKeyValue !== undefined && explicitKeyValue !== '' ? explicitKeyValue : resolveSecret(secret, key, env)
    if (resolved !== undefined) childEnv[key] = resolved
  }

  return childEnv
}

function requiredUrl(server: McpServer): string {
  if (server.url !== undefined) return server.url
  throw new Error(`MCP server "${server.name}" is missing url`)
}
