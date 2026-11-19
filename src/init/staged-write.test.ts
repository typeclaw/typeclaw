import { describe, expect, test } from 'bun:test'
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareConfigWriteSync, readConfigCommitSync } from '@/config/config-commits'
import { failingConfigPublish, INJECTED_CONFIG_PUBLISH_FAILURE } from '@/test-helpers/config-publish-seams'

import {
  CredentialRestoreError,
  credentialStagingDir,
  discardCredentialStaging,
  publishConfigWithCredential,
  publishCredential,
  stageCredential,
} from './staged-write'

const mode = (path: string) => statSync(path).mode & 0o777

// What a file's access policy hangs off: the same file object (so its ACLs and
// group stay with it), owner, group and mode.
const identity = (path: string) => {
  const stats = statSync(path)
  return { ino: stats.ino, uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o7777 }
}

// A group the test user belongs to other than the one a new file in a fresh
// temp dir gets, so a config can be given a group its directory does not have.
const otherGroup = (() => {
  if (process.platform === 'win32' || typeof process.getgroups !== 'function') return undefined
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-staged-groups-'))
  try {
    const dirGroup = statSync(dir).gid
    return process.getgroups().find((gid) => gid !== dirGroup)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('config publication keeps the file object', () => {
  // A new inode would take its directory's default group and ACLs; writing in
  // place keeps the config's own (it can hold inline credentials).
  async function agentWithConfig() {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-config-'))
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    await writeFile(config, '{}\n')
    await chmod(config, 0o640)
    await writeFile(env, 'OLD=1\n')
    return { cwd, config, env }
  }

  test("keeps typeclaw.json's inode, owner, group and mode when it publishes", async () => {
    const { config } = await agentWithConfig()
    const before = identity(config)

    const result = publishConfigWithCredential(config, '{"mcpServers":{}}\n', undefined)

    expect(result).toEqual({ ok: true })
    expect(identity(config)).toEqual(before)
    expect(readFileSync(config, 'utf8')).toBe('{"mcpServers":{}}\n')
  })

  test("keeps both files' identity and bytes when a publish is rolled back", async () => {
    // given: a config and .env, and a config publication that fails part-way
    const { cwd, config, env } = await agentWithConfig()
    const before = { config: identity(config), env: identity(env) }

    // when
    const result = publishConfigWithCredential(
      config,
      '{"mcpServers":{}}\n',
      { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: credentialStagingDir(cwd) },
      failingConfigPublish(),
    )

    // then: it failed there, and both are the same file objects with the same bytes
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(`${INJECTED_CONFIG_PUBLISH_FAILURE}. typeclaw.json was not changed`)
    expect({ config: identity(config), env: identity(env) }).toEqual(before)
    expect(readFileSync(config, 'utf8')).toBe('{}\n')
    expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
  })

  test.skipIf(otherGroup === undefined)(
    'keeps a config group its directory does not have, on publish and on rollback',
    async () => {
      // given: typeclaw.json owned by a group other than its directory's
      const { cwd, config, env } = await agentWithConfig()
      chownSync(config, process.getuid!(), otherGroup!)
      expect(statSync(cwd).gid).not.toBe(otherGroup)

      // when: one publish succeeds and one is rolled back
      expect(publishConfigWithCredential(config, '{"alias":["atlas"]}\n', undefined)).toEqual({ ok: true })
      const failed = publishConfigWithCredential(
        config,
        '{}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: credentialStagingDir(cwd) },
        failingConfigPublish(),
      )

      // then: the config keeps that group throughout
      expect(failed.ok).toBe(false)
      expect(statSync(config).gid).toBe(otherGroup!)
      expect(readFileSync(config, 'utf8')).toBe('{"alias":["atlas"]}\n')
    },
  )
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

  test('reports a rollback failure, not an empty .env, when emptying a created .env fails', async () => {
    // given: no .env yet; the write into the new .env stops after part of the
    // token, and emptying it again fails too
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-'))
    const env = join(cwd, '.env')
    await writeFile(join(cwd, 'typeclaw.json'), '{}\n')
    let calls = 0
    const writeInPlace = (path: string, _content: string | Buffer) => {
      calls += 1
      if (calls === 1) {
        writeFileSync(path, 'TOKEN=par', { flag: 'w' })
        throw new Error('disk full')
      }
      throw new Error('read-only filesystem')
    }

    // when
    const result = publishConfigWithCredential(
      join(cwd, 'typeclaw.json'),
      '{}\n',
      { path: env, content: 'TOKEN=partial-then-lost\n', stagingDir: credentialStagingDir(cwd) },
      { writeInPlace },
    )

    // then: the failure names .env and says to empty it in place, never that it
    // was left empty; the partial bytes are still there
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain(
      `${env} could not be restored (read-only filesystem) after a failed write (disk full)`,
    )
    expect(result.reason).toContain(`Empty ${env} in place before retrying; do not delete it`)
    expect(result.reason).not.toContain('left empty')
    expect(readFileSync(env, 'utf8')).toBe('TOKEN=par')
    expect(readFileSync(join(cwd, 'typeclaw.json'), 'utf8')).toBe('{}\n')
  })

  describe('on Windows', () => {
    // Exercised on every platform through the platform seam: no credential byte
    // is written to the staging dir, whose files would carry the folder's ACL
    // rather than .env's (typeclaw.json is written in place on every platform).
    async function agentWithEnv() {
      const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-win32-'))
      await writeFile(join(cwd, '.env'), 'OLD=1\n')
      await writeFile(join(cwd, 'typeclaw.json'), '{}\n')
      return { cwd, env: join(cwd, '.env'), config: join(cwd, 'typeclaw.json'), staging: credentialStagingDir(cwd) }
    }

    // An in-place writer that records the agent folder's entries on each call and
    // fails (truncating first, like a write that dies part-way) on the listed
    // calls for each file.
    function inPlace(cwd: string, fail: { config?: number[]; env?: number[] } = {}) {
      const calls = { config: 0, env: 0 }
      const entriesSeen: string[][] = []
      const write = (path: string, content: string | Buffer) => {
        entriesSeen.push(readdirSync(cwd).sort())
        const kind = path.endsWith('typeclaw.json') ? 'config' : 'env'
        calls[kind] += 1
        const fails = (fail[kind] ?? []).includes(calls[kind])
        writeFileSync(path, fails ? '' : content, { flag: 'w' })
        if (fails) throw new Error(`injected ${kind} write failure ${calls[kind]}`)
      }
      return { write, entriesSeen }
    }

    test('a successful publish writes both files in place, with no staged copy of either', async () => {
      const { cwd, env, config, staging } = await agentWithEnv()
      const configFile = statSync(config).ino
      const writer = inPlace(cwd)

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        { platform: 'win32', writeInPlace: writer.write },
      )

      expect(result).toEqual({ ok: true })
      expect(writer.entriesSeen).toEqual([
        ['.env', 'typeclaw.json'],
        ['.env', 'typeclaw.json'],
      ])
      expect(existsSync(staging)).toBe(false)
      expect(readFileSync(env, 'utf8')).toBe('OLD=1\nTOKEN=new\n')
      expect(readFileSync(config, 'utf8')).toBe('{"tunnels":[]}\n')
      expect(statSync(config).ino).toBe(configFile)
      expect(readdirSync(cwd).sort()).toEqual(['.env', 'typeclaw.json'])
    })

    test('a failed config write leaves typeclaw.json and .env byte-identical, with no staged copy', async () => {
      // given: the in-place config write truncates typeclaw.json and then fails
      const { cwd, env, config, staging } = await agentWithEnv()
      const writer = inPlace(cwd, { config: [1] })

      // when
      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        { platform: 'win32', writeInPlace: writer.write },
      )

      // then: both are back from memory, and nothing was ever written beside them
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('typeclaw.json was not changed; .env was restored.')
      expect(readFileSync(config, 'utf8')).toBe('{}\n')
      expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
      expect(writer.entriesSeen.every((entries) => entries.join() === '.env,typeclaw.json')).toBe(true)
      expect(existsSync(staging)).toBe(false)
      expect(readdirSync(cwd).sort()).toEqual(['.env', 'typeclaw.json'])
    })

    test('a failed .env restore says the token must be re-entered, writing nothing to staging', async () => {
      const { cwd, env, config, staging } = await agentWithEnv()
      const writer = inPlace(cwd, { config: [1], env: [2] })

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        { platform: 'win32', writeInPlace: writer.write },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain(`${env} could not be restored (injected env write failure 2)`)
        expect(result.reason).toContain(`must be re-entered in ${env}`)
      }
      expect(readFileSync(config, 'utf8')).toBe('{}\n')
      expect(existsSync(staging)).toBe(false)
      expect(readdirSync(cwd).sort()).toEqual(['.env', 'typeclaw.json'])
    })

    test('a failed config restore names typeclaw.json and how to recover it', async () => {
      const { cwd, env, config, staging } = await agentWithEnv()
      const writer = inPlace(cwd, { config: [1, 2] })

      const result = publishConfigWithCredential(
        config,
        '{"tunnels":[]}\n',
        { path: env, content: 'OLD=1\nTOKEN=new\n', stagingDir: staging },
        { platform: 'win32', writeInPlace: writer.write },
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain(`${config} could not be restored (injected config write failure 2)`)
        expect(result.reason).toContain('git checkout -- typeclaw.json')
        expect(result.reason).toContain('.env was restored.')
      }
      expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
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

describe('a verified config publication', () => {
  for (const replacement of ['a FIFO', 'a symlink'] as const) {
    test.skipIf(process.platform === 'win32')(
      `refuses promptly when the config was replaced by ${replacement} after it was verified`,
      async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-verified-'))
        const config = join(cwd, 'typeclaw.json')
        const env = join(cwd, '.env')
        const target = join(cwd, 'workspace', 'notes.json')
        try {
          // given: a verified config, then replaced before the paired publication
          await writeFile(config, '{"alias":["atlas"]}\n')
          await writeFile(env, 'OLD=1\n')
          const verified = prepareConfigWriteSync(config)
          await rm(config)
          if (replacement === 'a FIFO') {
            expect(await Bun.spawn(['mkfifo', config]).exited).toBe(0)
          } else {
            await mkdir(join(cwd, 'workspace'), { recursive: true })
            await writeFile(target, '{"alias":["atlas"]}\n')
            await symlink(target, config)
          }

          // when: the config and a .env token are published together (a blocking read would hang here)
          const result = publishConfigWithCredential(verified, '{"alias":["renamed"]}\n', {
            path: env,
            content: 'OLD=1\nNEW=2\n',
            stagingDir: credentialStagingDir(cwd),
          })

          // then: nothing went through the replacement, .env is restored, and no commit is recorded
          expect(result.ok).toBe(false)
          expect(result.ok ? '' : result.reason).toContain('typeclaw.json was not changed')
          expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
          if (replacement === 'a FIFO') expect(lstatSync(config).isFIFO()).toBe(true)
          else expect(readFileSync(target, 'utf8')).toBe('{"alias":["atlas"]}\n')
          expect(readConfigCommitSync(config)).toBeUndefined()
        } finally {
          await rm(cwd, { recursive: true, force: true })
        }
      },
    )
  }

  test('creates a missing config exclusively through the verified writer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-staged-verified-'))
    const config = join(cwd, 'typeclaw.json')
    try {
      const verified = prepareConfigWriteSync(config)

      expect(publishConfigWithCredential(verified, '{"alias":["atlas"]}\n', undefined)).toEqual({ ok: true })
      expect(readFileSync(config, 'utf8')).toBe('{"alias":["atlas"]}\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
