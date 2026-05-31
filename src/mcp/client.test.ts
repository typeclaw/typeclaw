import { describe, expect, test } from 'bun:test'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'

import { createMcpConnection, resolveServerEnv, type McpSdkClient } from './client'

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
      async listTools() {
        listCalls += 1
        return { tools: [{ name: 'first', inputSchema: { type: 'object' } }] }
      },
      async callTool() {
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
})
