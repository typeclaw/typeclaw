import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import githubCliAuth from '@/bundled-plugins/github-cli-auth'
import { createGithubTokenBridge } from '@/channels/github-token-bridge'
import { createPermissionService } from '@/permissions'
import { createHookBus } from '@/plugin'
import { buildSandboxedCommand, shellQuote } from '@/sandbox'

import { createProbeRunner, ProbeRegistry } from './runner'
import type { WatchRecord } from './store'

const id = crypto.randomUUID()
const w: WatchRecord = {
  id,
  probe: { command: 'true' },
  description: 'Probe',
  mode: 'judge',
  createdAt: 0,
  deadline: 1000,
  nextRunAt: 0,
  createdByRole: 'member',
  createdByOrigin: { kind: 'cron', jobId: 'job', jobKind: 'prompt', scheduledByRole: 'member' },
  wakeTarget: { kind: 'fresh' },
  status: 'active',
  consecutiveFailures: 0,
  consecutiveWakes: 0,
  pending: [],
}
test('hook can block a deferred command with the creator role before bash executes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-hook-'))
  try {
    const hooks = createHookBus(),
      seen: { sessionId: string; jobId: string; role?: string }[] = []
    hooks.registerAll('test-hook', dir, console, {
      'tool.before': (event) => {
        if (event.origin?.kind === 'cron')
          seen.push({ sessionId: event.sessionId, jobId: event.origin.jobId, role: event.origin.scheduledByRole })
        return { block: true, reason: 'denied by test policy' }
      },
    })
    const runner = createProbeRunner(
      dir,
      createPermissionService(),
      () => hooks,
      createGithubTokenBridge(),
      new ProbeRegistry(),
    )
    await expect(runner.run(w, new AbortController().signal)).rejects.toThrow('denied by test policy')
    expect(seen).toEqual([{ sessionId: `watch-${id}`, jobId: `watch:${id}`, role: 'member' }])
    expect(seen[0]!.sessionId).toMatch(/^[a-zA-Z0-9_-]+$/)
    const path = join(dir, 'workspace', '.typeclaw-watches', id)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700)
    await runner.cleanup(id)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test.skipIf(!Bun.which('bash'))(
  'short lines survive Pi display truncation and a missing cwd prevents all probe statements',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watch-frame-'))
    try {
      // Exercise Pi and the complete wrapper; only replace the Linux process
      // boundary so these shell protocol regressions also run on dev machines.
      const hooks = createHookBus(),
        github = createGithubTokenBridge(),
        permissions = createPermissionService()
      const minted: string[] = []
      github.registerResolver(async (repo) => {
        minted.push(repo)
        return { token: 'fixture' }
      })
      let sandboxPreparations = 0
      const plugin = await githubCliAuth.plugin({
        name: 'github-cli-auth',
        version: undefined,
        config: undefined,
        agentDir: dir,
        logger: console,
        permissions,
        github,
        spawnSubagent: async () => {},
      })
      hooks.registerAll('github-cli-auth', dir, console, plugin.hooks!)
      await mkdir(join(dir, 'checkout'))
      await writeFile(join(dir, 'checkout', 'query-result'), 'ready')
      const runner = createProbeRunner(dir, permissions, () => hooks, github, new ProbeRegistry(), {
        ensureAvailable: async () => {
          sandboxPreparations++
        },
        resolveProcStrategy: async () => ({ strategy: 'proc-bind' }),
        resolveRuntime: async () => ({ env: {}, mounts: [] }),
        buildCommand: (command, options) => {
          const built = buildSandboxedCommand(command, options)
          const chdir = built.argv.indexOf('--chdir')
          if (chdir < 0) throw new Error('Missing sandbox cwd')
          // Stand in only for bwrap's chdir and the external GitHub CLI.
          return {
            ...built,
            commandString: `cd -- ${shellQuote(built.argv[chdir + 1]!)} || exit 1\ngh(){ cat query-result; }; export -f gh\n${command}`,
          }
        },
      })
      const run = (command: string, cwd?: string) =>
        runner.run({ ...w, probe: { command, cwd } }, new AbortController().signal)
      const result = await run(`for ((i=0;i<2100;i++)); do echo x; done; echo '끝'; exit 10`)
      expect(result).toMatchObject({ verdict: 'wake', summary: 'x\n'.repeat(2100) + '끝' })
      const query = 'gh pr view 1 -R owner/repo --json state'
      expect((await run(query, 'checkout')).summary).toBe('ready')
      expect(minted).toContain('owner/repo')
      const beforeCancellation = sandboxPreparations
      const minting = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      github.registerResolver(async () => {
        minting.resolve()
        await release.promise
        return { token: 'fixture' }
      })
      const stop = new AbortController()
      const interrupted = runner.run({ ...w, probe: { command: query, cwd: 'checkout' } }, stop.signal)
      await minting.promise
      stop.abort(new Error('probe cancelled'))
      release.resolve()
      await expect(interrupted).rejects.toThrow('probe cancelled')
      expect(sandboxPreparations).toBe(beforeCancellation)
      await expect(run(query, 'missing-directory')).rejects.toThrow('missing-directory')
      await expect(run('echo first\ntouch unexpected\nexit 10', 'missing-directory')).rejects.toThrow(
        'missing-directory',
      )
      expect(await Bun.file(join(dir, 'unexpected')).exists()).toBe(false)
      const diff = (prefix: string, state?: WatchRecord['state']) =>
        runner.run(
          { ...w, mode: 'diff', state, probe: { command: `printf ${prefix}; printf '%08192d' 0` } },
          new AbortController().signal,
        )
      const baseline = await diff('first')
      const changed = await diff('second', baseline.state)
      expect(changed.verdict).toBe('wake')
      expect((await diff('second', changed.state)).verdict).toBe('quiet')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap'))(
  'real sandbox keeps stderr out of the verdict and allows state but not authority writes',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watch-bwrap-'))
    try {
      const runner = createProbeRunner(
        dir,
        createPermissionService(),
        () => createHookBus(),
        createGithubTokenBridge(),
        new ProbeRegistry(),
      )
      const command = `test -z "\${TYPECLAW_WATCH_LAST_RUN_AT+x}" && test -n "$TYPECLAW_WATCH_ID" && touch "$TYPECLAW_WATCH_STATE_DIR/ok" || exit 1
if echo changed > .typeclaw/watches.json; then exit 1; fi
echo ready; echo diagnostic >&2; exit 10`
      expect(await runner.run({ ...w, probe: { command } }, new AbortController().signal)).toMatchObject({
        verdict: 'wake',
        summary: 'ready',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
test('registered probe receives parsed parameters, last state and the repo-scoped credential resolver', async () => {
  const registry = new ProbeRegistry(),
    bridge = createGithubTokenBridge()
  bridge.registerResolver(async (repo) => ({ token: `fixture:${repo}` }))
  registry.register({
    kind: 'fixture',
    parseParams: (raw) => String(raw),
    describe: (p) => p,
    async run(ctx) {
      const credential = await ctx.resolveTokenForRepo(ctx.params)
      expect(credential).toMatchObject({ kind: 'token', token: 'fixture:org/repo' })
      return { verdict: 'done', state: [ctx.state, ctx.lastRunAt] }
    },
  })
  const runner = createProbeRunner(tmpdir(), createPermissionService(), () => createHookBus(), bridge, registry)
  expect(
    await runner.run(
      { ...w, probe: { bundled: 'fixture', target: 'org/repo' }, state: 'baseline', lastRunAt: 12 },
      new AbortController().signal,
    ),
  ).toEqual({ verdict: 'done', state: ['baseline', 12] })
})
test('a channel requester can keep probing after a promotion but cannot keep a revoked role', async () => {
  const permissions = createPermissionService()
  const registry = new ProbeRegistry()
  registry.register({
    kind: 'status',
    parseParams: () => null,
    describe: () => 'status',
    run: async () => ({ verdict: 'quiet', state: null }),
  })
  const runner = createProbeRunner(tmpdir(), permissions, () => createHookBus(), createGithubTokenBridge(), registry)
  const key = { adapter: 'slack-bot', workspace: 'workspace', chat: 'room', thread: null } as const
  const record: WatchRecord = {
    ...w,
    probe: { bundled: 'status', target: null },
    wakeTarget: { kind: 'channel', key, requester: { authorAdapter: key.adapter, authorId: 'speaker' } },
  }
  permissions.replaceRoles({
    trusted: { match: [{ kind: 'channel', platform: 'slack', workspace: 'workspace', author: 'speaker' }] },
  })
  expect((await runner.run(record, new AbortController().signal)).verdict).toBe('quiet')
  permissions.replaceRoles({})
  await expect(runner.run(record, new AbortController().signal)).rejects.toThrow('watch.create')
})

test('polls deny a process PAT to a member, allow an entitled owner, and retain channel repo scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-poll-pat-'))
  const saved = process.env.GH_TOKEN
  const token = 'ghp_' + 'fixture'
  process.env.GH_TOKEN = token
  const bridge = createGithubTokenBridge()
  const registry = new ProbeRegistry()
  const used: string[] = []
  registry.register({
    kind: 'fixture',
    parseParams: (raw) => String(raw),
    describe: (repo) => repo,
    async run(ctx) {
      const result = await ctx.resolveTokenForRepo(ctx.params)
      if (result.kind === 'unavailable') throw new Error(result.reason)
      used.push(result.token)
      return { verdict: 'quiet', state: null }
    },
  })
  const permissions = createPermissionService()
  const runner = createProbeRunner(dir, permissions, createHookBus, bridge, registry)
  const run = (createdByRole: string, repo: string) =>
    runner.run({ ...w, createdByRole, probe: { bundled: 'fixture', target: repo } }, new AbortController().signal)
  try {
    await expect(run('member', 'acme/widgets')).rejects.toThrow('No GitHub polling credential')
    expect(used).toEqual([])
    await expect(run('owner', 'acme/widgets')).resolves.toMatchObject({ verdict: 'quiet' })
    await writeFile(join(dir, '.env'), `GH_TOKEN=${token}\n`)
    await expect(run('member', 'acme/widgets')).resolves.toMatchObject({ verdict: 'quiet' })
    bridge.registerPatResolver(async (repo) => {
      if (repo !== 'acme/widgets') throw new Error('Repo not in configured allowlist')
      return { token: 'channel fixture' }
    })
    await expect(run('owner', 'acme/other')).rejects.toThrow('configured allowlist')
    await expect(run('member', 'acme/widgets')).rejects.toThrow('not entitled')
    await expect(run('owner', 'acme/widgets')).resolves.toMatchObject({ verdict: 'quiet' })
    expect(used).toEqual([token, token, 'channel fixture'])
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
    await rm(dir, { recursive: true, force: true })
  }
})
