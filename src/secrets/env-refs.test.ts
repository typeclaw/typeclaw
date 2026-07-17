import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectSecretEnvRefs, SecretEnvRefsError } from './env-refs'

async function withAgentDir(secrets: unknown, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'env-refs-'))
  try {
    if (secrets !== undefined) await writeFile(join(dir, 'secrets.json'), JSON.stringify(secrets))
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('collectSecretEnvRefs', () => {
  test('collects provider key env refs', async () => {
    await withAgentDir({ version: 2, providers: { openai: { key: { env: 'PRODUCTION' } } } }, async (dir) => {
      expect(collectSecretEnvRefs(dir)).toEqual(['PRODUCTION'])
    })
  })

  test('collects channel field env refs at any depth', async () => {
    await withAgentDir(
      {
        version: 2,
        channels: {
          'slack-bot': { botToken: { env: 'MY_SLACK' }, appToken: { value: 'x' } },
          github: { app: { privateKey: { env: 'GH_PK' } } },
        },
      },
      async (dir) => {
        const refs = collectSecretEnvRefs(dir)
        expect(refs).toContain('MY_SLACK')
        expect(refs).toContain('GH_PK')
      },
    )
  })

  test('returns [] when secrets.json is absent', async () => {
    await withAgentDir(undefined, async (dir) => {
      expect(collectSecretEnvRefs(dir)).toEqual([])
    })
  })

  test('returns [] when secrets.json is empty or whitespace-only', async () => {
    await withAgentDir(undefined, async (dir) => {
      await writeFile(join(dir, 'secrets.json'), '   \n')
      expect(collectSecretEnvRefs(dir)).toEqual([])
    })
  })

  test('FAILS CLOSED (throws) on a non-empty malformed secrets.json', async () => {
    await withAgentDir(undefined, async (dir) => {
      await writeFile(join(dir, 'secrets.json'), '{ broken')
      expect(() => collectSecretEnvRefs(dir)).toThrow(SecretEnvRefsError)
    })
  })

  test('FAILS CLOSED (throws) when secrets.json is unreadable (non-ENOENT)', async () => {
    await withAgentDir(undefined, async (dir) => {
      // A directory at the secrets.json path yields EISDIR on read, not ENOENT.
      await mkdir(join(dir, 'secrets.json'))
      expect(() => collectSecretEnvRefs(dir)).toThrow(SecretEnvRefsError)
    })
  })

  test('ignores non-string and empty env values', async () => {
    await withAgentDir({ providers: { openai: { key: { env: '' } }, x: { key: { env: 123 } } } }, async (dir) => {
      expect(collectSecretEnvRefs(dir)).toEqual([])
    })
  })
})
