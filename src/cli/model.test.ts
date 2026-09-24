import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { scaffold, writeSecrets } from '@/init'
import type { ModelOption } from '@/init/models-dev'

import { parseThinkingArg, resolveExplicitRef, resolveShorthandRef, shouldPromptThinkingLevel } from './model'

const CLI_ENTRY = join(import.meta.dir, 'index.ts')
const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('resolveExplicitRef carries catalog metadata for non-interactive set/add', () => {
  function catalogWith(option: ModelOption): () => Promise<{ options: ModelOption[] }> {
    return async () => ({ options: [option] })
  }

  const liveOption: ModelOption = {
    ref: 'fireworks/brand-new-model',
    providerId: 'fireworks',
    providerName: 'Fireworks',
    modelId: 'brand-new-model',
    modelName: 'Brand New Model',
    reasoning: true,
    contextWindow: 256000,
    maxTokens: 32000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    curated: false,
    supportsVision: true,
  }

  test('curated ref persists no custom metadata (resolves from KNOWN_PROVIDERS)', async () => {
    const picked = await resolveExplicitRef('openai/gpt-5.4-nano', catalogWith(liveOption))
    expect(picked.ref).toBe('openai/gpt-5.4-nano')
    expect(picked.meta).toBeUndefined()
  })

  test('non-curated ref found in the catalog carries its metadata', async () => {
    const picked = await resolveExplicitRef('fireworks/brand-new-model', catalogWith(liveOption))
    expect(picked.ref).toBe('fireworks/brand-new-model')
    expect(picked.meta).toEqual({
      name: 'Brand New Model',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 256000,
      maxTokens: 32000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    })
  })

  test('non-curated ref missing from the catalog persists the ref without metadata', async () => {
    const picked = await resolveExplicitRef('fireworks/unknown-model', catalogWith(liveOption))
    expect(picked.ref).toBe('fireworks/unknown-model')
    expect(picked.meta).toBeUndefined()
  })

  test('an unknown closed-provider (openai-codex) ref is forward-compatible: persisted via the warning path, not rejected', async () => {
    // given: a Codex ref that misses our shipped registry but may be a real, newly-shipped model
    // when: resolving it for a non-interactive set/add (catalog miss, like any non-curated ref)
    const picked = await resolveExplicitRef('openai-codex/gpt-5.6-sol', catalogWith(liveOption))
    // then: it resolves (no throw) so the registry snapshot can't block a real model; the
    // backend's own 400 is what classifies a truly-unsupported id at runtime
    expect(picked.ref).toBe('openai-codex/gpt-5.6-sol')
    expect(picked.meta).toBeUndefined()
  })

  test('a curated closed-provider ref resolves from KNOWN_PROVIDERS (no catalog, no metadata)', async () => {
    const picked = await resolveExplicitRef('openai-codex/gpt-5.5', catalogWith(liveOption))
    expect(picked.ref).toBe('openai-codex/gpt-5.5')
    expect(picked.meta).toBeUndefined()
  })
})

describe('typeclaw model set/add reject a definitely-invalid ref via the real CLI without mutating config', () => {
  let cwd: string
  const ORIGINAL_REF = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'
  // Shape-invalid for a closed OAuth provider — `isModelRef` rejects it, so the
  // mutation is refused BEFORE any write. Exercises the real set/add command
  // paths (exit code, stderr, on-disk config) the direct resolveExplicitRef unit
  // tests can't cover.
  const INVALID_REF = 'openai-codex/'

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-invalid-ref-'))
    await scaffold(cwd, { model: ORIGINAL_REF })
    await writeSecrets(cwd, { model: ORIGINAL_REF, apiKey: 'fw_test' })
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runModel(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', ...args, '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, stderr }
  }

  async function readRawConfig(): Promise<string> {
    return readFile(join(cwd, 'typeclaw.json'), 'utf8')
  }

  test('`model set` exits non-zero, prints an actionable line, and leaves typeclaw.json unchanged', async () => {
    const before = await readRawConfig()
    const { exitCode, stderr } = await runModel(['set', 'default', INVALID_REF])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unknown model/)
    expect(stderr).toContain('model list --available')
    expect(await readRawConfig()).toBe(before)
  })

  test('`model add` exits non-zero, prints an actionable line, and leaves typeclaw.json unchanged', async () => {
    const before = await readRawConfig()
    const { exitCode, stderr } = await runModel(['add', 'fast', INVALID_REF])
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unknown model/)
    expect(await readRawConfig()).toBe(before)
  })
})

