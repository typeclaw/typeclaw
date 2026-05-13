import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDoctor } from './index'
import type { DoctorCheck } from './types'

function makeTmpAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-doctor-test-'))
  writeFileSync(join(dir, 'typeclaw.json'), JSON.stringify({}), 'utf8')
  return dir
}

async function initGitRepo(cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: [
      'git',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'init',
      '-q',
      cwd,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  await run(['git', 'config', 'user.email', 'test@example.com'], cwd)
  await run(['git', 'config', 'user.name', 'Test'], cwd)
  await run(['git', 'add', '.'], cwd)
  await run(['git', 'commit', '-q', '--allow-empty', '-m', 'init'], cwd)
}

async function run(cmd: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

function fakeCheck(name: string, status: 'ok' | 'warning' | 'error', opts: { autoFix?: boolean } = {}): DoctorCheck {
  return {
    name,
    category: 'config',
    description: name,
    async run(ctx) {
      if (status === 'ok') return { status: 'ok', message: `${name} ok` }
      const base = { status, message: `${name} ${status}` } as const
      if (!opts.autoFix) return base
      return {
        ...base,
        fix: {
          description: `fix ${name}`,
          autoFix: async () => {
            writeFileSync(join(ctx.cwd, `${name}.txt`), 'fixed', 'utf8')
            return { summary: `fixed ${name}`, changedPaths: [`${name}.txt`] }
          },
        },
      }
    },
  }
}

describe('runDoctor', () => {
  test('aggregates static check results and sets ok=true when all pass', async () => {
    const cwd = makeTmpAgentDir()
    const result = await runDoctor({
      cwd,
      staticChecks: [fakeCheck('alpha', 'ok'), fakeCheck('beta', 'ok')],
      fetchPluginChecks: async () => ({ kind: 'ok', checks: [] }),
    })
    expect(result.initial.summary.ok).toBe(2)
    expect(result.initial.ok).toBe(true)
    expect(result.fixAttempts).toBeUndefined()
  })

  test('marks ok=false when any warning or error appears', async () => {
    const cwd = makeTmpAgentDir()
    const result = await runDoctor({
      cwd,
      staticChecks: [fakeCheck('alpha', 'warning')],
      fetchPluginChecks: async () => ({ kind: 'ok', checks: [] }),
    })
    expect(result.initial.ok).toBe(false)
    expect(result.initial.summary.warning).toBe(1)
  })

  test('runs auto-fixes, commits in agent folder, then reruns checks', async () => {
    const cwd = makeTmpAgentDir()
    await initGitRepo(cwd)

    const result = await runDoctor({
      cwd,
      fix: true,
      staticChecks: [fakeCheck('alpha', 'warning', { autoFix: true })],
      fetchPluginChecks: async () => ({ kind: 'ok', checks: [] }),
    })

    expect(result.fixAttempts).toBeDefined()
    expect(result.fixAttempts?.[0]).toMatchObject({ ok: true, name: 'alpha', source: 'static' })
    expect(result.commit?.kind).toBe('committed')

    const log = await run(['git', 'log', '--format=%s', '-1'], cwd)
    expect(log.stdout.trim()).toBe('typeclaw doctor: auto-fix 1 issue')
  })

  test('skips commit when agent folder has no .git', async () => {
    const cwd = makeTmpAgentDir()
    const result = await runDoctor({
      cwd,
      fix: true,
      staticChecks: [fakeCheck('alpha', 'warning', { autoFix: true })],
      fetchPluginChecks: async () => ({ kind: 'ok', checks: [] }),
    })
    expect(result.commit?.kind).toBe('skipped')
  })

  test('marks plugin checks deferred when bridge is unreachable', async () => {
    const cwd = makeTmpAgentDir()
    const result = await runDoctor({
      cwd,
      staticChecks: [fakeCheck('alpha', 'ok')],
      fetchPluginChecks: async () => ({ kind: 'unreachable', reason: 'container down' }),
    })
    const deferred = result.initial.entries.find((e) => e.name === 'plugin-checks-deferred')
    expect(deferred?.status).toBe('info')
    expect(deferred?.message).toMatch(/container down/)
  })

  test('integrates plugin fix results into the commit', async () => {
    const cwd = makeTmpAgentDir()
    await initGitRepo(cwd)
    await mkdir(join(cwd, 'memory'), { recursive: true })
    await writeFile(join(cwd, 'memory/.placeholder'), '')

    const result = await runDoctor({
      cwd,
      fix: true,
      staticChecks: [],
      fetchPluginChecks: async () => ({
        kind: 'ok',
        checks: [
          {
            id: 'memory.daily-stream',
            pluginName: 'memory',
            checkName: 'daily-stream',
            description: "today's daily stream",
            category: 'plugin:memory',
            status: 'warning',
            message: 'missing',
            fix: { description: 'create the file', hasApply: true },
          },
        ],
      }),
      fetchPluginFix: async () => {
        const rel = 'memory/2026-05-12.md'
        writeFileSync(join(cwd, rel), '', 'utf8')
        return {
          kind: 'ok',
          payload: { ok: true, checkId: 'memory.daily-stream', summary: 'created daily stream', changedPaths: [rel] },
        }
      },
    })

    expect(result.commit?.kind).toBe('committed')
    expect(result.fixAttempts?.some((a) => a.source === 'plugin' && a.ok)).toBe(true)

    const show = await run(['git', 'log', '-1', '--name-only', '--format='], cwd)
    expect(show.stdout).toContain('memory/2026-05-12.md')
  })

  test('rejects plugin fix changedPaths that escape agentDir', async () => {
    const cwd = makeTmpAgentDir()
    await initGitRepo(cwd)
    const result = await runDoctor({
      cwd,
      fix: true,
      staticChecks: [],
      fetchPluginChecks: async () => ({
        kind: 'ok',
        checks: [
          {
            id: 'p.escape',
            pluginName: 'p',
            checkName: 'escape',
            description: 'tries to escape',
            category: 'plugin:p',
            status: 'warning',
            message: 'x',
            fix: { description: 'do it', hasApply: true },
          },
        ],
      }),
      fetchPluginFix: async () => ({
        kind: 'ok',
        payload: {
          ok: true,
          checkId: 'p.escape',
          summary: 'tried to escape',
          changedPaths: ['/etc/passwd', '../outside', 'inside.txt'],
        },
      }),
    })

    const attempt = result.fixAttempts?.[0]
    expect(attempt?.ok).toBe(true)
    if (attempt?.ok) expect(attempt.changedPaths).toEqual(['inside.txt'])
  })
})

test('buildCommitMessage formats subject + bullets', async () => {
  const { buildCommitMessage } = await import('./commit')
  const msg = buildCommitMessage([
    { name: 'agent-folder.required-dirs', source: 'static', ok: true, summary: 'created workspace/', changedPaths: [] },
    {
      name: 'memory.daily-stream-current',
      source: 'plugin',
      ok: true,
      summary: 'created memory/2026-05-12.md',
      changedPaths: [],
    },
    { name: 'foo', source: 'plugin', ok: false, reason: 'broke' },
  ])
  const lines = msg.split('\n')
  expect(lines[0]).toBe('typeclaw doctor: auto-fix 2 issues')
  expect(msg).toContain('- [static] agent-folder.required-dirs: created workspace/')
  expect(msg).toContain('- [plugin] memory.daily-stream-current: created memory/2026-05-12.md')
})

test('report.entries preserves source distinction (static vs plugin)', async () => {
  const cwd = makeTmpAgentDir()
  const result = await runDoctor({
    cwd,
    staticChecks: [fakeCheck('alpha', 'ok')],
    fetchPluginChecks: async () => ({
      kind: 'ok',
      checks: [
        {
          id: 'p.x',
          pluginName: 'p',
          checkName: 'x',
          description: 'x',
          category: 'plugin:p',
          status: 'ok',
          message: 'ok',
        },
      ],
    }),
  })
  const sources = result.initial.entries.map((e) => e.source)
  expect(sources).toEqual(['static', 'plugin'])
})

test('reaches into agent folder when invoked from a subdir of the agent', async () => {
  const cwd = makeTmpAgentDir()
  const subdir = join(cwd, 'workspace')
  mkdirSync(subdir, { recursive: true })
  const result = await runDoctor({
    cwd: subdir,
    staticChecks: [fakeCheck('alpha', 'ok')],
    fetchPluginChecks: async () => ({ kind: 'ok', checks: [] }),
  })
  expect(result.initial.hasAgentFolder).toBe(true)
  expect(result.initial.cwd).toBe(cwd)
})
