import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Type } from 'typebox'

import { wrapBuiltinToolDefinition } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { createGithubTokenBridge } from '@/channels/github-token-bridge'
import { createPermissionService } from '@/permissions'
import { createHookBus } from '@/plugin'
import { buildSandboxedCommand } from '@/sandbox'

import { createWatchGithubCredentialResolver } from './github-credential'
import { createBundledProbeRegistry } from './runner'
import { WatchService } from './service'
import { WatchStore } from './store'
import { createWatchTool, registerWatchesFromBash, registerWatchRuntime } from './tool'

const channel = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: 'workspace',
  chat: 'room',
  thread: 'thread',
  lastInboundAuthorId: 'alice',
  isDm: false,
  room: { kind: 'thread', parentChat: 'parent' },
} as const
const member = {
  kind: 'subagent',
  subagent: 'contributor',
  parentSessionId: 'session',
  spawnedByRole: 'member',
  spawnedByOrigin: channel,
} as const
const pr = 'https://github.com/acme/widgets/pull/12'
const issue = 'https://github.com/acme/widgets/issues/13'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auto-watch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup(github = createGithubTokenBridge()) {
  const store = new WatchStore(dir)
  const service = new WatchService(
    store,
    async () => ({ verdict: 'quiet' }),
    async () => {},
    () => {},
  )
  const registry = createBundledProbeRegistry()
  const permissions = createPermissionService()
  let auto = true
  const unregister = registerWatchRuntime(dir, {
    service,
    registry,
    isAutoEnabled: () => auto,
    resolveGithubCredential: createWatchGithubCredentialResolver(dir, permissions, github),
  })
  return {
    store,
    permissions,
    unregister,
    disable: () => {
      auto = false
    },
    bash: (origin: SessionOrigin, command: string, output: string) =>
      registerWatchesFromBash(dir, origin, permissions, command, output),
  }
}

function setupWithApp() {
  const github = createGithubTokenBridge()
  github.registerResolver(async () => ({ token: 'fixture' }))
  return setup(github)
}

test('successful wrapped bash registers both boot probes and returns the persisted ID for channel-scoped cancellation', async () => {
  const runtime = setupWithApp()
  const { permissions, store } = runtime
  const tool = wrapBuiltinToolDefinition(
    {
      name: 'bash',
      label: 'Bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id, { command }) {
        const output = command.startsWith('gh pr') ? pr : issue
        return {
          content: [{ type: 'text' as const, text: output }],
          details: { exitCode: command.endsWith('--fail') ? 1 : 0 },
        }
      },
    },
    {
      agentDir: dir,
      sessionId: 'auto-watch-model',
      hooks: createHookBus(),
      getOrigin: () => member,
      permissions,
      onSuccessfulBash: runtime.bash,
      bashSandboxBoundary: {
        ensureAvailable: async () => {},
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand: (command, options) => ({ ...buildSandboxedCommand(command, options), commandString: command }),
      },
    },
  )
  const execute = (id: string, command: string) => tool.execute(id, { command }, undefined, undefined, {} as never)
  try {
    const failed = await execute('fail', 'gh pr create --fail')
    expect(failed.content).not.toContainEqual({ type: 'text', text: expect.stringContaining('watch registered') })
    expect(store.records).toHaveLength(0)

    for (const [kind, command, repo, number] of [
      ['github-pr', 'gh pr create', 'acme/widgets', 12],
      ['github-issue', 'gh issue create', 'acme/widgets', 13],
    ] as const) {
      const result = await execute(kind, command)
      const saved = store.records.at(-1)
      if (!saved) throw new Error('Expected a persisted watch')
      expect(saved.probe).toEqual({ bundled: kind, target: { repo, number } })
      expect(saved.wakeTarget).toEqual({
        kind: 'channel',
        key: { adapter: 'discord-bot', workspace: 'workspace', chat: 'room', thread: 'thread' },
        isDm: false,
        room: channel.room,
        requester: { authorId: 'alice', authorAdapter: 'discord-bot' },
      })
      const notice = result.content.at(-1)
      if (notice?.type !== 'text') throw new Error('Expected a model-visible watch notice')
      expect(notice.text).toContain(saved.id)
      const watch = createWatchTool(dir, () => member, permissions)
      await watch.execute('cancel', { action: 'cancel', id: saved.id }, undefined, undefined, {} as never)
      expect(store.records.at(-1)?.status).toBe('cancelled')
    }
    expect(store.records).toHaveLength(2)
  } finally {
    runtime.unregister()
  }
})

test('view, denied role, and disabled config do not persist a watch or return a notice', async () => {
  const runtime = setupWithApp()
  try {
    expect(await runtime.bash(member, 'gh pr view 12', pr)).toEqual([])
    expect(await runtime.bash({ ...member, spawnedByRole: 'guest' }, 'gh pr create', pr)).toEqual([])
    runtime.disable()
    expect(await runtime.bash(member, 'gh pr create', pr)).toEqual([])
    expect(runtime.store.records).toEqual([])
  } finally {
    runtime.unregister()
  }
})

test('concurrent auto-registration creates one live watch and canonicalizes manual duplicates', async () => {
  const runtime = setupWithApp()
  try {
    const calls = await Promise.all([
      runtime.bash(member, 'gh pr create', pr),
      runtime.bash(member, 'gh pr create', pr),
    ])
    expect(calls.flat()).toHaveLength(1)
    const watch = createWatchTool(dir, () => member, runtime.permissions)
    await watch.execute(
      'create',
      {
        action: 'create',
        description: 'Existing issue follow-up',
        probe: { bundled: 'github-issue', target: { repo: 'Acme/Widgets', number: 13 } },
      },
      undefined,
      undefined,
      {} as never,
    )
    expect(await runtime.bash(member, 'gh issue create', issue)).toEqual([])
    expect(runtime.store.records).toHaveLength(2)
  } finally {
    runtime.unregister()
  }
})

test('a successful create backed only by an imported CLI login reports that no polling watch was scheduled', async () => {
  const cliConfig = join(dir, 'gh')
  await mkdir(cliConfig)
  await writeFile(join(cliConfig, 'hosts.yml'), 'github.com:\n  user: alice\n')
  const prior = process.env.GH_CONFIG_DIR
  process.env.GH_CONFIG_DIR = cliConfig
  const runtime = setup()
  try {
    const notices = await runtime.bash(member, 'gh pr create', pr)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('not scheduled')
    expect(notices[0]).toContain('CLI-only')
    expect(runtime.store.records).toHaveLength(0)
  } finally {
    runtime.unregister()
    if (prior === undefined) delete process.env.GH_CONFIG_DIR
    else process.env.GH_CONFIG_DIR = prior
  }
})
