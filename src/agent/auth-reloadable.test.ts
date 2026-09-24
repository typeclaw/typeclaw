import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { getAuthFor, invalidateProviderAuthCache } from './auth'
import { createProviderAuthReloadable } from './auth-reloadable'

describe('createProviderAuthReloadable', () => {
  let prevFireworks: string | undefined
  let prevNodeEnv: string | undefined
  let prevCwd: string
  let cwd: string

  beforeEach(async () => {
    prevFireworks = process.env.FIREWORKS_API_KEY
    prevNodeEnv = process.env.NODE_ENV
    delete process.env.FIREWORKS_API_KEY
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-auth-reload-'))
    prevCwd = process.cwd()
    process.chdir(cwd)
    invalidateProviderAuthCache()
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )
    reloadConfig(cwd)
  })

  afterEach(async () => {
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(prevCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test('exposes scope=providers with a description', () => {
    const reloadable = createProviderAuthReloadable()
    expect(reloadable.scope).toBe('providers')
    expect(reloadable.description.length).toBeGreaterThan(0)
  })

  test('re-resolves the rotated value from secrets.json after reload', async () => {
    // The on-disk secrets.json (bind-mounted live in the container) is the
    // credential source under test, so bypass getAuthFor's NODE_ENV=test
    // dummy-key branch, which only fires when no api-key env var is set.
    delete process.env.NODE_ENV
    await writeSecretsFireworksKey('fw_first')

    const before = await getAuthFor('fireworks')
    expect((await before.modelRuntime.getAuth('fireworks'))?.auth.apiKey).toBe('fw_first')

    // given: the credential is rotated on disk (e.g. `typeclaw provider set`)
    await writeSecretsFireworksKey('fw_rotated')

    // when: the providers reloadable runs (what `typeclaw reload` triggers)
    const result = await createProviderAuthReloadable().reload()

    // then: the next resolution reads the rotated value from the file
    expect(result.ok).toBe(true)
    const after = await getAuthFor('fireworks')
    expect(after).not.toBe(before)
    expect((await after.modelRuntime.getAuth('fireworks'))?.auth.apiKey).toBe('fw_rotated')
  })

  async function writeSecretsFireworksKey(value: string): Promise<void> {
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value } } },
        channels: {},
      }),
    )
  }

  test('fires onProviderAuthChanged after invalidating so live sessions can be torn down', async () => {
    process.env.FIREWORKS_API_KEY = 'fw_test'
    getAuthFor('fireworks')

    const calls: string[] = []
    const result = await createProviderAuthReloadable({
      onProviderAuthChanged: () => {
        calls.push('changed')
      },
    }).reload()

    expect(result.ok).toBe(true)
    expect(calls).toEqual(['changed'])
  })

  test('reports success even when no provider auth was cached yet', async () => {
    const result = await createProviderAuthReloadable().reload()
    expect(result.ok).toBe(true)
  })
})
