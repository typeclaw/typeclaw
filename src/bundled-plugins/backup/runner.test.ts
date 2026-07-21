import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type BackupRunnerDeps,
  type GitSpawn,
  type GitSpawnResult,
  parsePorcelain,
  makeDefaultGitSpawn,
  runBackup,
  withIndexLockRetry,
} from './runner'

const okResult = (stdout = ''): GitSpawnResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const failResult = (stderr = 'boom', exit = 1): GitSpawnResult => ({
  exitCode: exit,
  stdout: '',
  stderr,
  timedOut: false,
})

type Call = { args: readonly string[]; cwd: string; env?: Record<string, string> }

function makeSpawn(handler: (args: readonly string[]) => GitSpawnResult): { spawn: GitSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: GitSpawn = async (args, { cwd, env }) => {
    calls.push({ args, cwd, env })
    return handler(args)
  }
  return { spawn, calls }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autobackup-runner-'))
  await mkdir(join(dir, '.git'))
  return dir
}

async function makeGitstoreRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'autobackup-runner-gitstore-'))
  await mkdir(join(dir, '.gitstore'))
  return dir
}

const baseDeps = (spawn: GitSpawn, message = 'chore: test'): BackupRunnerDeps => ({
  gitSpawn: spawn,
  pickCommitMessage: async () => message,
})

