import { describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configFileLockPath } from '@/config/config-file-lock'

import { appendOrReplaceEnvKey, hasEnvKey, readEnvFile, storeEnvKeyUnlessPresent } from './env-file'
import { credentialStagingDir } from './staged-write'

describe('storeEnvKeyUnlessPresent', () => {
  test.skipIf(process.platform === 'win32')('stores the token in a new owner-only .env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))

    expect(storeEnvKeyUnlessPresent(cwd, 'CLOUDFLARE_TUNNEL_TOKEN', 'tok')).toEqual({ ok: true })

    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('CLOUDFLARE_TUNNEL_TOKEN=tok\n')
    expect(statSync(join(cwd, '.env')).mode & 0o777).toBe(0o600)
    expect(readdirSync(credentialStagingDir(cwd))).toEqual([])
  })

  test('refuses to overwrite a key another command stored, leaving .env untouched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'CLOUDFLARE_TUNNEL_TOKEN=theirs\n')

    const result = storeEnvKeyUnlessPresent(cwd, 'CLOUDFLARE_TUNNEL_TOKEN', 'mine')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('was stored in .env by another typeclaw command')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('CLOUDFLARE_TUNNEL_TOKEN=theirs\n')
  })

  test('rechecks the key under the config lock after another holder releases it', async () => {
    // given: another process holds the typeclaw.json lock, stores the key, then releases
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    const env = join(cwd, '.env')
    const lock = configFileLockPath(join(cwd, 'typeclaw.json'))
    await writeFile(lock, '')
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(env)}, 'CLOUDFLARE_TUNNEL_TOKEN=theirs\\n'); fs.unlinkSync(${JSON.stringify(lock)})`,
      ],
      stdout: 'ignore',
      stderr: 'inherit',
    })

    // when: this command stores the same key while the lock is held
    const result = storeEnvKeyUnlessPresent(cwd, 'CLOUDFLARE_TUNNEL_TOKEN', 'mine')

    // then: it waited for the holder, saw its token, and kept it
    expect(await holder.exited).toBe(0)
    expect(result.ok).toBe(false)
    expect(await readFile(env, 'utf8')).toBe('CLOUDFLARE_TUNNEL_TOKEN=theirs\n')
  })
})

describe('readEnvFile', () => {
  test('returns an empty map when .env is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    expect(readEnvFile(cwd).size).toBe(0)
  })

  test('parses KEY=value lines, skipping blanks and comments', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '# a comment\n\nFOO=bar\nBAZ=qux\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.get('FOO')).toBe('bar')
    expect(env.get('BAZ')).toBe('qux')
    expect(env.size).toBe(2)
  })

  test('preserves quotes verbatim (matches docker --env-file semantics)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'QUOTED="hello"\n', 'utf8')
    expect(readEnvFile(cwd).get('QUOTED')).toBe('"hello"')
  })

  test('treats only the first `=` as the separator', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EQUATION=a=b=c\n', 'utf8')
    expect(readEnvFile(cwd).get('EQUATION')).toBe('a=b=c')
  })

  test('skips lines without `=` and lines starting with `=`', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'STRAY_LINE\n=noKey\nOK=yes\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.size).toBe(1)
    expect(env.get('OK')).toBe('yes')
  })

  test('strips a UTF-8 BOM from the first line, as docker --env-file does', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '\uFEFFFIRST=one\nSECOND=two\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.get('FIRST')).toBe('one')
    expect(env.get('SECOND')).toBe('two')
  })

  test('keeps a BOM appearing on a later line as part of that key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'FIRST=one\n\uFEFFSECOND=two\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.get('SECOND')).toBeUndefined()
    expect(env.get('\uFEFFSECOND')).toBe('two')
  })

  test('left-trims indented keys so an indented declaration is not reported as absent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '   SPACED=yes\n\t\tTABBED=also\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.get('SPACED')).toBe('yes')
    expect(env.get('TABBED')).toBe('also')
  })

  test('treats an indented `#` line as a comment rather than a key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '   # indented comment=notakey\nREAL=value\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.size).toBe(1)
    expect(env.get('REAL')).toBe('value')
  })

  test('does not trim the value, only the leading indentation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '  PADDED=  spaced value  \n', 'utf8')
    expect(readEnvFile(cwd).get('PADDED')).toBe('  spaced value  ')
  })

  test('skips a key containing whitespace, which docker rejects outright', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'BAD KEY=value\nGOOD=value\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.size).toBe(1)
    expect(env.get('GOOD')).toBe('value')
  })
})

describe('hasEnvKey', () => {
  test('returns false when the key is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'OTHER=value\n', 'utf8')
    expect(hasEnvKey(cwd, 'MISSING')).toBe(false)
  })

  test('returns false when the key is present but empty', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EMPTY=\n', 'utf8')
    expect(hasEnvKey(cwd, 'EMPTY')).toBe(false)
  })

  test('returns true when the key has a non-empty value', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'FILLED=something\n', 'utf8')
    expect(hasEnvKey(cwd, 'FILLED')).toBe(true)
  })

  test('returns false when .env is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    expect(hasEnvKey(cwd, 'ANY')).toBe(false)
  })
})

describe('appendOrReplaceEnvKey', () => {
  test('creates .env with KEY=value when the file is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    appendOrReplaceEnvKey(cwd, 'FOO', 'bar')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('FOO=bar\n')
  })

  test('appends a new key after existing keys', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('EXISTING=keep\nFRESH=value\n')
  })

  test('replaces an existing key in place, preserving surrounding lines', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '# header\nFIRST=a\nTARGET=old\nLAST=z\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'TARGET', 'new')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('# header\nFIRST=a\nTARGET=new\nLAST=z\n')
  })

  test('does not strip or add quotes around the value', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    appendOrReplaceEnvKey(cwd, 'TOKEN', 'eyJhbGc.abc.def')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('TOKEN=eyJhbGc.abc.def\n')
  })

  test('handles a file without a trailing newline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('EXISTING=keep\nFRESH=value\n')
  })

  test('does not double up trailing blank lines when appending', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    const out = await readFile(join(cwd, '.env'), 'utf8')
    expect(out).toBe('EXISTING=keep\nFRESH=value\n')
    expect(out.split('\n').filter((line) => line === '').length).toBe(1)
  })

  test('replaces an indented key instead of appending a duplicate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '   TARGET=old\nOTHER=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'TARGET', 'new')
    const out = await readFile(join(cwd, '.env'), 'utf8')
    expect(out).toBe('TARGET=new\nOTHER=keep\n')
    expect(readEnvFile(cwd).get('TARGET')).toBe('new')
  })

  test('replaces a BOM-prefixed first key and keeps the BOM', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '\uFEFFTARGET=old\nOTHER=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'TARGET', 'new')
    const out = await readFile(join(cwd, '.env'), 'utf8')
    expect(out).toBe('\uFEFFTARGET=new\nOTHER=keep\n')
    expect(readEnvFile(cwd).get('TARGET')).toBe('new')
  })

  test('leaves an indented comment untouched when replacing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '   # TARGET=commented\nTARGET=old\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'TARGET', 'new')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('   # TARGET=commented\nTARGET=new\n')
  })
})
