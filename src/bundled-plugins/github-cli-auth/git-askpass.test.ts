import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { ensureGitAskPassHelper, resetGitAskPassHelperForTests, TYPECLAW_GIT_ASKPASS_PATH } from './git-askpass'

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

  test('honors the path override when no explicit path is passed', async () => {
    const path = await tmpHelperPath()
    process.env.TYPECLAW_GIT_ASKPASS_PATH = path
    try {
      expect(await ensureGitAskPassHelper()).toBe(path)
    } finally {
      delete process.env.TYPECLAW_GIT_ASKPASS_PATH
    }
  })

  test('exports the image-baked production path', () => {
    expect(TYPECLAW_GIT_ASKPASS_PATH).toBe('/usr/local/bin/typeclaw-git-askpass')
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
