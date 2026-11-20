import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, configSchema, FIELD_EFFECTS, getConfig } from './config'
import { createConfigReloadable } from './reloadable'

const VALID_MODEL_A = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

// Windows has no FIFOs (mkfifo), which these tests use to hold a bash call or a
// process at a known point, or to stand in for a non-regular config file.
const fifosUnavailable = process.platform === 'win32'

describe('createConfigReloadable', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-reload-config-'))
  })

  afterEach(async () => {
    __resetConfigForTesting()
    await rm(cwd, { recursive: true, force: true })
  })

  test.skipIf(fifosUnavailable)(
    'a FIFO at typeclaw.json fails the reload promptly and keeps the live config',
    async () => {
      // given: a live config, then typeclaw.json replaced by a FIFO nobody writes to
      await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
      const reloadable = createConfigReloadable({ cwd })
      expect((await reloadable.reload()).ok).toBe(true)
      await rm(join(cwd, 'typeclaw.json'))
      expect(await Bun.spawn(['mkfifo', join(cwd, 'typeclaw.json')]).exited).toBe(0)

      // when: the config reloads (a blocking open would hang here until the test times out)
      const result = await reloadable.reload()

      // then: the reload fails without opening the FIFO and the live config stands
      expect(result.ok).toBe(false)
      expect(getConfig().port).toBe(9001)
    },
  )

  test('atomicity: invalid JSON leaves the live config untouched', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
    const reloadable = createConfigReloadable({ cwd })

    const first = await reloadable.reload()
    expect(first.ok).toBe(true)
    expect(getConfig().port).toBe(9001)

    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const second = await reloadable.reload()

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('not valid JSON')
    expect(getConfig().port).toBe(9001)
  })

  test('atomicity: mount path that does not exist on host fails reload and leaves live config untouched', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, mounts: [] }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9001,
        mounts: [{ name: 'gone', path: join(cwd, 'definitely-missing') }],
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('mount "gone"')
      expect(result.reason).toContain('does not exist')
    }
    expect(getConfig().port).toBe(9001)
  })

  test('skipMountValidation: container-side reload ignores host-only mount paths', async () => {
    // given: a config whose mount points at an absolute host path that does
    // not resolve inside the container's filesystem (simulated by referencing
    // a path under cwd that we never create).
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, mounts: [] }))
    const reloadable = createConfigReloadable({ cwd, skipMountValidation: true })
    await reloadable.reload()

    const missingPath = join(cwd, 'host-only-path')
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9001,
        mounts: [{ name: 'host-only', path: missingPath }],
      }),
    )

    // when: a container-side reload runs
    const result = await reloadable.reload()

    // then: it succeeds and reports `mounts` as restart-required even though
    // the host path does not exist on the local filesystem.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as { restartRequired: { path: string }[] }
    expect(diff.restartRequired.map((c) => c.path)).toEqual(['mounts'])
  })

  test('skipMountValidation defaults to false: host-side behavior unchanged', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, mounts: [] }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9001,
        mounts: [{ name: 'gone', path: join(cwd, 'still-missing') }],
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('mount "gone"')
  })

  test('skipMountValidation: schema errors still fail even when mount checks are skipped', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
    const reloadable = createConfigReloadable({ cwd, skipMountValidation: true })
    await reloadable.reload()

    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const result = await reloadable.reload()

    expect(result.ok).toBe(false)
    expect(getConfig().port).toBe(9001)
  })

  test('atomicity: schema-invalid config leaves the live config untouched', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001 }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'not-a-known-model' }, port: 9999 }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(false)
    expect(getConfig().port).toBe(9001)
  })

  test('field fence: port and mounts changes land in `restartRequired`', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, port: 9001, mounts: [] }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    const mountDir = join(cwd, 'projects')
    await mkdir(mountDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9002,
        mounts: [{ name: 'projects', path: mountDir }],
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: { path: string }[]
      ignored: unknown[]
    }
    const paths = diff.restartRequired.map((c) => c.path).sort()
    expect(paths).toEqual(['mounts', 'port'])
  })

  test('field fence: docker.file changes land in `restartRequired`', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, docker: { file: { append: ['RUN echo old'] } } }),
    )
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, docker: { file: { append: ['RUN echo new'] } } }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: { path: string }[]
      ignored: unknown[]
    }
    expect(diff.restartRequired.map((c) => c.path)).toEqual(['docker.file'])
  })

  test('field fence: git.ignore changes land in `restartRequired`', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, git: { ignore: { append: ['scratch/'] } } }),
    )
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, git: { ignore: { append: ['scratch/', '*.local.log'] } } }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: { path: string }[]
      ignored: unknown[]
    }
    expect(diff.restartRequired.map((c) => c.path)).toEqual(['git.ignore'])
  })

  test('git.user applies on reload and asks the runtime to re-apply its git identity', async () => {
    // given
    let refreshed = 0
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A }))
    const reloadable = createConfigReloadable({ cwd, onGitUserChanged: () => refreshed++ })
    await reloadable.reload()

    // when: git.user is added
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, git: { user: { name: '현무', email: 'hyeonmu@typeclaw.local' } } }),
    )
    const added = await reloadable.reload()

    // then
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect((added.details as { applied: { path: string }[] }).applied.map((c) => c.path)).toEqual(['git.user'])
    expect(refreshed).toBe(1)

    // when / then: removing it re-applies too, while an unrelated change does not
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A }))
    await reloadable.reload()
    expect(refreshed).toBe(2)
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, alias: ['atlas'] }))
    await reloadable.reload()
    expect(refreshed).toBe(2)
  })

  test('field fence: sandbox.apparmorProfile changes land in `restartRequired`', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, sandbox: { apparmorProfile: 'unconfined' } }),
    )
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, sandbox: { apparmorProfile: 'typeclaw-bwrap' } }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as { restartRequired: { path: string }[] }
    expect(diff.restartRequired.map((change) => change.path)).toEqual(['sandbox'])
  })

  test('field fence: $schema change is ignored', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, $schema: './a.json' }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, $schema: './b.json' }))
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: unknown[]
      ignored: { path: string }[]
    }
    expect(diff.applied).toHaveLength(0)
    expect(diff.restartRequired).toHaveLength(0)
    expect(diff.ignored.map((c) => c.path)).toEqual(['$schema'])
  })

  test('field fence: host-only logs changes are ignored', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, logs: { retentionDays: 14 } }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: VALID_MODEL_A, logs: { retentionDays: 30 } }))
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: unknown[]
      restartRequired: unknown[]
      ignored: { path: string }[]
    }
    expect(diff.applied).toHaveLength(0)
    expect(diff.restartRequired).toHaveLength(0)
    expect(diff.ignored.map((change) => change.path)).toEqual(['logs'])
  })

  test('field fence: customModels changes land in `applied`', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-6-live' } }))
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'openai/gpt-6-live' },
        customModels: { 'openai/gpt-6-live': { name: 'GPT-6 Live', reasoning: true } },
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const diff = result.details as {
      applied: { path: string }[]
      restartRequired: unknown[]
      ignored: unknown[]
    }
    expect(diff.applied.map((c) => c.path)).toEqual(['customModels'])
    expect(diff.restartRequired).toHaveLength(0)
    expect(diff.ignored).toHaveLength(0)
  })

  test('summary string reports counts in each bucket', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: VALID_MODEL_A, port: 9001, $schema: './a.json', mounts: [] }),
    )
    const reloadable = createConfigReloadable({ cwd })
    await reloadable.reload()

    const mountDir = join(cwd, 'data')
    await mkdir(mountDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        model: VALID_MODEL_A,
        port: 9002,
        $schema: './b.json',
        mounts: [{ name: 'data', path: mountDir }],
      }),
    )
    const result = await reloadable.reload()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // mounts and port both restart-required; $schema ignored. No `applied` change since model unchanged.
    expect(result.summary).toBe('0 applied, 2 restart-required, 1 ignored')
  })
})