describe('parseThinkingArg', () => {
  test('accepts every supported level, case-insensitively', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(parseThinkingArg(level.toUpperCase())).toEqual({ ok: true, level })
    }
  })

  test('treats default/unset/none as a clear (undefined level)', () => {
    expect(parseThinkingArg('default')).toEqual({ ok: true, level: undefined })
    expect(parseThinkingArg('unset')).toEqual({ ok: true, level: undefined })
    expect(parseThinkingArg('none')).toEqual({ ok: true, level: undefined })
  })

  test('rejects an unknown value with a helpful reason', () => {
    const result = parseThinkingArg('turbo')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/off, minimal, low, medium, high, xhigh/)
  })
})

describe('resolveShorthandRef', () => {
  test('treats a single ref-shaped positional as the default-profile shorthand', () => {
    expect(resolveShorthandRef('openai/gpt-5.4-nano', undefined)).toBe('openai/gpt-5.4-nano')
  })

  test('a named profile that is not a ref is NOT shorthand', () => {
    expect(resolveShorthandRef('fast', undefined)).toBeUndefined()
    expect(resolveShorthandRef('default', undefined)).toBeUndefined()
  })

  test('an explicit two-positional `<profile> <ref>` is not shorthand', () => {
    expect(resolveShorthandRef('fast', 'openai/gpt-5.4-nano')).toBeUndefined()
  })
})

describe('shouldPromptThinkingLevel', () => {
  test('`model set fast` (named profile, ref picked interactively) still offers the prompt', () => {
    // given: `fast` is a named profile, not shorthand, and no ref/flag was supplied
    const shorthandRef = resolveShorthandRef('fast', undefined)
    // then: the interactive ref pick must keep offering the thinking prompt
    expect(shouldPromptThinkingLevel(shorthandRef, undefined, undefined)).toBe(true)
  })

  test('bare `model set` (fully interactive) offers the prompt', () => {
    expect(shouldPromptThinkingLevel(undefined, undefined, undefined)).toBe(true)
  })

  test('the `model set <ref>` shorthand does NOT prompt (ref came from the command line)', () => {
    const shorthandRef = resolveShorthandRef('openai/gpt-5.4-nano', undefined)
    expect(shouldPromptThinkingLevel(shorthandRef, undefined, undefined)).toBe(false)
  })

  test('an explicit `<profile> <ref>` does NOT prompt', () => {
    expect(shouldPromptThinkingLevel(undefined, 'openai/gpt-5.4-nano', undefined)).toBe(false)
  })

  test('an explicit --thinking flag does NOT prompt (level came from the flag)', () => {
    expect(shouldPromptThinkingLevel(undefined, undefined, 'high')).toBe(false)
  })
})

