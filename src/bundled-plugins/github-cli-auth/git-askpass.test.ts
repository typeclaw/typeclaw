import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { ensureGitAskPassHelper, resetGitAskPassHelperForTests } from './git-askpass'

const onWindows = isWindows()

afterEach(() => {
  resetGitAskPassHelperForTests()
})

async function tmpHelperPath() {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-askpass-'))
  return join(dir, 'typeclaw-git-askpass')
}

// POSIX shell helper, #899.
describe.skipIf(onWindows)('ensureGitAskPassHelper', () => {
  test('writes the helper and returns its path', async () => {
    const path = await tmpHelperPath()
    expect(await ensureGitAskPassHelper(path)).toBe(path)
    expect((await stat(path)).isFile()).toBe(true)
  })

  test('helper content contains no token, only the env var name', async () => {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const content = await readFile(path, 'utf8')
    expect(content).toContain('TYPECLAW_GIT_TOKEN')
    expect(content).toContain('x-access-token')
    expect(content).not.toMatch(/gh[ps]_/)
  })

  test('concurrent calls share one write and resolve to the same path', async () => {
    const path = await tmpHelperPath()
    const [a, b] = await Promise.all([ensureGitAskPassHelper(path), ensureGitAskPassHelper(path)])
    expect(a).toBe(path)
    expect(b).toBe(path)
  })

  test('helper is executable', async () => {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const mode = (await stat(path)).mode & 0o111
    expect(mode).not.toBe(0)
  })

  test('defaults under the fixed real /tmp (writable, executable), not read-only /usr', async () => {
    const originalOverride = process.env.TYPECLAW_GIT_ASKPASS_PATH
    delete process.env.TYPECLAW_GIT_ASKPASS_PATH
    try {
      const path = await ensureGitAskPassHelper()
      expect(path.startsWith('/usr')).toBe(false)
      expect(path.startsWith('/tmp/typeclaw-git-askpass-')).toBe(true)
      expect((await stat(path)).isFile()).toBe(true)
      expect((await stat(path)).mode & 0o111).not.toBe(0)
    } finally {
      if (originalOverride === undefined) delete process.env.TYPECLAW_GIT_ASKPASS_PATH
      else process.env.TYPECLAW_GIT_ASKPASS_PATH = originalOverride
    }
  })

  test('ignores a model-writable TMPDIR: the default base stays on the fixed real /tmp', async () => {
    // os.tmpdir() honors TMPDIR/TMP/TEMP; if the default were derived from it, a tool
    // that controls TMPDIR could plant the helper in a model-writable tree and swap it
    // before an unsandboxed consumer runs it with TYPECLAW_GIT_TOKEN. The base must be fixed.
    const originalOverride = process.env.TYPECLAW_GIT_ASKPASS_PATH
    const originalTmpdir = process.env.TMPDIR
    delete process.env.TYPECLAW_GIT_ASKPASS_PATH
    const modelWritable = await mkdtemp(join(tmpdir(), 'model-writable-'))
    process.env.TMPDIR = modelWritable
    try {
      const path = await ensureGitAskPassHelper()
      expect(path.startsWith(modelWritable)).toBe(false)
      expect(path.startsWith('/tmp/typeclaw-git-askpass-')).toBe(true)
    } finally {
      if (originalOverride === undefined) delete process.env.TYPECLAW_GIT_ASKPASS_PATH
      else process.env.TYPECLAW_GIT_ASKPASS_PATH = originalOverride
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
  })

  test('caches per path so a second distinct path is ensured independently', async () => {
    const [pathA, pathB] = [await tmpHelperPath(), await tmpHelperPath()]
    expect(await ensureGitAskPassHelper(pathA)).toBe(pathA)
    expect(await ensureGitAskPassHelper(pathB)).toBe(pathB)
    expect((await stat(pathA)).isFile()).toBe(true)
    expect((await stat(pathB)).isFile()).toBe(true)
  })
})

// POSIX shell helper, #899.
describe.skipIf(onWindows)('ensureGitAskPassHelper — host-scoped behavior (executed)', () => {
  async function run(promptArg: string): Promise<{ code: number; out: string }> {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const proc = Bun.spawn({
      cmd: [path, promptArg],
      env: { TYPECLAW_GIT_TOKEN: 'ghs_secret_token' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const code = await proc.exited
    const out = (await new Response(proc.stdout).text()).trim()
    return { code, out }
  }

  test('emits the token for a github.com password prompt', async () => {
    const { code, out } = await run("Password for 'https://github.com': ")
    expect(code).toBe(0)
    expect(out).toBe('ghs_secret_token')
  })

  test('emits x-access-token for a github.com username prompt', async () => {
    const { code, out } = await run("Username for 'https://github.com': ")
    expect(code).toBe(0)
    expect(out).toBe('x-access-token')
  })

  // The password prompt git actually sends: once the helper answers
  // `x-access-token` to the username prompt, git folds that userinfo into the
  // host of the password prompt. This is the exact string a real HTTPS clone
  // produces; without the userinfo arm in the guard it falls through to exit 1
  // and the clone dies with "unable to read askpass response".
  test('emits the token for the userinfo-host password prompt git sends after the username', async () => {
    const { code, out } = await run("Password for 'https://x-access-token@github.com': ")
    expect(code).toBe(0)
    expect(out).toBe('ghs_secret_token')
  })

  test('is not fooled by a userinfo prompt whose host is a suffix lookalike', async () => {
    const { code, out } = await run("Password for 'https://x-access-token@github.com.evil.test': ")
    expect(code).toBe(1)
    expect(out).toBe('')
  })

  test('is not fooled by a userinfo prompt whose real host is not github.com', async () => {
    const { code, out } = await run("Password for 'https://github.com@evil.example/': ")
    expect(code).toBe(1)
    expect(out).toBe('')
  })

  test('refuses (exit 1, no token) for a non-github host prompt', async () => {
    const { code, out } = await run("Password for 'https://evil.example': ")
    expect(code).toBe(1)
    expect(out).toBe('')
  })

  test('is not fooled by a lookalike host (evil-github.com)', async () => {
    const { out } = await run("Password for 'https://evil-github.com': ")
    expect(out).toBe('')
  })

  test('is not fooled by a suffix lookalike host (github.com.evil)', async () => {
    const { out } = await run("Password for 'https://github.com.evil.test': ")
    expect(out).toBe('')
  })
})
