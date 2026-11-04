import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import type { FillSecretOptions } from '@/browser/fill-secret'
import { createPermissionService } from '@/permissions'
import { rolesConfigSchema } from '@/permissions/schema'

import {
  browserEnvOverlay,
  browserSkillDirs,
  createFillSecretTool,
  FILL_SECRET_TOOL,
  fillSecretGuardHook,
  sharedBrowserBashHook,
} from './index'

const managed = {
  cdpUrl: 'ws://127.0.0.1:4000/devtools/browser/typeclaw?token=t',
  filesDir: '/agent/workspace/.typeclaw-browser/files',
}
const hookContext = { agentDir: '/agent', pluginName: 'managed-browser', logger: { info() {}, warn() {}, error() {} } }

async function runHook(origin: Parameters<ReturnType<typeof createPermissionService>['has']>[0], tool = 'bash') {
  const hook = sharedBrowserBashHook(createPermissionService(), { TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl })
  const args: Record<string, unknown> = { command: 'true', [TYPECLAW_INTERNAL_BASH_ENV]: { GH_REPO: 'acme/app' } }
  await hook({ tool, sessionId: 's', callId: 'c', args, origin }, hookContext)
  return args[TYPECLAW_INTERNAL_BASH_ENV]
}

describe('shared browser bash access', () => {
  test('injects the browser URL for a role holding browser.shared, keeping existing overlay entries', async () => {
    expect(await runHook({ kind: 'tui', sessionId: 's' })).toEqual({
      GH_REPO: 'acme/app',
      TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
    })
  })

  test('withholds the browser URL from an unresolved origin, which resolves to guest', async () => {
    expect(await runHook(undefined)).toEqual({ GH_REPO: 'acme/app' })
  })

  test('leaves non-bash tools untouched', async () => {
    expect(await runHook({ kind: 'tui', sessionId: 's' }, 'read')).toEqual({ GH_REPO: 'acme/app' })
  })
})

describe('browser engine wiring', () => {
  test('attaches the always-installed agent-browser to the shared browser even when it is not a listed engine', () => {
    const env = browserEnvOverlay(
      { engines: ['omowright'], extensions: [] },
      { ...managed, bskRelay: undefined, token: 't' },
    )

    expect(env).toMatchObject({ AGENT_BROWSER_CDP: managed.cdpUrl, OMOWRIGHT_CDP_URL: managed.cdpUrl })
    expect(env).not.toHaveProperty('BU_CDP_WS')
  })

  test('exposes each enabled engine and extension env, and BrowserSkill home when loaded', () => {
    const env = browserEnvOverlay(
      { engines: ['agent-browser', 'omowright', 'browser-use'], extensions: ['browserskill'] },
      { ...managed, bskRelay: '127.0.0.1:4100', token: 't' },
    )

    expect(env).toMatchObject({
      TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
      TYPECLAW_BROWSER_FILES: managed.filesDir,
      AGENT_BROWSER_CDP: managed.cdpUrl,
      OMOWRIGHT_CDP_URL: managed.cdpUrl,
      BU_CDP_WS: managed.cdpUrl,
      ANONYMIZED_TELEMETRY: 'false',
      TYPECLAW_BSK_RELAY: '127.0.0.1:4100',
      TYPECLAW_BSK_TOKEN: 't',
    })
  })

  test('ships a skill for every non-default engine and extension, and none for disabled ones', () => {
    const dirs = browserSkillDirs({
      engines: ['agent-browser', 'omowright', 'browser-use'],
      extensions: ['browserskill'],
    })

    expect(dirs.map((dir) => basename(dir))).toEqual(['omowright', 'browser-use', 'browserskill'])
    for (const dir of dirs) expect(existsSync(join(dir, basename(dir), 'SKILL.md'))).toBe(true)
    expect(browserSkillDirs({ engines: ['agent-browser'], extensions: [] })).toEqual([])
  })
})

