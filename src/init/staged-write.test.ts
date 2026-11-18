import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { credentialStagingDir, replaceFile, stageReplacement } from './staged-write'

describe('stageReplacement', () => {
  test.skipIf(process.platform === 'win32')(
    'stages a credential owner-only in the masked staging dir, not beside it',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))

      const staged = stageReplacement(join(cwd, '.env'), 'TOKEN=secret\n', credentialStagingDir(cwd))

      expect(dirname(staged)).toBe(join(cwd, '.typeclaw', 'credential-staging'))
      expect(statSync(staged).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(staged)).mode & 0o777).toBe(0o700)
      expect(readFileSync(staged, 'utf8')).toBe('TOKEN=secret\n')
      expect(readdirSync(cwd)).toEqual(['.typeclaw'])
    },
  )

  test.skipIf(process.platform === 'win32')('keeps the destination mode on a replaced credential', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const env = join(cwd, '.env')
    await writeFile(env, 'OLD=1\n')
    await chmod(env, 0o640)

    replaceFile(env, 'NEW=1\n', { credentialStagingDir: credentialStagingDir(cwd) })

    expect(readFileSync(env, 'utf8')).toBe('NEW=1\n')
    expect(statSync(env).mode & 0o777).toBe(0o640)
    expect(readdirSync(credentialStagingDir(cwd))).toEqual([])
  })
})