describe('runBackup', () => {
  test('default runner commits without executing a planted hook', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-hookless-'))
    try {
      const git = async (args: string[]): Promise<void> => {
        const proc = Bun.spawn({
          cmd: ['git', ...args],
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(await proc.exited).toBe(0)
      }
      await git(['init', '-q', '-b', 'main'])
      await writeFile(join(cwd, 'notes.md'), 'initial\n')
      await git(['add', 'notes.md'])
      await git(['commit', '-qm', 'initial'])
      const marker = join(cwd, 'hook-ran')
      const hook = join(cwd, '.git', 'hooks', 'pre-commit')
      await writeFile(hook, `#!/bin/sh\nprintf '%s' "$TYPECLAW_HOOK_SECRET" > "${marker}"\n`)
      await chmod(hook, 0o755)
      await writeFile(join(cwd, 'notes.md'), 'changed\n')

      const previous = process.env.TYPECLAW_HOOK_SECRET
      process.env.TYPECLAW_HOOK_SECRET = 'must-not-leak'
      try {
        const result = await runBackup(
          { cwd, pushToOrigin: false },
          { gitSpawn: makeDefaultGitSpawn(), pickCommitMessage: async () => 'backup without hooks' },
        )
        expect(result).toEqual({ ok: true, kind: 'committed' })
      } finally {
        if (previous === undefined) delete process.env.TYPECLAW_HOOK_SECRET
        else process.env.TYPECLAW_HOOK_SECRET = previous
      }
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('returns no-repo when .git is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'autobackup-norepo-'))
    const { spawn, calls } = makeSpawn(() => okResult())
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'no-repo' })
    expect(calls.length).toBe(0)
  })

  test('returns clean when status is empty', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn(() => okResult(''))
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'clean' })
  })

  test('threads gitstore args into representative git calls', async () => {
    const cwd = await makeGitstoreRepo()
    const prefix = ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd]
    const { spawn, calls } = makeSpawn((args) => {
      const command = args[prefix.length]
      if (command === 'status') return okResult(' M notes.md\n')
      if (command === 'diff' && args[prefix.length + 2] === '--quiet') return failResult('', 1)
      if (command === 'commit') return okResult()
      if (command === 'rev-parse') return failResult('no upstream', 128)
      if (command === 'remote') return failResult('No such remote', 2)
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, '백업: 메모 저장'))

    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args.includes('status'))?.args.slice(0, prefix.length)).toEqual(prefix)
    expect(calls.find((c) => c.args.includes('commit'))?.args.slice(0, prefix.length)).toEqual(prefix)
  })

  test('skips committing memory/-prefixed paths but stages other dirty paths', async () => {
    const cwd = await makeRepo()
    const status = ' M src/foo.ts\n M memory/2026-04-27.md\n'
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(status)
      if (args[0] === 'add') return okResult()
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--stat') return okResult('foo.ts | 1 +')
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const deps = baseDeps(spawn, 'chore: bump foo')
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)

    expect(result).toEqual({ ok: true, kind: 'committed' })
    const addCall = calls.find((c) => c.args[0] === 'add' && c.args[1] === '--')
    expect(addCall?.args).toEqual(['add', '--', 'src/foo.ts'])
    const forceAdd = calls.find((c) => c.args[0] === 'add' && c.args[1] === '-f')
    expect(forceAdd).toBeUndefined()
  })

  test('force-adds sessions/ paths alongside normal staging', async () => {
    const cwd = await makeRepo()
    await mkdir(join(cwd, 'sessions'))
    await writeFile(join(cwd, 'sessions', 'a.jsonl'), '{}')
    const status = '?? sessions/a.jsonl\n M src/foo.ts\n'
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(status)
      if (args[0] === 'add' && args[1] === '--') return okResult()
      if (args[0] === 'add' && args[1] === '-f') return okResult()
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult('foo.ts | 1 +')
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    const addF = calls.find((c) => c.args[0] === 'add' && c.args[1] === '-f')
    expect(addF?.args).toEqual(['add', '-f', '--', 'sessions/a.jsonl'])
  })

  test('force-adds todo/ paths so continuation state survives across restarts', async () => {
    const cwd = await makeRepo()
    await mkdir(join(cwd, 'todo'))
    await writeFile(join(cwd, 'todo', 'tui.json'), '{}')
    const status = '?? todo/tui.json\n M src/foo.ts\n'
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(status)
      if (args[0] === 'add' && args[1] === '--') return okResult()
      if (args[0] === 'add' && args[1] === '-f') return okResult()
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult('foo.ts | 1 +')
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    const addF = calls.find((c) => c.args[0] === 'add' && c.args[1] === '-f')
    expect(addF?.args).toEqual(['add', '-f', '--', 'todo/tui.json'])
  })

  test('re-stages sessions/ paths that appeared during pickCommitMessage', async () => {
    // given: pickCommitMessage simulates spawning a `backup-message` subagent
    // that writes a NEW session JSONL into sessions/ after the initial status.
    // The runner must capture that file with a second force-add pass; otherwise
    // it sits dirty until the next backup cycle and creates a steady-state of
    // one-cycle-behind orphan commits.
    const cwd = await makeRepo()
    await mkdir(join(cwd, 'sessions'))
    await writeFile(join(cwd, 'sessions', 'pre.jsonl'), '{}')

    const firstStatus = '?? sessions/pre.jsonl\n M src/foo.ts\n'
    const secondStatus = '?? sessions/pre.jsonl\n?? sessions/late.jsonl\n M src/foo.ts\n'
    let statusCalls = 0
    let messagePicked = false

    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') {
        statusCalls += 1
        return okResult(statusCalls === 1 ? firstStatus : secondStatus)
      }
      if (args[0] === 'add' && args[1] === '--') return okResult()
      if (args[0] === 'add' && args[1] === '-f') return okResult()
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'diff' && args[2] === '--stat') return okResult('foo.ts | 1 +')
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })

    const deps: BackupRunnerDeps = {
      gitSpawn: spawn,
      pickCommitMessage: async () => {
        // when: simulate the late file appearing during message synthesis
        await writeFile(join(cwd, 'sessions', 'late.jsonl'), '{}')
        messagePicked = true
        return 'chore: backup'
      },
    }

    // when
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)

    // then: backup completes, AND the late sessions/ file was force-added
    expect(messagePicked).toBe(true)
    expect(result).toEqual({ ok: true, kind: 'committed' })

    const addFCalls = calls.filter((c) => c.args[0] === 'add' && c.args[1] === '-f')
    expect(addFCalls).toHaveLength(2)
    // first add-f stages the pre-existing file (from the initial status)
    expect(addFCalls[0]?.args).toEqual(['add', '-f', '--', 'sessions/pre.jsonl'])
    // second add-f (post-message) captures BOTH the pre-existing file and the
    // late one. We don't care about ordering, only that both paths are present.
    const lateAddPaths = addFCalls[1]?.args.slice(3) ?? []
    expect(lateAddPaths).toContain('sessions/late.jsonl')
    expect(lateAddPaths).toContain('sessions/pre.jsonl')

    // and: there are exactly TWO status calls — one before staging, one after
    // pickCommitMessage returns. Asserting the count keeps a future "optimize"
    // pass from collapsing them back into one and reintroducing the bug.
    expect(statusCalls).toBe(2)

    // and: the second status happened AFTER pickCommitMessage returned.
    // The relative ordering of git calls captures the load-bearing sequence.
    const statusIndices = calls.flatMap((c, i) => (c.args[0] === 'status' ? [i] : []))
    const addFIndices = calls.flatMap((c, i) => (c.args[0] === 'add' && c.args[1] === '-f' ? [i] : []))
    const commitIdx = calls.findIndex((c) => c.args[0] === 'commit')
    expect(statusIndices[1]).toBeGreaterThan(addFIndices[0]!)
    expect(addFIndices[1]).toBeGreaterThan(statusIndices[1]!)
    expect(commitIdx).toBeGreaterThan(addFIndices[1]!)
  })

  test('no upstream but origin exists and HEAD is a branch: pushes with -u and sets tracking', async () => {
    // given: a fresh repo with origin configured but no `branch.<name>.{remote,merge}`
    // tracking — the default state for an agent folder nobody ran `git push -u` on.
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return okResult('main\n')
      if (args[0] === 'push') return okResult()
      return okResult()
    })
    // when
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    // then: pushed with -u to origin HEAD:main, establishing tracking in one shot
    expect(result).toEqual({ ok: true, kind: 'pushed-set-upstream' })
    const push = calls.find((c) => c.args[0] === 'push')
    expect(push?.args).toEqual(['push', '-u', 'origin', 'HEAD:main'])
  })

  test('no upstream and no origin remote: commits only (legitimate offline state)', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return failResult('No such remote', 2)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
  })

  test('no upstream, origin exists, but detached HEAD: commits only (no branch to track)', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('not a tracking branch', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return failResult('ref HEAD is not a symbolic ref', 128)
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
  })

  test('set-upstream push routes non-fast-forward through fetch/rebase/re-push', async () => {
    const cwd = await makeRepo()
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      if (args[0] === 'remote' && args[1] === 'get-url') return okResult('https://example.com/repo.git\n')
      if (args[0] === 'symbolic-ref') return okResult('main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1 ? failResult('! [rejected] (non-fast-forward)\nUpdates were rejected', 1) : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'rebased-and-pushed' })
    expect(calls.filter((c) => c.args[0] === 'push').length).toBe(2)
    // both attempts use the same set-upstream args so tracking is still set on retry
    for (const p of calls.filter((c) => c.args[0] === 'push')) {
      expect(p.args).toEqual(['push', '-u', 'origin', 'HEAD:main'])
    }
    // no tracking ref exists yet, so the recovery fetch must name origin explicitly
    expect(calls.find((c) => c.args[0] === 'fetch')?.args).toEqual(['fetch', 'origin'])
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBeDefined()
  })

  test('pushes when upstream is configured', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'pushed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeDefined()
  })

  test('pushEnv reaches push/fetch only — never local commands that can run repo hooks', async () => {
    // given: a minted-token env and a non-fast-forward push so fetch+rebase run too
    const cwd = await makeRepo()
    const pushEnv = { GIT_ASKPASS: '/x/askpass', TYPECLAW_GIT_TOKEN: 'ghs_secret' }
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1 ? failResult('! [rejected] (non-fast-forward)\nUpdates were rejected', 1) : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    // when
    await runBackup({ cwd, pushToOrigin: true }, { ...baseDeps(spawn), pushEnv })

    // then: every push/fetch carries the token; the local commit/add/status/rebase
    // (which can execute repo-controlled git hooks) must NOT see it.
    const networkCmds = new Set(['push', 'fetch'])
    for (const c of calls) {
      if (networkCmds.has(c.args[0] as string)) {
        expect(c.env).toEqual(pushEnv)
      } else {
        expect(c.env).toBeUndefined()
      }
    }
    // sanity: the hook-executing commands actually ran in this scenario
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(true)
    expect(calls.some((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBe(true)
  })

  test('on non-fast-forward push, fetches, rebases, and re-pushes', async () => {
    const cwd = await makeRepo()
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return pushCount === 1
          ? failResult('! [rejected] main -> main (non-fast-forward)\nUpdates were rejected', 1)
          : okResult()
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === 'origin/main') return okResult()
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'rebased-and-pushed' })
    expect(calls.filter((c) => c.args[0] === 'push').length).toBe(2)
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === 'origin/main')).toBeDefined()
  })

  test('on rebase conflict, aborts and calls diagnoseFailure', async () => {
    const cwd = await makeRepo()
    const diagnoseCalls: { stage: string; exit: number }[] = []
    let pushCount = 0
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') {
        pushCount += 1
        return failResult('! [rejected] main -> main (non-fast-forward)', 1)
      }
      if (args[0] === 'fetch') return okResult()
      if (args[0] === 'rebase' && args[1] === '--abort') return okResult()
      if (args[0] === 'rebase') return failResult('CONFLICT (content): foo', 1)
      return okResult()
    })
    const deps: BackupRunnerDeps = {
      ...baseDeps(spawn),
      diagnoseFailure: async (input) => {
        diagnoseCalls.push({ stage: input.stage, exit: input.exitCode })
      },
    }
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('rebase-failed')
    expect(diagnoseCalls).toEqual([{ stage: 'rebase', exit: 1 }])
    expect(calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--abort')).toBeDefined()
    expect(pushCount).toBe(1)
  })

  test('diagnose-failure is advisory; its throw must not mask the original failure', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      if (args[0] === 'push') return failResult('Authentication failed', 128)
      return okResult()
    })
    const deps: BackupRunnerDeps = {
      ...baseDeps(spawn),
      diagnoseFailure: async () => {
        throw new Error('diagnose blew up')
      },
    }
    const result = await runBackup({ cwd, pushToOrigin: true }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('push-failed')
      expect(result.reason).toContain('Authentication failed')
    }
  })

  test('does not push when pushToOrigin is false, even with upstream configured', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'rev-parse') return okResult('origin/main\n')
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: false }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'rev-parse')).toBeUndefined()
  })

  test('returns clean when staged diff is empty after add (e.g. only memory/ paths dirty)', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M memory/foo.md\n')
      return okResult()
    })
    const result = await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn))
    expect(result).toEqual({ ok: true, kind: 'clean' })
  })

  test('sanitizes commit message: long subject is truncated, fallback on empty', async () => {
    const cwd = await makeRepo()
    let captured = ''
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') {
        captured = args[2] ?? ''
        return okResult()
      }
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    const long = 'x'.repeat(500)
    await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, long))
    expect(captured.length).toBeLessThanOrEqual(200)
  })

  test('falls back to "Backup" subject when picker returns empty', async () => {
    const cwd = await makeRepo()
    let captured = ''
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') {
        captured = args[2] ?? ''
        return okResult()
      }
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })
    await runBackup({ cwd, pushToOrigin: true }, baseDeps(spawn, '   '))
    expect(captured).toBe('Backup')
  })

  test('runs git gc after a successful commit when packs meet the threshold', async () => {
    // given: a repo whose pack count is at/above the threshold
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'count-objects') return okResult('count: 3\npacks: 25\n')
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })

    // when
    const result = await runBackup({ cwd, pushToOrigin: false, gcPackThreshold: 20 }, baseDeps(spawn))

    // then: committed, and gc ran AFTER the commit
    expect(result).toEqual({ ok: true, kind: 'committed' })
    const commitIdx = calls.findIndex((c) => c.args[0] === 'commit')
    const gcIdx = calls.findIndex((c) => c.args[0] === 'gc')
    expect(gcIdx).toBeGreaterThan(commitIdx)
  })

  test('never runs git gc when gcPackThreshold is 0', async () => {
    const cwd = await makeRepo()
    const { spawn, calls } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: false, gcPackThreshold: 0 }, baseDeps(spawn))

    expect(result).toEqual({ ok: true, kind: 'committed' })
    expect(calls.some((c) => c.args[0] === 'count-objects')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'gc')).toBe(false)
  })

  test('a git gc failure does not fail the backup', async () => {
    const cwd = await makeRepo()
    const { spawn } = makeSpawn((args) => {
      if (args[0] === 'status') return okResult(' M foo\n')
      if (args[0] === 'diff' && args[2] === '--quiet') return failResult('', 1)
      if (args[0] === 'commit') return okResult()
      if (args[0] === 'count-objects') return okResult('packs: 99\n')
      if (args[0] === 'gc') return failResult('gc exploded', 1)
      if (args[0] === 'rev-parse') return failResult('no upstream', 128)
      return okResult()
    })

    const result = await runBackup({ cwd, pushToOrigin: false, gcPackThreshold: 20 }, baseDeps(spawn))

    expect(result).toEqual({ ok: true, kind: 'committed' })
  })
})

describe('parsePorcelain', () => {
  test('parses standard modified/added lines', () => {
    expect(parsePorcelain(' M src/foo.ts\n?? bar.ts\n')).toEqual(['src/foo.ts', 'bar.ts'])
  })

  test('returns the destination on rename lines', () => {
    expect(parsePorcelain('R  old/path -> new/path\n')).toEqual(['new/path'])
  })

  test('skips empty and short lines', () => {
    expect(parsePorcelain('\n  \nXY\n')).toEqual([])
  })
})

describe('withIndexLockRetry', () => {
  test('retries index.lock failures and returns the successful result', async () => {
    const calls: Array<readonly string[]> = []
    const spawn: GitSpawn = async (args) => {
      calls.push(args)
      if (calls.length <= 2) return failResult("fatal: Unable to create '.git/index.lock': File exists")
      return okResult('done')
    }

    const result = await withIndexLockRetry(spawn)(['add', '--', 'foo'], { cwd: '/repo', timeoutMs: 1 })

    expect(result).toEqual(okResult('done'))
    expect(calls).toHaveLength(3)
  })
})
