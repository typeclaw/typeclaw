import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CredentialRestoreError,
  credentialStagingDir,
  discardCredentialStaging,
  publishCredential,
  stageCredential,
} from './staged-write'

const mode = (path: string) => statSync(path).mode & 0o777

describe('credential staging', () => {
  test.skipIf(process.platform === 'win32')(
    'stages the new and prior content 0600 in a tightened owner-only dir, never beside .env',
    async () => {
      // given: a pre-existing world-readable staging dir and an existing .env
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
      const staging = credentialStagingDir(cwd)
      await mkdir(staging, { recursive: true })
      await chmod(staging, 0o755)
      await writeFile(join(cwd, '.env'), 'OLD=1\n')

      // when
      const staged = stageCredential(join(cwd, '.env'), 'NEW=1\n', staging)

      // then: both copies are owner-only in an owner-only dir, and .env is untouched
      expect(mode(staging)).toBe(0o700)
      expect(readFileSync(staged.newCopy, 'utf8')).toBe('NEW=1\n')
      expect(readFileSync(staged.priorCopy!, 'utf8')).toBe('OLD=1\n')
      expect(mode(staged.newCopy)).toBe(0o600)
      expect(mode(staged.priorCopy!)).toBe(0o600)
      expect(readdirSync(cwd).sort()).toEqual(['.env', '.typeclaw'])
      expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe('OLD=1\n')
    },
  )

  test.skipIf(process.platform === 'win32')('publishes over the same inode, keeping its mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const env = join(cwd, '.env')
    await writeFile(env, 'OLD=1\n')
    await chmod(env, 0o644)
    const inode = statSync(env).ino

    const staged = stageCredential(env, 'NEW=1\n', credentialStagingDir(cwd))
    publishCredential(staged)
    discardCredentialStaging(staged)

    expect(readFileSync(env, 'utf8')).toBe('NEW=1\n')
    expect(statSync(env).ino).toBe(inode)
    expect(mode(env)).toBe(0o644)
    expect(readdirSync(credentialStagingDir(cwd))).toEqual([])
  })

  test('puts the prior content back in place when the in-place write fails part-way', async () => {
    // given: a write that truncates .env and then fails, once
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const env = join(cwd, '.env')
    await writeFile(env, 'OLD=1\n')
    let calls = 0
    const failFirst = (path: string, content: string | Buffer) => {
      calls += 1
      writeFileSync(path, calls === 1 ? '' : content, { flag: 'w' })
      if (calls === 1) throw new Error('disk full')
    }

    // when/then: the publish fails with the write's error and .env is as before
    const staged = stageCredential(env, 'NEW=1\n', credentialStagingDir(cwd))
    expect(() => publishCredential(staged, failFirst)).toThrow('disk full')
    expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
  })

  test('names .env and the kept prior copy when the restore fails too', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const env = join(cwd, '.env')
    await writeFile(env, 'OLD=1\n')
    const alwaysFail = () => {
      throw new Error('read-only filesystem')
    }

    const staged = stageCredential(env, 'NEW=1\n', credentialStagingDir(cwd))
    let thrown: unknown
    try {
      publishCredential(staged, alwaysFail)
    } catch (error) {
      thrown = error
    }
    discardCredentialStaging(staged, thrown instanceof CredentialRestoreError)

    expect(thrown).toBeInstanceOf(CredentialRestoreError)
    expect((thrown as Error).message).toContain(`${env} could not be restored`)
    expect((thrown as Error).message).toContain(`its previous content is saved at ${staged.priorCopy}`)
    expect(readFileSync(staged.priorCopy!, 'utf8')).toBe('OLD=1\n')
    expect(existsSync(staged.newCopy)).toBe(false)
  })

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
      expect(() => stageCredential(join(cwd, '.env'), 'TOKEN=secret\n', credentialStagingDir(cwd))).toThrow(
        'refusing to stage credentials',
      )
      expect(readdirSync(elsewhere)).toEqual([])
      expect(existsSync(join(cwd, '.env'))).toBe(false)
    },
  )
})