describe('typeclaw model list survives broken typeclaw.json', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-list-broken-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runModelList(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'list'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  test('exits 0 and renders the default profile when typeclaw.json is malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), 'NOT JSON AT ALL {{{')
    const { exitCode, stdout, stderr } = await runModelList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    expect(stdout).toContain('default')
    expect(stderr).toMatch(/not valid JSON/)
    expect(stderr).toMatch(/diagnostic commands still work/)
  })

  test('exits 0 and renders the default profile when typeclaw.json is schema-invalid', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const { exitCode, stdout, stderr } = await runModelList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    expect(stdout).toContain('default')
    expect(stderr).toMatch(/typeclaw\.json is invalid/)
  })
})

describe('typeclaw model list migrates a pre-0.20.0 v1 secrets.json on first host invocation', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-list-v1-secrets-'))
    await symlink(join(REPO_ROOT, 'node_modules'), join(cwd, 'node_modules'), 'dir')
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({}))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  const runModelList = () => runCli(['model', 'list'])

  const writeV1Secrets = () =>
    writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 1,
        llm: { fireworks: { type: 'api_key', key: 'fpk_test' } },
        channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'dtok' } },
      }),
    )

  test('exits 0 and rewrites secrets.json to the v2 envelope on disk', async () => {
    await writeV1Secrets()

    const { exitCode, stdout } = await runModelList()

    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    const migrated = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(migrated.version).toBe(2)
    expect(migrated.providers.fireworks).toEqual({ type: 'api_key', key: { value: 'fpk_test' } })
    expect(migrated.channels['discord-bot']).toEqual({ token: { value: 'dtok' } })
  })

  test('leaves an already-v2 secrets.json untouched', async () => {
    const v2 = { version: 2, providers: {}, channels: {} }
    await writeFile(join(cwd, 'secrets.json'), JSON.stringify(v2))

    const { exitCode } = await runModelList()

    expect(exitCode).toBe(0)
    const after = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(after).toEqual(v2)
  })

  test('does not migrate or warn on informational --help invocations', async () => {
    await writeV1Secrets()

    const { exitCode, stderr } = await runCli(['--help'])

    expect(exitCode).toBe(0)
    expect(stderr).not.toMatch(/migration/i)
    const untouched = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(untouched.version).toBe(1)
  })
})

describe('typeclaw model set validates the thinking level before mutating the profile', () => {
  let cwd: string
  const ORIGINAL_REF = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-set-thinking-'))
    await scaffold(cwd, { model: ORIGINAL_REF })
    await writeSecrets(cwd, { model: ORIGINAL_REF, apiKey: 'fw_test' })
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function readProfile(profile: string): Promise<unknown> {
    const parsed = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as {
      models?: Record<string, unknown>
    }
    return parsed.models?.[profile]
  }

  // Regression: an invalid --thinking must abort BEFORE setProfile writes, so
  // the profile is never left mutated by a command that reports failure.
  test('an invalid --thinking aborts without writing the profile', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'set', 'default', 'openai/gpt-5.4-nano', '--thinking', 'bogus', '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Invalid --thinking/)
    expect(await readProfile('default')).toBe(ORIGINAL_REF)
  })

  test('`model set <ref>` updates the default profile without repeating the profile name', async () => {
    // given
    expect(await readProfile('default')).toBe(ORIGINAL_REF)

    // when
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'set', 'openai/gpt-5.4-nano', '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const exitCode = await proc.exited

    // then
    expect(exitCode).toBe(0)
    expect(await readProfile('default')).toBe('openai/gpt-5.4-nano')
  })

  test('a valid --thinking writes the profile as a rich object with its per-profile level', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'set', 'fast', 'openai/gpt-5.4-nano', '--thinking', 'high', '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(await readProfile('fast')).toEqual({ models: 'openai/gpt-5.4-nano', thinkingLevel: 'high' })
    // The default profile is untouched and stays in its bare-ref form.
    expect(await readProfile('default')).toBe(ORIGINAL_REF)
  })

  test('`--thinking default` clears a profile`s existing level (regression: explicit clear must win)', async () => {
    const set = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'set', 'fast', 'openai/gpt-5.4-nano', '--thinking', 'high', '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    expect(await set.exited).toBe(0)
    expect(await readProfile('fast')).toEqual({ models: 'openai/gpt-5.4-nano', thinkingLevel: 'high' })

    const clear = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'set', 'fast', 'openai/gpt-5.4-nano', '--thinking', 'default', '--force'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    expect(await clear.exited).toBe(0)
    expect(await readProfile('fast')).toBe('openai/gpt-5.4-nano')
  })

  test('`model thinking <level>` sets the default profile`s level without changing its ref', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'thinking', 'medium'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(await readProfile('default')).toEqual({ models: ORIGINAL_REF, thinkingLevel: 'medium' })
    const parsed = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { thinkingLevel?: unknown }
    // No top-level global field is ever written.
    expect(parsed.thinkingLevel).toBeUndefined()
  })

  test('`model thinking <bogus>` exits non-zero without writing', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'thinking', 'bogus'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Invalid --thinking/)
    expect(await readProfile('default')).toBe(ORIGINAL_REF)
  })
})