describe('browser_fill_secret permissions', () => {
  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const guard = (roles?: Parameters<typeof createPermissionService>[0]) =>
    fillSecretGuardHook(createPermissionService(roles))
  const slack: SessionOrigin = {
    kind: 'channel',
    adapter: 'slack-bot',
    workspace: 'T0123456789',
    chat: 'C0123456789',
    thread: null,
    lastInboundAuthorId: 'alice',
  }
  const call = (hook: ReturnType<typeof fillSecretGuardHook>, name: string, origin: SessionOrigin | undefined) =>
    hook({ tool: FILL_SECRET_TOOL, sessionId: 's', callId: 'c', args: { name }, origin }, hookContext)

  test('lets the owner type both ordinary and secret-tier variables', async () => {
    expect(await call(guard(), 'SHOP_ADDRESS', tui)).toBeUndefined()
    expect(await call(guard(), 'TYPECLAW_SECRET_STRIPE_KEY', tui)).toBeUndefined()
  })

  test('blocks a role without browser.shared', async () => {
    expect(await call(guard(), 'SHOP_ADDRESS', undefined)).toMatchObject({ block: true })
  })

  test('vault references need vault.use: a member may type one, a browser-only role may not', async () => {
    const roles = rolesConfigSchema.parse({
      member: { match: ['slack:*'] },
      shopper: { match: ['slack:*'], permissions: ['channel.respond', 'browser.shared'] },
    })
    const member = guard({ roles: rolesConfigSchema.parse({ member: { match: ['slack:*'] } }) })
    const shopper = guard({ roles })
    expect(await call(member, 'tv://github/bot#password', slack)).toBeUndefined()
    expect(await call(shopper, 'tv://github/bot#password', slack)).toMatchObject({ block: true })
  })

  test('lets a member type ordinary variables but not the secret tier, which needs fs.see.secrets', async () => {
    const member = guard({ roles: rolesConfigSchema.parse({ member: { match: ['slack:*'] } }) })
    expect(await call(member, 'SHOP_ADDRESS', slack)).toBeUndefined()
    expect(await call(member, 'TYPECLAW_SECRET_STRIPE_KEY', slack)).toMatchObject({ block: true })
  })
})

describe('browser_fill_secret tool', () => {
  const run = async (name: string, envFile: string, runtimeEnv: Record<string, string>) => {
    const agentDir = mkdtempSync(join(tmpdir(), 'fill-secret-'))
    writeFileSync(join(agentDir, '.env'), envFile)
    const saved = Object.fromEntries(Object.keys(runtimeEnv).map((k) => [k, process.env[k]]))
    Object.assign(process.env, runtimeEnv)
    const calls: FillSecretOptions[] = []
    const tool = createFillSecretTool(managed.cdpUrl, async (options) => {
      calls.push(options)
      return { status: 'submitted', url: 'https://example.com/login', field: 'input[type=password]' }
    })
    try {
      const result = await tool.execute(tool.parameters.parse({ name, submit: true }), {
        signal: undefined,
        sessionId: 's',
        agentDir,
        logger: hookContext.logger,
      })
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      return { calls, text }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(agentDir, { recursive: true, force: true })
    }
  }

  test('types a secret-tier value and never returns it', async () => {
    const { calls, text } = await run('TYPECLAW_SECRET_PW', 'TYPECLAW_SECRET_PW=hunter2\n', {
      TYPECLAW_SECRET_PW: 'hunter2',
    })
    expect(calls).toEqual([{ cdpUrl: managed.cdpUrl, value: 'hunter2', submit: true }])
    expect(text).toContain('example.com/login')
    expect(text).not.toContain('hunter2')
  })

  test('refuses runtime controls and undeclared names without touching the browser', async () => {
    const hostd = await run('TYPECLAW_HOSTD_TOKEN', 'TYPECLAW_HOSTD_TOKEN=hostd-value\n', {
      TYPECLAW_HOSTD_TOKEN: 'hostd-value',
    })
    const undeclared = await run('NOT_IN_ENV_FILE', '', { NOT_IN_ENV_FILE: 'x' })
    expect(hostd.calls).toEqual([])
    expect(hostd.text).not.toContain('hostd-value')
    expect(undeclared.calls).toEqual([])
  })
})
