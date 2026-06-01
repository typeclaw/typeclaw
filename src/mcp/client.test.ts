import { describe, expect, test } from 'bun:test'

import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'

import { connectMcpServer, createMcpConnection, resolveServerEnv, type McpSdkClient } from './client'

describe('resolveServerEnv', () => {
  test('uses target env key before explicit secret env before secret value', () => {
    const server: Pick<McpServer, 'env'> = {
      env: {
        TARGET_TOKEN: { env: 'SOURCE_TOKEN', value: 'from-file' },
        SOURCE_ONLY: { env: 'SOURCE_ONLY_ENV', value: 'from-file-source' },
        FILE_ONLY: { value: 'from-file-only' },
      },
    }

    const resolved = resolveServerEnv(server, {
      TARGET_TOKEN: 'from-target-env',
      SOURCE_TOKEN: 'from-source-env',
      SOURCE_ONLY_ENV: 'from-source-only-env',
      PASSTHROUGH: 'kept',
    })

    expect(resolved.TARGET_TOKEN).toBe('from-target-env')
    expect(resolved.SOURCE_ONLY).toBe('from-source-only-env')
    expect(resolved.FILE_ONLY).toBe('from-file-only')
    expect(resolved.PASSTHROUGH).toBe('kept')
  })
})

describe('McpConnection', () => {
  test('caches listed tools after the first catalog load', async () => {
    let listCalls = 0
    const callResult: CallToolResult = { content: [{ type: 'text', text: 'ok' }] }
    const client: McpSdkClient = {
      async listTools(_params, _options) {
        listCalls += 1
        return { tools: [{ name: 'first', inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, _options) {
        return callResult
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client)

    const first = await connection.listTools()
    const second = await connection.listTools()

    expect(first).toEqual([{ name: 'first', description: '', inputSchema: { type: 'object' } }])
    expect(second).toBe(first)
    expect(listCalls).toBe(1)
  })

  test('refresh clears the cached catalog before fetching again', async () => {
    let listCalls = 0
    const client: McpSdkClient = {
      async listTools(_params, _options) {
        listCalls += 1
        return { tools: [{ name: `tool-${listCalls}`, inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, _options) {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client)

    const first = await connection.listTools()
    const refreshed = await connection.refresh()
    const afterRefresh = await connection.listTools()

    expect(first[0]?.name).toBe('tool-1')
    expect(refreshed[0]?.name).toBe('tool-2')
    expect(afterRefresh).toBe(refreshed)
    expect(listCalls).toBe(2)
  })

  test('forwards explicit request timeouts to listTools and callTool', async () => {
    const options: RequestOptions[] = []
    const client: McpSdkClient = {
      async listTools(_params, option) {
        if (option !== undefined) options.push(option)
        return { tools: [{ name: 'first', inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, option) {
        if (option !== undefined) options.push(option)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client, { timeoutMs: 123 })

    await connection.listTools()
    await connection.callTool('first')

    expect(options.map((option) => option.timeout)).toEqual([123, 123])
  })
})

describe('connectMcpServer', () => {
  test('rejects when client.connect does not settle before the connect deadline', async () => {
    let closeCalls = 0
    const client = fakeConnectClient({
      async connect(_transport, options) {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      },
      async close() {
        closeCalls += 1
      },
    })

    await expect(
      connectMcpServer(server(), { env: {}, client, transport: fakeTransport(), connectTimeoutMs: 20 }),
    ).rejects.toThrow(/connect timeout/)
    expect(closeCalls).toBe(1)
  })

  test('closes a partially-started client and preserves the original connect error', async () => {
    const connectError = new Error('initialize failed')
    let closeCalls = 0
    const client = fakeConnectClient({
      async connect() {
        throw connectError
      },
      async close() {
        closeCalls += 1
      },
    })

    await expect(
      connectMcpServer(server(), { env: {}, client, transport: fakeTransport(), connectTimeoutMs: 20 }),
    ).rejects.toBe(connectError)
    expect(closeCalls).toBe(1)
  })
})

function server(timeoutMs?: number): McpServer {
  return {
    name: 'server',
    enabled: true,
    command: 'server-command',
    args: [],
    env: {},
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function fakeTransport(): Transport {
  return {
    async start() {},
    async send(_message, _options) {},
    async close() {},
  }
}

function fakeConnectClient(overrides: {
  connect(transport: Transport, options?: RequestOptions): Promise<void>
  close(): Promise<void>
}): McpSdkClient & { connect(transport: Transport, options?: RequestOptions): Promise<void> } {
  return {
    async listTools(_params, _options) {
      return { tools: [] }
    },
    async callTool(_params, _resultSchema, _options) {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    connect: overrides.connect,
    close: overrides.close,
  }
}
