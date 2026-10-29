import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildBuiltinPiToolOverrides } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions/permissions'
import { createHookBus } from '@/plugin'
import { sessionTmpDir } from '@/sandbox/session-tmp'

import { createEvalDispatch } from './dispatch'
import { testContext } from './fixtures.test'
import type { EvalKernel } from './kernel'
import { createSandboxedEvalKernel } from './sandbox'
import { registerEvalTool } from './tool'

const bwrapAvailable = process.platform === 'linux' && Bun.which('bwrap') !== null
const dispatch = async () => {
  throw new Error('no tool dispatch in raw boundary test')
}

describe.skipIf(!bwrapAvailable)('eval real bwrap boundary', () => {
  let dir: string
  let sessionId: string
  let kernel: EvalKernel
  let origin: SessionOrigin
  const permissions = createPermissionService()
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    // Keep the agent outside /tmp: the production /tmp bind intentionally hides
    // its host parent. Source is mounted through the real dev-source resolver.
    dir = await mkdtemp(join(process.cwd(), '.eval-boundary-'))
    sessionId = crypto.randomUUID()
    origin = { kind: 'subagent', subagent: 'operator', parentSessionId: 'test', spawnedByRole: 'guest' }
    await mkdir(join(dir, 'public'), { recursive: true })
    await mkdir(join(dir, 'workspace/.config/agent-messenger'), { recursive: true })
    await mkdir(join(dir, 'workspace/.agent-messenger'), { recursive: true })
    await mkdir(join(dir, '.typeclaw/home'), { recursive: true })
    await writeFile(join(dir, 'public/input.txt'), 'ordinary content')
    for (const path of [
      'secrets.json',
      'auth.json',
      'workspace/.config/agent-messenger/account.json',
      'workspace/.agent-messenger/account.json',
      '.typeclaw/home/credential',
    ]) {
      await writeFile(join(dir, path), 'MASKED_CANARY')
    }
    await writeFile(
      join(dir, '.env'),
      'VISIBLE_EVAL_TEST=visible-canary\nTYPECLAW_SECRET_EVAL_TEST=withheld-canary\n' +
        'TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS=internal.invalid\n',
    )
    for (const [key, value] of [
      ['VISIBLE_EVAL_TEST', 'visible-canary'],
      ['TYPECLAW_SECRET_EVAL_TEST', 'withheld-canary'],
      ['TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS', 'internal.invalid'],
    ] as const) {
      savedEnv.set(key, process.env[key])
      process.env[key] = value
    }
    kernel = createSandboxedEvalKernel({ agentDir: dir, sessionId, permissions, getOrigin: () => origin })
  })

  afterEach(async () => {
    await kernel.dispose()
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
    await rm(dir, { recursive: true, force: true })
    await rm(sessionTmpDir(sessionId), { recursive: true, force: true })
  })

  test.each(['fs', 'Bun.file', 'child_process'])(
    'raw %s cannot read masked bytes',
    async (reader) => {
      const paths = [
        '.env',
        'secrets.json',
        'auth.json',
        '.typeclaw/home/credential',
        'workspace/.config/agent-messenger/account.json',
        'workspace/.agent-messenger/account.json',
      ]
      const expression =
        reader === 'fs'
          ? 'require("node:fs").readFileSync(path, "utf8")'
          : reader === 'Bun.file'
            ? 'await Bun.file(path).text()'
            : 'require("node:child_process").execFileSync(process.execPath, ["-e", "console.log(require(\\"fs\\").readFileSync(process.argv[1],\\"utf8\\"))", path], {encoding:"utf8",stdio:["ignore","pipe","pipe"]})'
      const result = await kernel.run(
        `for (const path of ${JSON.stringify(paths)}) { try { print(${expression}) } catch { print("denied") } }`,
        { dispatch },
      )
      expect(result.isError).toBe(false)
      expect(result.text).not.toMatch(/MASKED_CANARY|visible-canary|withheld-canary/)
    },
    60_000,
  )

  test('raw code can read ordinary public files', async () => {
    const result = await kernel.run('print(await Bun.file("public/input.txt").text())', { dispatch })
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('ordinary content')
  }, 60_000)

  test('unchanged sandbox identities preserve bindings across cells', async () => {
    const first = await kernel.run('const retainedAcrossCells = 42', { dispatch })
    expect(first.isError).toBe(false)
    const next = await kernel.run('print(retainedAcrossCells)', { dispatch })
    expect(next.isError).toBe(false)
    expect(next.restarted).toBe(false)
    expect(next.text.trim()).toBe('42')
  }, 60_000)

  test('environment exposure follows bash including its withheld tiers', async () => {
    const result = await kernel.run(
      'print(process.env.VISIBLE_EVAL_TEST); print(process.env.TYPECLAW_SECRET_EVAL_TEST); print(process.env.TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS)',
      { dispatch },
    )
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('visible-canary\nundefined\nundefined')
  }, 60_000)

  test('canonical file masks survive atomic credential replacement between cells', async () => {
    const first = await kernel.run('print("ready")', { dispatch })
    expect(first.isError).toBe(false)
    await writeFile(join(dir, 'replacement'), 'ROTATED_CANARY')
    await rename(join(dir, 'replacement'), join(dir, 'secrets.json'))
    const next = await kernel.run('print(require("node:fs").readFileSync("secrets.json", "utf8"))', { dispatch })
    expect(next.isError).toBe(false)
    expect(next.text).not.toContain('ROTATED_CANARY')
  }, 60_000)

  test('owner retains the existing role-scoped agent-messenger visibility', async () => {
    origin = { kind: 'tui', sessionId }
    const result = await kernel.run('print(await Bun.file("workspace/.config/agent-messenger/account.json").text())', {
      dispatch,
    })
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('MASKED_CANARY')
  }, 60_000)

  test('a sandboxed cell batches wrapped reads without exposing intermediate content', async () => {
    const tools = buildBuiltinPiToolOverrides({
      agentDir: dir,
      sessionId,
      hooks: createHookBus(),
      permissions,
      getOrigin: () => origin,
    })
    const result = await kernel.run(
      'const rows = await parallel([() => tool.read({path:"public/input.txt"}), () => tool.read({path:"public/input.txt"})]); print(rows.length)',
      { dispatch: createEvalDispatch({ tools, getActiveNames: () => ['read'], context: testContext(dir) }) },
    )
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('2')
  }, 60_000)

  test('the registered eval tool denies a guarded read then completes authorized work', async () => {
    const wrappers = { agentDir: dir, sessionId, hooks: createHookBus(), permissions, getOrigin: () => origin }
    const tools = buildBuiltinPiToolOverrides(wrappers)
    const activeNames = ['bash', 'read']
    const runtime = registerEvalTool({
      settings: { enabled: true, origins: ['subagent'] },
      tools,
      activeNames,
      getActiveNames: () => activeNames,
      wrappers,
    })
    if (runtime === undefined) throw new Error('eval did not register')
    try {
      const tool = tools.find((definition) => definition.name === 'eval')
      if (tool === undefined) throw new Error('missing eval definition')
      const result = await tool.execute(
        'eval-test',
        {
          code: 'let denied = false; try { await tool.read({path:".env"}) } catch { denied = true }; const result = await tool.read({path:"public/input.txt"}); print(denied); print(result.content[0].text); await tool.bash({command:"printf shared > /tmp/eval-bridge"}); print(await Bun.file("/tmp/eval-bridge").text())',
        },
        undefined,
        undefined,
        testContext(dir),
      )
      expect(result.content).toEqual([{ type: 'text', text: 'true\nordinary content\nshared\n' }])
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  test('timeout kills the bwrap kernel and a new kernel recovers', async () => {
    await kernel.run('const previous = 1', { dispatch })
    const failed = await kernel.run('while (true) {}', { dispatch, timeoutMs: 100 })
    expect(failed.isError).toBe(true)
    const next = await kernel.run('print(typeof previous)', { dispatch })
    expect(next.isError).toBe(false)
    expect(next.restarted).toBe(true)
    expect(next.text).toContain('undefined')
  }, 60_000)

  test('a same-author channel turn keeps bindings and an author change discards them', async () => {
    // given a channel turn whose participant counters change on the next message
    const participant = (count: number) => ({
      authorId: 'U1',
      authorName: 'Alice',
      firstMessageAt: 1000,
      lastMessageAt: 1000 + count,
      messageCount: count,
    })
    const channel = (author: string, count: number): SessionOrigin => ({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0123456789',
      chat: 'C0123456789',
      thread: null,
      lastInboundAuthorId: author,
      participants: [participant(count)],
    })
    origin = channel('U1', 1)
    await kernel.run('const keptAcrossTurns = 7', { dispatch })

    // when the same author sends another message
    origin = channel('U1', 2)
    const sameAuthor = await kernel.run('print(keptAcrossTurns)', { dispatch })

    // then bindings survive
    expect(sameAuthor.restarted).toBe(false)
    expect(sameAuthor.text.trim()).toBe('7')

    // when a different author speaks, the kernel is replaced
    origin = channel('U2', 3)
    const otherAuthor = await kernel.run('print(typeof keptAcrossTurns)', { dispatch })
    expect(otherAuthor.restarted).toBe(true)
    expect(otherAuthor.text).toContain('undefined')
  }, 60_000)

  test('an authority change discards retained data before the next cell', async () => {
    origin = { kind: 'tui', sessionId }
    await kernel.run('const retained = await Bun.file("workspace/.config/agent-messenger/account.json").text()', {
      dispatch,
    })
    origin = { kind: 'subagent', subagent: 'operator', parentSessionId: 'test', spawnedByRole: 'guest' }
    const next = await kernel.run('print(typeof retained)', { dispatch })
    expect(next.isError).toBe(false)
    expect(next.restarted).toBe(true)
    expect(next.text).toContain('undefined')
    expect(next.text).not.toContain('MASKED_CANARY')
  }, 60_000)
})
