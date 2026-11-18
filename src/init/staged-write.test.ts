import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { credentialStagingDir, replaceFile, stageReplacement } from './staged-write'

const mode = (path: string) => statSync(path).mode & 0o777

describe('credential staging', () => {
  test.skipIf(process.platform === 'win32')(
    'stages a credential owner-only in the masked staging dir, not beside it',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))

      const staged = stageReplacement(join(cwd, '.env'), 'TOKEN=secret\n', credentialStagingDir(cwd))

      expect(dirname(staged.temp)).toBe(join(cwd, '.typeclaw', 'credential-staging'))
      expect(mode(staged.temp)).toBe(0o600)
      expect(mode(dirname(staged.temp))).toBe(0o700)
      expect(readFileSync(staged.temp, 'utf8')).toBe('TOKEN=secret\n')
      expect(readdirSync(cwd)).toEqual(['.typeclaw'])
    },
  )

  test.skipIf(process.platform === 'win32')(
    'tightens a 0755 staging dir and keeps a 0644 .env copy 0600 until it is published',
    async () => {
      // given: a pre-existing world-readable staging dir and a 0644 .env
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
      const staging = credentialStagingDir(cwd)
      await mkdir(staging, { recursive: true })
      await chmod(staging, 0o755)
      const env = join(cwd, '.env')
      await writeFile(env, 'OLD=1\n')
      await chmod(env, 0o644)
      let beforePublish: { dir: number; file: number } | undefined

      // when: the .env is replaced through the staging dir
      replaceFile(env, 'NEW=1\n', {
        credentialStagingDir: staging,
        rename: (from, to) => {
          beforePublish = { dir: mode(dirname(from)), file: mode(from) }
          renameSync(from, to)
        },
      })

      // then: nothing staged was readable by others, and the published file keeps its mode
      expect(beforePublish).toEqual({ dir: 0o700, file: 0o600 })
      expect(readFileSync(env, 'utf8')).toBe('NEW=1\n')
      expect(mode(env)).toBe(0o644)
      expect(readdirSync(staging)).toEqual([])
    },
  )

  test.skipIf(process.platform === 'win32')(
    'refuses to stage a credential through a staging path it cannot trust',
    async () => {
      // given: the staging path is a symlink to a directory others can read
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
      const elsewhere = await mkdtemp(join(tmpdir(), 'typeclaw-staged-elsewhere-'))
      await chmod(elsewhere, 0o755)
      await mkdir(join(cwd, '.typeclaw'))
      await symlink(elsewhere, credentialStagingDir(cwd))

      // when/then: staging fails before writing the credential anywhere
      expect(() =>
        replaceFile(join(cwd, '.env'), 'TOKEN=secret\n', { credentialStagingDir: credentialStagingDir(cwd) }),
      ).toThrow('refusing to stage credentials')
      expect(readdirSync(elsewhere)).toEqual([])
      expect(existsSync(join(cwd, '.env'))).toBe(false)
    },
  )
})
