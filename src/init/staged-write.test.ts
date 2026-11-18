import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CredentialRestoreError,
  credentialStagingDir,
  discardCredentialStaging,
  publishConfigWithCredential,
  publishCredential,
  replaceFile,
  stageCredential,
} from './staged-write'

const mode = (path: string) => statSync(path).mode & 0o777

describe('replaceFile', () => {
  test.skipIf(process.platform === 'win32')('replaces the target of a symlink and keeps the link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'typeclaw-staged-target-'))
    const target = join(elsewhere, 'typeclaw.json')
    await writeFile(target, '{}\n')
    await symlink(target, join(cwd, 'typeclaw.json'))

    replaceFile(join(cwd, 'typeclaw.json'), '{"alias":["atlas"]}\n')

    expect(lstatSync(join(cwd, 'typeclaw.json')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"alias":["atlas"]}\n')
    expect(readdirSync(elsewhere)).toEqual(['typeclaw.json'])
    expect(readdirSync(cwd)).toEqual(['typeclaw.json'])
  })

  test.skipIf(process.platform === 'win32')('creates the file a dangling symlink names', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'typeclaw-staged-target-'))
    const target = join(elsewhere, 'typeclaw.json')
    await symlink(target, join(cwd, 'typeclaw.json'))

    replaceFile(join(cwd, 'typeclaw.json'), '{}\n')

    expect(lstatSync(join(cwd, 'typeclaw.json')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{}\n')
  })
})

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
      expect(readFileSync(staged.newCopy!, 'utf8')).toBe('NEW=1\n')
      expect(readFileSync(staged.priorCopy!, 'utf8')).toBe('OLD=1\n')
      expect(mode(staged.newCopy!)).toBe(0o600)
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

  test('names .env, and where a copy is kept the prior copy, when the restore fails too', async () => {
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
    if (process.platform === 'win32') {
      // Windows keeps no copy on disk, so the token has to be re-entered.
      expect((thrown as Error).message).toContain(`must be re-entered in ${env}`)
      expect(existsSync(credentialStagingDir(cwd))).toBe(false)
    } else {
      expect((thrown as Error).message).toContain(`its previous content is saved at ${staged.priorCopy}`)
      expect(readFileSync(staged.priorCopy!, 'utf8')).toBe('OLD=1\n')
      expect(existsSync(staged.newCopy!)).toBe(false)
    }
  })

  describe('on Windows', () => {
    // Exercised on every platform through the platform seam: no credential byte
    // may be written to the staging dir, whose files would carry the agent
    // folder's ACL rather than .env's.
    async function agentWithEnv() {
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-win32-'))
      await writeFile(join(cwd, '.env'), 'OLD=1\n')
      await writeFile(join(cwd, 'typeclaw.json'), '{}\n')
      return { cwd, env: join(cwd, '.env'), config: join(cwd, 'typeclaw.json'), staging: credentialStagingDir(cwd) }
    }

    function inPlace(failCalls: number[], onWrite: () => void) {
      let calls = 0
      return (path: string, content: string | Buffer) => {
        onWrite()
        calls += 1
        const fails = failCalls.includes(calls)
        writeFileSync(path, fails ? '' : content, { flag: 'w' })
        if (fails) throw new Error(`injected write failure ${calls}`)
      }
    }

    test('a successful publish writes nothing to the staging dir', async () => {
      const { cwd, env, config, staging } = await agentWithEnv()
      const stagingExisted: boolean[] = []

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        { platform: 'win32', writeInPlace: inPlace([], () => stagingExisted.push(existsSync(staging))) },
      )

      expect(result).toEqual({ ok: true })
      expect(stagingExisted).toEqual([false])
      expect(existsSync(staging)).toBe(false)
      expect(readFileSync(env, 'utf8')).toBe('OLD=1\nTOKEN=new\n')
      expect(readdirSync(cwd).sort()).toEqual(['.env', 'typeclaw.json'])
    })

    test("a failed publish's rollback restores .env from memory, writing nothing to staging", async () => {
      const { env, config, staging } = await agentWithEnv()
      const stagingExisted: boolean[] = []

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        {
          platform: 'win32',
          writeInPlace: inPlace([], () => stagingExisted.push(existsSync(staging))),
          rename: () => {
            throw new Error('injected config publish failure')
          },
        },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('typeclaw.json was not changed; .env was restored.')
      expect(stagingExisted).toEqual([false, false])
      expect(existsSync(staging)).toBe(false)
      expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
      expect(readFileSync(config, 'utf8')).toBe('{}\n')
    })

    test('a failed restore says the token must be re-entered, writing nothing to staging', async () => {
      const { env, config, staging } = await agentWithEnv()
      const stagingExisted: boolean[] = []

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        {
          platform: 'win32',
          writeInPlace: inPlace([2], () => stagingExisted.push(existsSync(staging))),
          rename: () => {
            throw new Error('injected config publish failure')
          },
        },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain(`${env} could not be restored (injected write failure 2)`)
        expect(result.reason).toContain(`must be re-entered in ${env}`)
      }
      expect(stagingExisted).toEqual([false, false])
      expect(existsSync(staging)).toBe(false)
      expect(readFileSync(config, 'utf8')).toBe('{}\n')
    })
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
