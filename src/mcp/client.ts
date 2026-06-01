import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, type CallToolResult, type ListToolsRequest } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'
import { resolveSecret } from '@/secrets/resolve'

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: unknown
}

// The SDK defaults each request to 60s; typeclaw boot should fail fast enough
// that one dead MCP server does not make the agent feel hung at startup.
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000

export type McpConnection = {
  name: string
  listTools(): Promise<McpToolInfo[]>
  refresh(): Promise<McpToolInfo[]>
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export type McpSdkClient = {
  listTools(
    params?: ListToolsRequest['params'],
    options?: RequestOptions,
  ): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[]
    nextCursor?: string
  }>
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: typeof CallToolResultSchema,
    options?: RequestOptions,
  ): Promise<CallToolResult>
  close(): Promise<void>
}

type McpConnectClient = McpSdkClient & {
  connect(transport: Transport, options?: RequestOptions): Promise<void>
}

export async function connectMcpServer(
  server: McpServer,
  opts: {
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    connectTimeoutMs?: number
    client?: McpConnectClient
    transport?: Transport
  },
): Promise<McpConnection> {
  const requestTimeout = server.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS
  const connectTimeout = opts.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
  const client = opts.client ?? new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
  const transport = opts.transport ?? createTransport(server, opts.env)

  try {
    await withConnectDeadline(connectTimeout, opts.signal, (signal) =>
      client.connect(transport, { signal, timeout: requestTimeout }),
    )
  } catch (cause) {
    try {
      await client.close()
    } catch (closeCause) {
      attachCloseCause(cause, closeCause)
    }
    throw cause
  }

  return createMcpConnection(
    server.name,
    {
      listTools: (params, options) => client.listTools(params, options),
      async callTool(params, _resultSchema, options) {
        const result = await client.callTool(params, CallToolResultSchema, options)
        return CallToolResultSchema.parse(result)
      },
      close: () => client.close(),
    },
    { timeoutMs: requestTimeout },
  )
}

export function createMcpConnection(
  name: string,
  client: McpSdkClient,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): McpConnection {
  let cachedTools: McpToolInfo[] | undefined
  const timeout = opts.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS

  async function fetchTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout,
        signal: opts.signal,
      })
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
  }

  return {
    name,
    async listTools(): Promise<McpToolInfo[]> {
      if (cachedTools !== undefined) return cachedTools
      return fetchTools()
    },
    refresh(): Promise<McpToolInfo[]> {
      cachedTools = undefined
      return fetchTools()
    },
    callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      return client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
        timeout,
        signal: opts.signal,
      })
    },
    close(): Promise<void> {
      return client.close()
    },
  }
}

function createTransport(server: McpServer, env: NodeJS.ProcessEnv): Transport {
  return server.command
    ? new StdioClientTransport({ command: server.command, args: server.args, env: resolveServerEnv(server, env) })
    : new StreamableHTTPClientTransport(new URL(requiredUrl(server)))
}

async function withConnectDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('MCP connect timeout')), timeoutMs)
  const merged = mergeSignals(parentSignal, deadline.signal)
  const operation = fn(merged.signal)
  let removeAbortListener = (): void => {}
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(merged.signal.reason)
    removeAbortListener = (): void => merged.signal.removeEventListener('abort', onAbort)
    if (merged.signal.aborted) onAbort()
    else merged.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, abort])
  } finally {
    clearTimeout(timer)
    removeAbortListener()
    if (merged.signal.aborted) void operation.catch(() => undefined)
    merged.dispose()
  }
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (activeSignals.length === 0) return { signal: new AbortController().signal, dispose() {} }
  if (activeSignals.length === 1) return { signal: activeSignals[0]!, dispose() {} }

  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of activeSignals) {
    const abort = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const remove of listeners) remove()
    },
  }
}

function attachCloseCause(cause: unknown, closeCause: unknown): void {
  if (!(cause instanceof Error)) return
  const error = cause as Error & { cause?: unknown }
  error.cause = { original: error.cause, close: closeCause }
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
