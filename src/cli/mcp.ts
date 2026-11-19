import { join } from 'node:path'

import { isCancel, log, note, text } from '@clack/prompts'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineCommand } from 'citty'

import { loadConfigSync } from '@/config'
import { findAgentDir, isInitialized } from '@/init'
import { createFileMcpOAuthStore, TypeClawMcpOAuthProvider, listMcpCredentials } from '@/mcp'
import { SecretsBackend } from '@/secrets'

import { openBrowserBestEffort } from './open-browser'
import { c, done, errorLine } from './ui'

const DEFAULT_CALLBACK_PORT = 1456

const authSub = defineCommand({
  meta: {
    name: 'auth',
    description: 'authenticate an HTTP MCP server with OAuth',
  },
  args: {
    server: { type: 'positional', description: 'MCP server name from typeclaw.json', required: true },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const result = await runMcpAuthFlow(cwd, args.server)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'show configured MCP servers and OAuth credential state',
  },
  run() {
    const cwd = ensureAgentDir()
    const config = loadConfigSync(cwd)
    const credentials = listMcpCredentials(join(cwd, 'secrets.json'))
    if (config.mcpServers.length === 0) {
      console.log(c.dim('No MCP servers configured in typeclaw.json.'))
      return
    }
    const nameWidth = Math.max(4, ...config.mcpServers.map((server) => server.name.length))
    const typeWidth = 5
    console.log(c.dim(`${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(typeWidth)}  OAUTH`))
    for (const server of config.mcpServers) {
      const type = server.url === undefined ? 'stdio' : 'http'
      const oauth = credentials[server.name] === undefined ? 'not configured' : 'configured'
      console.log(`${server.name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${oauth}`)
    }
  },
})

const logoutSub = defineCommand({
  meta: {
    name: 'logout',
    description: 'remove OAuth credentials for an MCP server',
  },
  args: {
    server: { type: 'positional', description: 'MCP server name from typeclaw.json', required: true },
  },
  run({ args }) {
    const cwd = ensureAgentDir()
    const removed = new SecretsBackend(join(cwd, 'secrets.json')).removeMcpCredentialSync(args.server)
    if (!removed) log.info(`No OAuth credentials found for MCP server "${args.server}".`)
    done({
      title: c.green(`Removed OAuth credentials for MCP server "${args.server}".`),
      hints: [{ label: 'Apply the secrets.json change:', command: 'typeclaw reload' }],
    })
  },
})

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'manage MCP server OAuth credentials',
  },
  subCommands: {
    auth: authSub,
    list: listSub,
    logout: logoutSub,
  },
})

export type McpAuthFlowResult = { ok: true } | { ok: false; reason: string }

export async function runMcpAuthFlow(cwd: string, serverName: string): Promise<McpAuthFlowResult> {
  const config = loadConfigSync(cwd)
  const server = config.mcpServers.find((candidate) => candidate.name === serverName)
  if (server === undefined) return { ok: false, reason: `MCP server "${serverName}" is not configured.` }
  if (server.url === undefined)
    return { ok: false, reason: `MCP server "${serverName}" is stdio-only; OAuth is HTTP-only.` }

  const redirectUrl = `http://localhost:${DEFAULT_CALLBACK_PORT}/callback`
  let authorizationUrl: URL | undefined
  const provider = new TypeClawMcpOAuthProvider(serverName, createFileMcpOAuthStore(join(cwd, 'secrets.json')), {
    mode: 'host',
    redirectUrl,
    clientName: 'typeclaw',
    onRedirect: (url) => {
      authorizationUrl = url
    },
  })
  const callback = createCallbackServer(DEFAULT_CALLBACK_PORT)
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider })
    const client = new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
    try {
      await client.connect(transport)
      await client.close()
      done({ title: c.green(`MCP server "${serverName}" is already authenticated.`), hints: [] })
      return { ok: true }
    } catch (cause) {
      await client.close().catch(() => undefined)
      if (!(cause instanceof UnauthorizedError)) throw cause
    }
    if (authorizationUrl === undefined)
      return { ok: false, reason: 'OAuth server did not provide an authorization URL.' }
    renderAuthorizationUrl(serverName, authorizationUrl)
    openBrowserBestEffort(authorizationUrl)
    const expectedState = await provider.state()
    const codeResult = await Promise.race([callback.code, promptForCodeOrUrl()])
    if (expectedState !== undefined && codeResult.state !== undefined && codeResult.state !== expectedState) {
      return { ok: false, reason: 'OAuth callback state did not match the authorization request.' }
    }
    await transport.finishAuth(codeResult.code)
    await verifyMcpAuth(server.url, provider)
    done({
      title: c.green(`Authenticated MCP server "${serverName}".`),
      hints: [{ label: 'Apply the secrets.json change:', command: 'typeclaw reload' }],
    })
    return { ok: true }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    callback.stop()
  }
}

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

function createCallbackServer(port: number): { code: Promise<{ code: string; state?: string }>; stop(): void } {
  let resolveCode!: (value: { code: string; state?: string }) => void
  const code = new Promise<{ code: string; state?: string }>((resolve) => {
    resolveCode = resolve
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
      const parsed = parseCodeInput(url)
      if (parsed === null) return new Response('Missing OAuth code', { status: 400 })
      resolveCode(parsed)
      return new Response('TypeClaw MCP OAuth complete. You can close this tab.')
    },
  })
  return { code, stop: () => server.stop(true) }
}

function renderAuthorizationUrl(serverName: string, url: URL): void {
  note(
    [
      `Open this URL in your browser to authenticate MCP server "${serverName}".`,
      '',
      'If the browser cannot reach localhost after sign-in, copy the full redirect URL or code and paste it below.',
    ].join('\n'),
    'MCP OAuth',
  )
  console.log(url.toString())
  console.log('')
}

async function promptForCodeOrUrl(): Promise<{ code: string; state?: string }> {
  const value = await text({
    message: 'After signing in, paste the code or full redirect URL:',
    placeholder: 'code, or http://localhost:1456/callback?code=...&state=...',
  })
  if (isCancel(value)) throw new Error('OAuth login cancelled by user')
  const parsed = parseCodeInput(value)
  if (parsed === null) throw new Error('OAuth callback did not include a code')
  return parsed
}

function parseCodeInput(input: string | URL): { code: string; state?: string } | null {
  if (input instanceof URL) {
    const code = input.searchParams.get('code')
    if (code === null || code.trim() === '') return null
    const state = input.searchParams.get('state') ?? undefined
    return { code, ...(state === undefined ? {} : { state }) }
  }
  const trimmed = input.trim()
  if (trimmed === '') return null
  try {
    return parseCodeInput(new URL(trimmed))
  } catch {
    return { code: trimmed }
  }
}

async function verifyMcpAuth(url: string, authProvider: TypeClawMcpOAuthProvider): Promise<void> {
  const client = new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider })
    await client.connect(transport)
    await client.listTools()
  } finally {
    await client.close().catch(() => undefined)
  }
}