describe('FIELD_EFFECTS coverage', () => {
  test('every reachable runtime path in configSchema has a FIELD_EFFECTS entry', () => {
    const parsed = configSchema.parse({}) as Record<string, unknown>
    const schemaPaths = enumeratePaths(parsed)
    const classified = new Set(Object.keys(FIELD_EFFECTS))
    const missing = schemaPaths.filter((p) => !classified.has(p))
    expect(missing).toEqual([])
  })

  test('every FIELD_EFFECTS entry is reachable from a parsed default config or is a known optional path', () => {
    const parsed = configSchema.parse({ $schema: './x.json' }) as Record<string, unknown>
    const schemaPaths = new Set(enumeratePaths(parsed))
    const stale = Object.keys(FIELD_EFFECTS).filter((p) => !schemaPaths.has(p) && !KNOWN_OPTIONAL_PATHS.has(p))
    expect(stale).toEqual([])
  })
})

function enumeratePaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    const value = obj[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && shouldRecurse(path)) {
      out.push(...enumeratePaths(value as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out
}

function shouldRecurse(path: string): boolean {
  return path === 'docker' || path === 'git' || path === 'permissions'
}

// `roles.match` / `roles.permissions` are optional virtual paths and `git.user`
// / `git.remotes` are optional blocks: absent from a bare-`{}` parse (so they
// never show up in the enumerated default-config paths) but classified in
// FIELD_EFFECTS.
const KNOWN_OPTIONAL_PATHS = new Set<string>(['roles.match', 'roles.permissions', 'git.user', 'git.remotes'])
