import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { buildMcpDispatcherToolDefinitions } from '@/agent'
import { wrapSystemTool } from '@/agent/plugin-tools'
import { enforceAndPinToolFiles } from '@/agent/tool-file-safety'
import { createHookBus } from '@/plugin'
import type { ToolContext } from '@/plugin/types'

import type { McpConnection, McpToolInfo } from './client'
import type { McpManager } from './manager'
import {
  createMcpDispatcherTools,
  sanitizeMcpError,
  type McpCallArgs,
  type McpDescribeArgs,
  type McpListToolsArgs,
} from './tools'

describe('createMcpDispatcherTools', () => {
  test('mcp_list_tools returns namespaced tool names and descriptions', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [
        { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
        { name: 'write', description: '', inputSchema: { type: 'object' } },
      ]),
    })
    const [listTools] = createMcpDispatcherTools(manager)

    const result = await listTools.execute({ server: 'files' } satisfies McpListToolsArgs, toolContext())

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Tools for MCP server "files":\n- files__read — Read a file\n- files__write — no description',
      },
    ])
  })

  test('mcp_list_tools reports unknown servers with available server names', async () => {
    const manager = fakeManager({ files: fakeConnection('files', []) })
    const [listTools] = createMcpDispatcherTools(manager)

    const result = await listTools.execute({ server: 'missing' } satisfies McpListToolsArgs, toolContext())

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Unknown MCP server "missing". Available servers: files.',
    })
  })

  test('mcp_describe returns inputSchema JSON for bare and namespaced tool ids', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ]),
    })
    const [, describeTool] = createMcpDispatcherTools(manager)

    const bare = await describeTool.execute({ server: 'files', tool: 'read' } satisfies McpDescribeArgs, toolContext())
    const namespaced = await describeTool.execute(
      { server: 'ignored', tool: 'files__read' } satisfies McpDescribeArgs,
      toolContext(),
    )

    const text = expectText(bare.content[0])
    expect(text).toContain('MCP tool files__read')
    expect(text).toContain('Description: Read a file')
    expect(text).toContain('"path": {')
    expect(namespaced).toEqual(bare)
  })

  test('mcp_call maps text results and includes call details', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], { content: [{ type: 'text', text: 'file contents' }] }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute(
      { server: 'files', tool: 'read', args: { id: 'readme-id' } } satisfies McpCallArgs,
      toolContext(),
    )

    expect(result).toEqual({
      content: [{ type: 'text', text: 'file contents' }],
      details: { server: 'files', tool: 'read', isError: false },
    })
  })

  test('mcp_call blocks nested file URLs before invoking the external server', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-file-boundary-'))
    await writeFile(path.join(agentDir, 'secrets.json'), '{"secret":true}')
    let called = false
    const connection = fakeConnection('files', [])
    connection.callTool = async () => {
      called = true
      return { content: [{ type: 'text', text: 'leaked' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    try {
      await expect(
        callTool.execute(
          {
            server: 'files',
            tool: 'read',
            args: { nested: { url: pathToFileURL(path.join(agentDir, 'secrets.json')).href } },
          } satisfies McpCallArgs,
          toolContext(agentDir),
        ),
      ).rejects.toThrow(/not available to LLM tools/)
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('mcp_call passes an immutable pinned copy for an authorized file URL', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-pinned-file-'))
    const safe = path.join(agentDir, 'safe.txt')
    const replacement = path.join(agentDir, 'replacement.txt')
    await writeFile(safe, 'safe')
    await writeFile(replacement, 'replacement')
    const connection = fakeConnection('files', [])
    connection.callTool = async (_tool, args) => {
      await rm(safe)
      await symlink(replacement, safe)
      const url = (args as { nested: { url: string } }).nested.url
      return { content: [{ type: 'text', text: await readFile(new URL(url), 'utf8') }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    try {
      const result = await callTool.execute(
        {
          server: 'files',
          tool: 'read',
          args: { nested: { url: pathToFileURL(safe).href } },
        } satisfies McpCallArgs,
        toolContext(agentDir),
      )
      expect(result.content).toEqual([{ type: 'text', text: 'safe' }])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'an MCP mixed file contract snapshots its input while anchoring its output',
    async () => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-mixed-files-'))
      const source = path.join(agentDir, 'source.txt')
      const secret = path.join(agentDir, '.env')
      const destination = path.join(agentDir, 'result.txt')
      await writeFile(source, 'safe input')
      await writeFile(secret, 'SECRET=never')
      const args: Record<string, unknown> = { source: pathToFileURL(source).href, destination }

      try {
        const pinned = await enforceAndPinToolFiles({
          tool: 'mcp_call',
          args,
          agentDir,
          genericInputs: true,
          fileOperands: { input: ['source'], output: ['destination'] },
        })
        try {
          await rm(source)
          await symlink(secret, source)
          const content = await readFile(new URL(args.source as string), 'utf8')
          await writeFile(args.destination as string, content)
          const restored = pinned.restoreResult({
            content: [{ type: 'text', text: `${String(args.source)}\n${String(args.destination)}` }],
          })

          expect(await readFile(destination, 'utf8')).toBe('safe input')
          expect(await readFile(secret, 'utf8')).toBe('SECRET=never')
          expect(expectText(restored.content[0])).toBe(`${pathToFileURL(source).href}\n${destination}`)
        } finally {
          await pinned.cleanup()
        }
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('mcp_call rejects an undeclared absolute path-like operand before invoking the server', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-absolute-pin-'))
    const safe = path.join(agentDir, 'safe.txt')
    await writeFile(safe, 'safe')
    let called = false
    const connection = fakeConnection('files', [])
    connection.callTool = async () => {
      called = true
      return { content: [{ type: 'text', text: 'unexpected' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    try {
      await expect(
        callTool.execute({ server: 'files', tool: 'read', args: { inputPath: safe } }, toolContext(agentDir)),
      ).rejects.toThrow(/ambiguous.*fileOperands\.input.*file:/i)
      expect(called).toBeFalse()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('mcp_call leaves clear remote and control strings unchanged', async () => {
    const connection = fakeConnection('files', [])
    let received: Record<string, unknown> | undefined
    connection.callTool = async (_tool, args) => {
      received = args
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    const args = {
      path: '/v1/repos',
      repository: 'acme/widgets',
      url: 'https://example.com/v1/items',
      date: '7/16',
      fraction: '2/3',
      packageName: '@scope/widgets',
      packageCoordinate: 'com.example:widgets:1.2.3',
    }
    await callTool.execute({ server: 'files', tool: 'repository_status', args }, toolContext())
    expect(received).toEqual(args)
  })

  test('mcp_call honors the target tool\'s declared fileOperands.nonFile operands', async () => {
    let received: Record<string, unknown> | undefined
    const connection = fakeConnection('search', [
      {
        name: 'search_web',
        description: 'Web search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        fileOperands: { nonFile: ['query'] },
      },
    ])
    connection.callTool = async (_tool, args) => {
      received = args
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ search: connection }))
    await callTool.execute(
      { server: 'search', tool: 'search_web', args: { query: 'SPPN 3/2017' } },
      toolContext(),
    )
    expect(received).toEqual({ query: 'SPPN 3/2017' })
  })

  test.each(['/v1/../../tmp/result.txt', '/v1/%2e%2e/tmp/result.txt', '/v1\\..\\tmp', '/v1//repos'])(
    'mcp_call rejects traversal-shaped API route %s before invoking the server',
    async (route) => {
      let called = false
      const connection = fakeConnection('files', [])
      connection.callTool = async () => {
        called = true
        return { content: [{ type: 'text', text: 'unexpected' }] }
      }
      const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
      await expect(
        callTool.execute({ server: 'files', tool: 'request', args: { path: route } }, toolContext()),
      ).rejects.toThrow(/ambiguous local file operand/i)
      expect(called).toBeFalse()
    },
  )

  test('mcp_call rejects undeclared scalar array paths and non-file-key local paths before dispatch', async () => {
    let called = false
    const connection = fakeConnection('files', [])
    connection.callTool = async () => {
      called = true
      return { content: [{ type: 'text', text: 'unexpected' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    for (const args of [{ files: ['workspace/missing.txt'] }, { value: 'workspace/missing.txt' }]) {
      await expect(callTool.execute({ server: 'files', tool: 'read', args }, toolContext())).rejects.toThrow(
        /ambiguous local file operand/i,
      )
    }
    expect(called).toBeFalse()
  })

  test.each([
    ['outputPath', 'result.txt'],
    ['filename', 'result.txt'],
    ['value', 'C:\\temp\\result.txt'],
    ['value', '\\\\server\\share\\result.txt'],
  ])('mcp_call rejects undeclared nonexistent local operand %s=%s', async (key, value) => {
    let called = false
    const connection = fakeConnection('files', [])
    connection.callTool = async () => {
      called = true
      return { content: [{ type: 'text', text: 'unexpected' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    await expect(
      callTool.execute({ server: 'files', tool: 'write', args: { [key]: value } }, toolContext()),
    ).rejects.toThrow(/ambiguous local file operand/i)
    expect(called).toBeFalse()
  })

  test('mcp_call pins an explicit file URI supplied as a scalar array element', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-array-file-'))
    const safe = path.join(agentDir, 'safe.txt')
    const replacement = path.join(agentDir, 'replacement.txt')
    await writeFile(safe, 'safe')
    await writeFile(replacement, 'replacement')
    const connection = fakeConnection('files', [])
    connection.callTool = async (_tool, args) => {
      await rm(safe)
      await symlink(replacement, safe)
      const [url] = (args as { files: string[] }).files
      return { content: [{ type: 'text', text: await readFile(new URL(url as string), 'utf8') }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    try {
      const result = await callTool.execute(
        { server: 'files', tool: 'read', args: { files: [pathToFileURL(safe).href] } },
        toolContext(agentDir),
      )
      expect(result.content).toEqual([{ type: 'text', text: 'safe' }])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('mcp_call rejects undeclared existing local operands with metadata guidance', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-ambiguous-local-'))
    const local = path.join(agentDir, 'input.txt')
    await writeFile(local, 'safe')
    let called = false
    const connection = fakeConnection('files', [])
    connection.callTool = async () => {
      called = true
      return { content: [{ type: 'text', text: 'unexpected' }] }
    }
    const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
    const warnings: string[] = []
    try {
      for (const value of [local, './input.txt', 'input.txt']) {
        await expect(
          callTool.execute(
            { server: 'files', tool: 'read', args: { filename: value } } satisfies McpCallArgs,
            toolContext(agentDir, warnings),
          ),
        ).rejects.toThrow(/ambiguous.*fileOperands\.input.*file:/i)
      }
      expect(called).toBeFalse()
      expect(warnings).toHaveLength(3)
      expect(warnings.every((warning) => /fileOperands\.input|existing local/i.test(warning))).toBeTrue()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test.each(['secrets.json', 'workspace/.agent-messenger/credentials.json'])(
    'mcp_call always denies canonical secret operand %s',
    async (value) => {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-canonical-filename-'))
      let called = false
      const connection = fakeConnection('files', [])
      connection.callTool = async () => {
        called = true
        return { content: [{ type: 'text', text: 'unexpected' }] }
      }
      const [, , callTool] = createMcpDispatcherTools(fakeManager({ files: connection }))
      try {
        await expect(
          callTool.execute(
            { server: 'files', tool: 'inspect', args: { filename: value } } satisfies McpCallArgs,
            toolContext(agentDir),
          ),
        ).rejects.toThrow(/not available|canonical|ambiguous/i)
        expect(called).toBeFalse()
      } finally {
        await rm(agentDir, { recursive: true, force: true })
      }
    },
  )

  test('production system wrapper pins a 52 MiB MCP file exactly once without self-deadlock', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-mcp-single-pin-'))
    const input = path.join(agentDir, 'large.bin')
    await writeFile(input, '')
    await truncate(input, 52 * 1024 * 1024)
    const connection = fakeConnection('files', [])
    connection.callTool = async (_tool, args) => {
      const url = (args as { input: { url: string } }).input.url
      const bytes = await readFile(new URL(url))
      return { content: [{ type: 'text', text: String(bytes.byteLength) }] }
    }
    const manager = fakeManager({ files: connection })
    const definition = buildMcpDispatcherToolDefinitions(manager)[2]
    if (definition === undefined) throw new Error('mcp_call definition missing')
    const wrapped = wrapSystemTool(definition, {
      agentDir,
      sessionId: 'mcp-single-pin',
      hooks: createHookBus(),
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('MCP pinning timed out'), 20_000)
    try {
      const result = await wrapped.execute(
        'c',
        { server: 'files', tool: 'read_large', args: { input: { url: pathToFileURL(input).href } } },
        controller.signal,
        undefined,
        {} as never,
      )
      expect(expectText(result.content[0])).toBe(String(52 * 1024 * 1024))
    } finally {
      clearTimeout(timer)
      await rm(agentDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('mcp_call preserves text and image content together', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], {
        content: [
          { type: 'text', text: 'caption' },
          { type: 'image', mimeType: 'image/png', data: 'base64-image' },
        ],
      }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute({ server: 'files', tool: 'screenshot' } satisfies McpCallArgs, toolContext())

    expect(result.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', mimeType: 'image/png', data: 'base64-image' },
    ])
  })

  test('mcp_call emits summaries for unrepresentable embedded resources', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], {
        content: [
          { type: 'resource', resource: { uri: 'file:///report.pdf', mimeType: 'application/pdf', text: 'pdf' } },
        ],
      }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute({ server: 'files', tool: 'read' } satisfies McpCallArgs, toolContext())

    expect(result.content).toEqual([{ type: 'text', text: '[mcp:resource file:///report.pdf]' }])
  })

  test('mcp_call surfaces SDK error results as text instead of throwing', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], { content: [{ type: 'text', text: 'permission denied' }], isError: true }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute({ server: 'files', tool: 'read' } satisfies McpCallArgs, toolContext())

    expect(result).toEqual({
      content: [{ type: 'text', text: 'MCP tool error: permission denied' }],
      details: { server: 'files', tool: 'read', isError: true },
    })
  })

  test('mcp_call sanitizes SDK error result text before surfacing it', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], {
        content: [{ type: 'text', text: 'failed at /private/tmp/secret.txt with API_KEY=shh' }],
        isError: true,
      }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute({ server: 'files', tool: 'read' } satisfies McpCallArgs, toolContext())

    expect(result.content).toEqual([{ type: 'text', text: 'MCP tool error: failed at <path> with API_KEY=<redacted>' }])
  })
})

describe('sanitizeMcpError', () => {
  test('leaves normal short messages intact', () => {
    expect(sanitizeMcpError('permission denied')).toBe('permission denied')
  })

  test('truncates long messages', () => {
    expect(sanitizeMcpError('x'.repeat(600))).toHaveLength(500)
    expect(sanitizeMcpError('x'.repeat(600))).toEndWith('...')
  })

  test('redacts absolute paths and env-style assignments', () => {
    expect(sanitizeMcpError('failed at /tmp/agent/secrets.txt with TOKEN=secret')).toBe(
      'failed at <path> with TOKEN=<redacted>',
    )
    expect(sanitizeMcpError('failed at C:\\agent\\secrets.txt')).toBe('failed at <path>')
  })
})

function fakeManager(connections: Record<string, McpConnection>): McpManager {
  return {
    async connectAll() {
      return Object.entries(connections).map(([name, connection]) => ({
        ok: true as const,
        name,
        connection,
        toolCount: 0,
      }))
    },
    async ensureConnected(name) {
      return connections[name]
    },
    async whenInitialConnectSettled() {},
    getConnection(name) {
      return connections[name]
    },
    listServers() {
      return Object.keys(connections).map((name) => ({ name, connected: true, toolCount: 0 }))
    },
    async refresh() {
      return Object.keys(connections).map((name) => ({ ok: true as const, name, toolCount: 0 }))
    },
    async closeAll() {},
  }
}

function fakeConnection(name: string, tools: McpToolInfo[], result?: CallToolResult): McpConnection {
  return {
    name,
    async listTools() {
      return tools
    },
    async refresh() {
      return tools
    },
    async callTool() {
      return result ?? { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}

function toolContext(agentDir = '/agent', warnings: string[] = []): ToolContext {
  return {
    signal: undefined,
    sessionId: 'ses_test',
    agentDir,
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
  }
}

function expectText(
  part: { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string } | undefined,
): string {
  expect(part?.type).toBe('text')
  if (part?.type !== 'text') throw new Error('expected text content')
  return part.text
}
