import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dockerfileSchema } from '@/config/config'
import { isWindows } from '@/shared'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'
import {
  buildBaseDockerfile,
  buildDockerfile,
  buildEntrypointShim,
  classifyDockerfileAppend,
  CHROME_RUNTIME_APT_PACKAGES_AMD64,
  CLOUDFLARED_RELEASE_URL_BASE,
  CLOUDFLARED_VERSION,
  CURL_IMPERSONATE_PROFILE,
  CURL_IMPERSONATE_SHA256_AMD64,
  CURL_IMPERSONATE_SHA256_ARM64,
  CURL_IMPERSONATE_VERSION,
  NETWORK_BLOCK_IPV4_NETS,
  NETWORK_BLOCK_IPV6_NETS,
  TRANSFORMERS_VERSION,
  TYPECLAW_CLI_ENTRY,
  TYPECLAW_ENTRYPOINT_PATH,
} from './dockerfile'

// Layer ordering, cache-mount preservation, and on-disk write behavior are
// covered by integration tests in src/init/index.test.ts. This file only
// asserts the toggle-driven content of the rendered Dockerfile string.

const onWindows = isWindows()

// Pulls the package list passed to the main `apt-get install` line so
// assertions are scoped to what actually gets installed and not to
// human-readable comment prose elsewhere in the Dockerfile.
function aptPackages(out: string): string[] {
  const match = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+?) \\\n/)
  if (!match || !match[1]) throw new Error('main apt-get install line not found in Dockerfile output')
  return match[1].split(/\s+/).filter(Boolean)
}

describe('buildDockerfile feature toggles', () => {
  test('defaults: tmux, gh, python (incl. pip/venv/python-is-python3) installed; ffmpeg not installed', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({})))

    expect(pkgs).toContain('tmux')
    expect(pkgs).toContain('gh')
    expect(pkgs).toContain('python3')
    expect(pkgs).toContain('python3-pip')
    expect(pkgs).toContain('python3-venv')
    expect(pkgs).toContain('python-is-python3')
    expect(pkgs).not.toContain('ffmpeg')
  })

  test('default config matches no-arg call (backcompat with the existing default-arg form)', () => {
    expect(buildDockerfile()).toBe(buildDockerfile(dockerfileSchema.parse({})))
  })

  test('tmux: false omits tmux from the apt package list', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ tmux: false })))
    expect(pkgs).not.toContain('tmux')
    expect(pkgs.some((p) => p.startsWith('tmux='))).toBe(false)
  })

  test('python: false omits the entire python bundle', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ python: false })))
    expect(pkgs).not.toContain('python3')
    expect(pkgs).not.toContain('python3-pip')
    expect(pkgs).not.toContain('python3-venv')
    expect(pkgs).not.toContain('python-is-python3')
  })

  test('ffmpeg: true adds ffmpeg to the apt package list', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ ffmpeg: true })))
    expect(pkgs).toContain('ffmpeg')
  })

  test('gh: false omits the gh package and the keyring bootstrap layer (no network roundtrip on rebuild)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ gh: false }))
    const pkgs = aptPackages(out)

    expect(pkgs).not.toContain('gh')
    expect(pkgs.some((p) => p.startsWith('gh='))).toBe(false)
    expect(out).not.toContain('cli.github.com/packages')
    expect(out).not.toContain('githubcli-archive-keyring.gpg')
    expect(out).not.toContain('/etc/apt/sources.list.d/github-cli.list')
  })

  test('string version pins the package: "gh: 2.40.0" → apt-get install gh=2.40.0', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ gh: '2.40.0' })))
    expect(pkgs).toContain('gh=2.40.0')
    expect(pkgs).not.toContain('gh')
  })

  test('string version on tmux pins the package: "tmux: 3.3a-3" → tmux=3.3a-3', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ tmux: '3.3a-3' })))
    expect(pkgs).toContain('tmux=3.3a-3')
  })

  test('string version on ffmpeg installs and pins it', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ ffmpeg: '7:5.1.4-0+deb12u1' })))
    expect(pkgs).toContain('ffmpeg=7:5.1.4-0+deb12u1')
  })

  test('all toggles off: only baseline packages remain (egress-shim deps ship unconditionally; xvfb is a toggle, off here)', () => {
    const pkgs = aptPackages(
      buildDockerfile(
        dockerfileSchema.parse({
          tmux: false,
          gh: false,
          python: false,
          ffmpeg: false,
          cjkFonts: false,
          xvfb: false,
        }),
      ),
    )
    expect(pkgs).toEqual([
      'git',
      'ca-certificates',
      'curl',
      'gnupg',
      'iptables',
      'util-linux',
      'bubblewrap',
      'jq',
      'libgomp1',
    ])
  })

  test('xvfb: true (the default) adds xvfb to the toggle apt package list, after the baseline packages', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({})))
    expect(pkgs).toContain('xvfb')
    expect(pkgs.indexOf('xvfb')).toBeGreaterThan(pkgs.indexOf('util-linux'))
  })

  test('xvfb: false omits xvfb from the apt package list (opt-out)', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ xvfb: false })))
    expect(pkgs).not.toContain('xvfb')
  })

  test('append lines render after the toggle layers and before ENTRYPOINT', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ ffmpeg: true, append: ['ENV CUSTOM_TOOL=1'] }))

    const ffmpegIdx = out.indexOf('ffmpeg')
    const customIdx = out.indexOf('ENV CUSTOM_TOOL=1')
    const entrypointIdx = out.indexOf(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)

    expect(ffmpegIdx).toBeGreaterThan(-1)
    expect(customIdx).toBeGreaterThan(-1)
    expect(entrypointIdx).toBeGreaterThan(-1)
    expect(ffmpegIdx).toBeLessThan(customIdx)
    expect(customIdx).toBeLessThan(entrypointIdx)
  })

  test('fail-safe: strips a decode-and-exec append line but keeps safe lines and still renders ENTRYPOINT', () => {
    const dangerous = 'RUN python3 -c "import base64; exec(base64.b64decode(\'AA==\').decode())"'
    const out = buildDockerfile(dockerfileSchema.parse({ append: ['ENV SAFE=1', dangerous] }))

    expect(out).toContain('ENV SAFE=1')
    expect(out).not.toContain('exec(base64.b64decode')
    expect(out).toContain('typeclaw stripped 1 unsafe docker.file.append line(s)')
    expect(out).toContain(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)
  })

  test('fail-safe: never echoes stripped payload content into the Dockerfile (no secret leak)', () => {
    const secretish = 'RUN echo c2VjcmV0LXRva2Vu | base64 -d | sh'
    const out = buildDockerfile(dockerfileSchema.parse({ append: [secretish] }))

    expect(out).not.toContain('c2VjcmV0LXRva2Vu')
    expect(out).toContain('typeclaw stripped 1 unsafe docker.file.append line(s)')
  })

  test('classifyDockerfileAppend keeps warn-but-allow lines (curl|bash) while emitting a warning', () => {
    const { kept, warnings, strippedCount } = classifyDockerfileAppend([
      'RUN curl -fsSL https://example.com/i.sh | bash',
    ])
    expect(kept).toEqual(['RUN curl -fsSL https://example.com/i.sh | bash'])
    expect(strippedCount).toBe(0)
    expect(warnings.join('\n')).toContain('docker.file.append[0]')
  })

  test('classifyDockerfileAppend strips structural blocks (FROM) with an indexed warning', () => {
    const { kept, warnings, strippedCount } = classifyDockerfileAppend(['ENV OK=1', 'FROM alpine'])
    expect(kept).toEqual(['ENV OK=1'])
    expect(strippedCount).toBe(1)
    expect(warnings.join('\n')).toContain('docker.file.append[1] stripped')
  })

  test('classifyDockerfileAppend warning never echoes the offending token from a malformed line (no secret leak)', () => {
    const secretishFirstToken = 'sk-live-abc123secret do-something'
    const { kept, warnings, strippedCount } = classifyDockerfileAppend([secretishFirstToken])
    expect(kept).toEqual([])
    expect(strippedCount).toBe(1)
    const joined = warnings.join('\n')
    expect(joined).not.toContain('sk-live-abc123secret')
    expect(joined).toContain('does not begin with a recognized Dockerfile instruction')
  })

  test('rejects version strings containing whitespace or "=" (apt-injection guard)', () => {
    expect(() => dockerfileSchema.parse({ gh: '2.40.0 curl' })).toThrow(/must not contain whitespace/)
    expect(() => dockerfileSchema.parse({ tmux: '3.3a=evil' })).toThrow(/must not contain whitespace/)
  })
})

describe('claudeCode toggle', () => {
  test('defaults to false (the install layer is opt-in via the typeclaw-claude-code skill)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}))
    expect(out).not.toContain('claude.ai/install.sh')
  })

  test('claudeCode: false omits the install layer entirely', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: false }))
    expect(out).not.toContain('claude.ai/install.sh')
  })

  test('claudeCode: true emits the curl-piped install layer in the inline (dev) form', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('RUN curl -fsSL https://claude.ai/install.sh | bash')
  })

  test('claudeCode: true emits the install layer in the versioned (base-image) form too — drift guard', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('RUN curl -fsSL https://claude.ai/install.sh | bash')
  })

  test('install layer renders before the entrypoint shim so the shim is always the final RUN', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const claudeIdx = out.indexOf('claude.ai/install.sh')
    const shimIdx = out.indexOf(TYPECLAW_ENTRYPOINT_PATH)
    expect(claudeIdx).toBeGreaterThan(-1)
    expect(shimIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeLessThan(shimIdx)
  })

  test('install layer symlinks ~/.local/bin/claude into /usr/local/bin (the Anthropic installer emits a "~/.local/bin is not in your PATH" warning on bun:1-slim; without the symlink every `which claude` returns empty)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude')
  })

  test('install layer smoke-tests the binary with `claude --version` so a broken install fails the build instead of the first delegation', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('claude --version > /dev/null')
  })

  test('install layer is rejected by parse: claudeCode does not accept string version pins (the upstream installer is not a versioned apt package)', () => {
    expect(() => dockerfileSchema.parse({ claudeCode: '1.2.3' })).toThrow()
  })

  test('base Dockerfile never embeds the claude install — toggle-driven layers stay in the per-agent file so changing the flag does not rebuild the base image', () => {
    expect(buildBaseDockerfile()).not.toContain('claude.ai/install.sh')
  })

  test('install layer pre-seeds ~/.claude.json with hasCompletedOnboarding so the first launch skips the TTY-only theme picker that would otherwise hang the typeclaw-claude-code skill on its Stop-hook polling loop', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('"hasCompletedOnboarding":true')
    expect(out).toContain('> "$HOME/.claude.json"')
  })

  test('pre-seed sets a default theme so claude does not block on "Choose the text style that looks best with your terminal"', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('"theme":"dark"')
  })

  test('pre-seed is the LAST step in the install chain so the final layer state is exactly the seeded config — independent of whether any earlier command (current or future) writes a default ~/.claude.json partway through', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const smokeIdx = out.indexOf('claude --version > /dev/null')
    const seedIdx = out.indexOf('"hasCompletedOnboarding":true')
    expect(smokeIdx).toBeGreaterThan(-1)
    expect(seedIdx).toBeGreaterThan(-1)
    expect(smokeIdx).toBeLessThan(seedIdx)
  })

  test('pre-seed payload is valid JSON — extract the printf argument and JSON.parse it so quote-mangling bugs fail the test, not the docker build', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.claude\.json"/)
    expect(match).not.toBeNull()
    const payload = match?.[1]
    expect(payload).toBeDefined()
    const parsed = JSON.parse(payload as string)
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.theme).toBe('dark')
  })

  test('pre-seed JSON contains no single quotes — required by the printf %s shell-quoting pattern, and guaranteed by JSON.stringify which only emits double quotes', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.claude\.json"/)
    expect(match).not.toBeNull()
    const payload = match?.[1]
    expect(payload).toBeDefined()
    expect(payload).not.toContain("'")
  })

  test('pre-seed does NOT contain trust-dialog or permission-bypass flags — those should remain explicit user decisions, not silent Dockerfile defaults', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).not.toContain('hasTrustDialogAccepted')
    expect(out).not.toContain('bypassPermissionsModeAccepted')
    expect(out).not.toContain('dangerouslySkipPermissions')
  })

  test('pre-seed is omitted when claudeCode is false (no orphan ~/.claude.json on agents that do not use claude)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: false }))
    expect(out).not.toContain('hasCompletedOnboarding')
    expect(out).not.toContain('.claude.json')
  })

  test('pre-seed appears in the versioned (base-image) form too — drift guard so GHCR-base users get the same onboarding-skip behavior as dev/inline users', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('"hasCompletedOnboarding":true')
  })
})

describe('Claude Code global Stop hook (pre-baked into the image)', () => {
  function extractStopHookScript(out: string): string {
    const match = out.match(
      /cat > \/usr\/local\/bin\/typeclaw-cc-stop-hook <<'TYPECLAW_CC_STOP_HOOK_EOF'\n([\s\S]*?)TYPECLAW_CC_STOP_HOOK_EOF/,
    )
    if (!match || !match[1]) throw new Error('typeclaw-cc-stop-hook heredoc not found')
    return match[1]
  }

  function extractGlobalSettings(out: string): unknown {
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.claude\/settings\.json"/)
    if (!match || !match[1]) throw new Error('global settings.json printf not found')
    return JSON.parse(match[1])
  }

  test('claudeCode: true writes the hook script at /usr/local/bin/typeclaw-cc-stop-hook (stable absolute path so the global settings can name it without $PATH concerns) and chmods it executable in the same chmod call as the SessionStart hook', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('cat > /usr/local/bin/typeclaw-cc-stop-hook')
    expect(out).toMatch(/chmod \+x [^\n]*\/usr\/local\/bin\/typeclaw-cc-stop-hook/)
  })

  test('hook script is delivered via a single-quoted heredoc so $PWD and $sid survive docker build and are expanded at runtime (NOT at build time)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain("<<'TYPECLAW_CC_STOP_HOOK_EOF'")
    const script = extractStopHookScript(out)
    expect(script).toContain('${PWD}/sentinel-${sid}.json')
    expect(script).toContain('${PWD}/.done-${sid}')
  })

  test('hook script writes to $PWD, NOT $CLAUDE_PROJECT_DIR — critical bug guard: CLAUDE_PROJECT_DIR resolves to the git root of cwd, which inside a `git worktree add`d directory is the MAIN repo, not the worktree path (anthropics/claude-code#27343, #44450). For the typeclaw-claude-code skill, that would land sentinel.json in /agent (and into git history via the backup plugin auto-commit) while the polling loop watches /tmp/cc-<id>/.', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).not.toContain('CLAUDE_PROJECT_DIR')
  })

  test('hook script encodes session_id in the filename — concurrent-claude race safety: if two callers share a cwd (operators A+B, future plugin, out-of-band caller) they must not collide on the same sentinel/.done. session_id comes from the Stop event JSON stdin per BaseHookInputSchema; the operator learns the UUID via the .session-id file the SessionStart hook writes (NOT via claude --session-id, which does not propagate to hook events in interactive mode per anthropics/claude-code#44607).', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('sentinel-${sid}.json')
    expect(script).toContain('.done-${sid}')
    expect(script).not.toMatch(/"\$\{PWD\}\/sentinel\.json"/)
    expect(script).not.toMatch(/"\$\{PWD\}\/\.done"\s/)
  })

  test('hook script extracts session_id via `bun -e` (real JSON parser, not sed regex) — defense against shadow attacks where last_assistant_message contains escaped `"session_id":"..."` text that greedy sed would extract instead of the structural top-level field', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('bun -e ')
    expect(script).toContain('Bun.file')
    expect(script).toContain('.session_id')
    expect(script).not.toContain('sed -n ')
    expect(script).not.toContain('jq ')
    expect(script).not.toContain('python3')
  })

  test('hook script validates extracted session_id against UUID shape (8-4-4-4-12 hex) — defense against path-traversal session_id values like "../etc/passwd" that would otherwise resolve to a write outside $PWD', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    // POSIX `case` pattern matching the UUID shape; the [0-9a-f] character
    // classes match exactly 8-4-4-4-12 hex digits with dashes.
    expect(script).toContain('case "$sid" in')
    expect(script).toMatch(
      /\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]/,
    )
  })

  test('hook script falls back to sid=malformed when session_id extraction or validation fails — operator polling-loop times out (no .done-<their-uuid>), but $PWD/sentinel-malformed.json exists so a post-mortem inspector can tell "hook fired with bad input" from "hook never fired"', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('sid=malformed')
  })

  test('hook script writes sentinel atomically via temp-then-rename — the polling loop never sees a partial JSON payload', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('.cc-stop-hook-in')
    expect(script).toMatch(/cat > "\$tmp_in"[\s\S]*mv "\$tmp_in" "\$\{PWD\}\/sentinel-/)
  })

  test('Stop hook script reads the temp file via process.argv[1] (NOT argv[2]) — bun -e strips the -e flag and code-string from argv, unlike Node which preserves them. argv[1] is the FIRST positional argument after the -e code; passing the temp_in path as such gives bun.file the right path. Bug caught empirically inside docker: using argv[2] gave undefined, the catch block returned empty string, and every Stop hook fell back to sid=malformed.', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('process.argv[1]')
    expect(script).not.toContain('process.argv[2]')
  })

  test('hook script touches .done-<sid> AFTER moving sentinel-<sid>.json into place — polling loop watches .done as the readiness signal, so a touch-before-rename would let readers see .done before sentinel exists', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    const mvIdx = script.indexOf('mv "$tmp_in"')
    const touchIdx = script.indexOf('touch "${PWD}/.done-${sid}"')
    expect(mvIdx).toBeGreaterThan(-1)
    expect(touchIdx).toBeGreaterThan(-1)
    expect(mvIdx).toBeLessThan(touchIdx)
  })

  test('hook script sets `set -eu` for fail-fast on missing PWD or sed errors — without it, an empty PWD would silently write to /sentinel-<sid>.json at filesystem root', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('set -eu')
  })

  test('hook script has a POSIX shebang (/bin/sh, not /bin/bash) — the script uses no bashisms and bun:1-slim ships dash as /bin/sh; depending on bash would add a layer for one bash invocation', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })

  test('global settings.json is written at ~/.claude/settings.json (user-level scope, applies to every claude invocation regardless of cwd)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('mkdir -p "$HOME/.claude"')
    expect(out).toContain('"$HOME/.claude/settings.json"')
  })

  test("global settings.json registers BOTH the SessionStart hook (so the operator can learn the session UUID via the .session-id file) and the Stop hook (so the operator can poll for turn-completion). The two-hook design exists because `claude --session-id <uuid>` does not propagate to hook payloads in interactive mode (anthropics/claude-code#44607), so the operator cannot pre-generate the UUID; instead it learns claude's actual UUID from the SessionStart hook output.", () => {
    const parsed = extractGlobalSettings(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(parsed).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear|compact',
            hooks: [{ type: 'command', command: '/usr/local/bin/typeclaw-cc-session-start-hook', args: [] }],
          },
        ],
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '/usr/local/bin/typeclaw-cc-stop-hook', args: [] }],
          },
        ],
      },
    })
  })

  test('SessionStart matcher is `startup|resume|clear|compact` (all four upstream-documented session-origin types) so the operator learns the UUID regardless of how the session started — startup (fresh claude), resume (--resume <uuid>), clear (/clear command), compact (auto-compaction)', () => {
    const parsed = extractGlobalSettings(buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))) as {
      hooks: { SessionStart: Array<{ matcher: string }> }
    }
    expect(parsed.hooks.SessionStart[0]?.matcher).toBe('startup|resume|clear|compact')
  })

  test('settings.json uses exec form (args: []) NOT shell form (no args) — per docs.claude.com/en/docs/claude-code/hooks, args present triggers execvp with kernel-handled shebang and no shell tokenization, vs shell form that wraps in sh -c "<command>" (works for our path today, but fragile to any future change that introduces special chars)', () => {
    const parsed = extractGlobalSettings(buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))) as {
      hooks: { Stop: Array<{ hooks: Array<{ args?: unknown[] }> }> }
    }
    const args = parsed.hooks.Stop[0]?.hooks[0]?.args
    expect(args).toBeDefined()
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual([])
  })

  test('global settings.json command path is absolute, not relative — Claude Code user-level hooks fire with arbitrary cwds, so a relative path would resolve unpredictably', () => {
    const parsed = extractGlobalSettings(buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    const cmd = parsed.hooks.Stop[0]?.hooks[0]?.command
    expect(cmd).toBeDefined()
    expect(cmd?.startsWith('/')).toBe(true)
  })

  test('global settings.json payload contains no single quotes — required by the printf %s shell-quoting pattern, guaranteed by JSON.stringify', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.claude\/settings\.json"/)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBeDefined()
    expect(match?.[1]).not.toContain("'")
  })

  test('hook script + global settings + onboarding seed are ALL omitted when claudeCode: false (no orphan artifacts for agents that do not use claude)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: false }))
    expect(out).not.toContain('typeclaw-cc-stop-hook')
    expect(out).not.toContain('typeclaw-cc-session-start-hook')
    expect(out).not.toContain('.claude/settings.json')
    expect(out).not.toContain('hasCompletedOnboarding')
  })

  test('hook script + global settings appear in the versioned (base-image) form too — drift guard so GHCR-base users get the same Stop-hook wiring as dev/inline users', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('typeclaw-cc-stop-hook')
    expect(out).toContain('"$HOME/.claude/settings.json"')
  })

  test('hook layer runs BEFORE the entrypoint shim — same final-layer-is-last invariant as the rest of Layer 5.6', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const hookIdx = out.indexOf('typeclaw-cc-stop-hook')
    const shimIdx = out.indexOf(TYPECLAW_ENTRYPOINT_PATH)
    expect(hookIdx).toBeGreaterThan(-1)
    expect(shimIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(shimIdx)
  })

  test('hook script writes go BEFORE the claude --version smoke test, no — they go AFTER, because the smoke test verifies claude itself launches without onboarding (the hook + settings layer is downstream of the install)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const smokeIdx = out.indexOf('claude --version > /dev/null')
    const hookScriptIdx = out.indexOf('cat > /usr/local/bin/typeclaw-cc-stop-hook')
    const settingsIdx = out.indexOf('"$HOME/.claude/settings.json"')
    expect(smokeIdx).toBeGreaterThan(-1)
    expect(hookScriptIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(smokeIdx).toBeLessThan(hookScriptIdx)
    expect(hookScriptIdx).toBeLessThan(settingsIdx)
  })

  test('the onboarding seed is the LAST write in the layer — preserves the "final layer state is exactly the seeded config" invariant even with the new hook/settings writes interleaved', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const settingsIdx = out.indexOf('"$HOME/.claude/settings.json"')
    const seedIdx = out.indexOf('"hasCompletedOnboarding":true')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(seedIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeLessThan(seedIdx)
  })

  test('the heredoc is the only build-time mechanism that writes the Stop hook script (no second printf-based copy that could drift) — single source of truth for the script body', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const heredocMatches = out.match(/cat > \/usr\/local\/bin\/typeclaw-cc-stop-hook/g) ?? []
    expect(heredocMatches.length).toBe(1)
  })
})

describe('Claude Code global SessionStart hook (pre-baked into the image)', () => {
  function extractSessionStartScript(out: string): string {
    const match = out.match(
      /cat > \/usr\/local\/bin\/typeclaw-cc-session-start-hook <<'TYPECLAW_CC_SESSION_START_HOOK_EOF'\n([\s\S]*?)TYPECLAW_CC_SESSION_START_HOOK_EOF/,
    )
    if (!match || !match[1]) throw new Error('typeclaw-cc-session-start-hook heredoc not found')
    return match[1]
  }

  test('claudeCode: true writes the SessionStart hook script at /usr/local/bin/typeclaw-cc-session-start-hook (stable absolute path, chmod +x in the same RUN as the Stop hook)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('cat > /usr/local/bin/typeclaw-cc-session-start-hook')
    expect(out).toContain('chmod +x /usr/local/bin/typeclaw-cc-session-start-hook')
  })

  test("SessionStart hook script writes $PWD/.session-id with the validated UUID — operator polls this file after spawning claude to learn the session UUID (and then watches .done-<uuid> per turn). Without this file the operator would have to parse claude's TUI startup output to discover the UUID, which is exactly the fragile capture-pane heuristic the skill avoids.", () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('"${PWD}/.session-id"')
    expect(script).toContain('printf')
  })

  test('SessionStart hook script uses a PID-scoped temp filename (.session-id.$$.tmp) — without it, two SessionStart hooks firing concurrently in the same cwd race on .session-id.tmp, with the loser failing `mv` and returning non-zero (which Claude Code may surface as a hook error). Empirically verified inside docker: PID-scoping fixes the concurrent-mv race. (The SessionStart hook reads stdin directly via Bun.stdin.stream() so it does NOT need a stdin temp file; only the output .session-id is staged via a temp file.)', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('.session-id.$$.tmp')
  })

  test('SessionStart hook script extracts session_id via `bun -e` (real JSON parser, not sed) and validates it against the same UUID-shape regex as the Stop hook — defense against path-traversal session_id values like "../etc/passwd", and so the operator reading .session-id can trust it as a filename component', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toContain('bun -e ')
    expect(script).toContain('Bun.stdin')
    expect(script).toContain('case "$sid" in')
    expect(script).toContain('sid=malformed')
    expect(script).not.toContain('sed -n ')
    expect(script).toMatch(
      /\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]/,
    )
  })

  test("SessionStart hook writes .session-id atomically via temp-then-rename — the operator's polling reader never sees a half-written file even if it polls mid-hook-execution", () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).toMatch(/printf '%s\\n' "\$sid" > "\$tmp_out"\nmv "\$tmp_out" "\$\{PWD\}\/.session-id"/)
  })

  test('SessionStart hook script does NOT use $CLAUDE_PROJECT_DIR — same critical-bug guard as the Stop hook (CLAUDE_PROJECT_DIR resolves to git-root, not cwd, per anthropics/claude-code#27343 + #44450)', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ claudeCode: true })))
    expect(script).not.toContain('CLAUDE_PROJECT_DIR')
  })

  test('SessionStart hook layer is omitted when claudeCode: false (no orphan SessionStart artifacts)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: false }))
    expect(out).not.toContain('typeclaw-cc-session-start-hook')
    expect(out).not.toContain('SessionStart')
  })

  test('both hook scripts are made executable in the SAME chmod +x invocation — defense against a future edit that accidentally only chmods one (the other would still be installed but Claude Code would silently fail to invoke it, surfacing as a polling-loop timeout)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('chmod +x /usr/local/bin/typeclaw-cc-session-start-hook /usr/local/bin/typeclaw-cc-stop-hook')
  })
})

describe('codexCli toggle', () => {
  test('defaults to false (the install layer is opt-in via the typeclaw-codex-cli skill)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}))
    expect(out).not.toContain('@openai/codex')
  })

  test('codexCli: false omits the install layer entirely', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: false }))
    expect(out).not.toContain('@openai/codex')
  })

  test('codexCli: true emits the bun-install layer in the inline (dev) form', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('bun install -g @openai/codex')
  })

  test('codexCli: true emits the install layer in the versioned (base-image) form too — drift guard', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('bun install -g @openai/codex')
  })

  test('install layer renders before the entrypoint shim so the shim is always the final RUN', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    const codexIdx = out.indexOf('@openai/codex')
    const shimIdx = out.indexOf(TYPECLAW_ENTRYPOINT_PATH)
    expect(codexIdx).toBeGreaterThan(-1)
    expect(shimIdx).toBeGreaterThan(-1)
    expect(codexIdx).toBeLessThan(shimIdx)
  })

  test('install layer uses the bun install cache mount so re-runs are free when the package version is cached', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('--mount=type=cache,target=/root/.bun/install/cache,sharing=locked')
  })

  test('install layer smoke-tests the binary with `codex --version` so a broken install fails the build instead of the first delegation', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('codex --version > /dev/null')
  })

  test('install layer is rejected by parse: codexCli does not accept string version pins (the @openai/codex npm package is pinned in the install layer, not via this toggle)', () => {
    expect(() => dockerfileSchema.parse({ codexCli: '1.2.3' })).toThrow()
  })

  test('base Dockerfile never embeds the codex install — toggle-driven layers stay in the per-agent file so changing the flag does not rebuild the base image', () => {
    expect(buildBaseDockerfile()).not.toContain('@openai/codex')
  })

  test('install layer does NOT pre-seed any onboarding flag — Codex CLI has no theme picker or skip-onboarding equivalent, and pre-seeding auth/trust state would silently widen the trust surface the operator has not consented to', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).not.toContain('hasCompletedOnboarding')
    expect(out).not.toContain('"trustedDirectories"')
    expect(out).not.toContain('"approval_policy":"never"')
    expect(out).not.toContain('"approval_policy": "never"')
  })

  test('codexCli toggle does NOT touch any Claude Code paths — distinct hook script names (typeclaw-cx-* vs typeclaw-cc-*) and distinct settings file (~/.codex/hooks.json vs ~/.claude/settings.json) so an agent with BOTH toggles on does not have the two CLIs racing on the same sentinel files', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true, claudeCode: false }))
    expect(out).not.toContain('typeclaw-cc-')
    expect(out).not.toContain('.claude/settings.json')
    expect(out).not.toContain('claude.ai/install.sh')
  })

  test('both toggles can coexist — codex and claude installs render side-by-side without interfering, distinct paths', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true, claudeCode: true }))
    expect(out).toContain('@openai/codex')
    expect(out).toContain('claude.ai/install.sh')
    expect(out).toContain('typeclaw-cx-stop-hook')
    expect(out).toContain('typeclaw-cc-stop-hook')
    expect(out).toContain('.codex/hooks.json')
    expect(out).toContain('.claude/settings.json')
  })
})

describe('Codex CLI global Stop hook (pre-baked into the image)', () => {
  function extractStopHookScript(out: string): string {
    const match = out.match(
      /cat > \/usr\/local\/bin\/typeclaw-cx-stop-hook <<'TYPECLAW_CX_STOP_HOOK_EOF'\n([\s\S]*?)TYPECLAW_CX_STOP_HOOK_EOF/,
    )
    if (!match || !match[1]) throw new Error('typeclaw-cx-stop-hook heredoc not found')
    return match[1]
  }

  function extractGlobalHooks(out: string): unknown {
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.codex\/hooks\.json"/)
    if (!match || !match[1]) throw new Error('~/.codex/hooks.json printf not found')
    return JSON.parse(match[1])
  }

  test('codexCli: true writes the hook script at /usr/local/bin/typeclaw-cx-stop-hook (stable absolute path) and chmods it executable in the same chmod call as the SessionStart hook', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('cat > /usr/local/bin/typeclaw-cx-stop-hook')
    expect(out).toMatch(/chmod \+x [^\n]*\/usr\/local\/bin\/typeclaw-cx-stop-hook/)
  })

  test('hook script is delivered via a single-quoted heredoc so $PWD and $sid survive docker build and are expanded at runtime (NOT at build time)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain("<<'TYPECLAW_CX_STOP_HOOK_EOF'")
    const script = extractStopHookScript(out)
    expect(script).toContain('${PWD}/sentinel-${sid}.json')
    expect(script).toContain('${PWD}/.done-${sid}')
  })

  test('hook script writes to $PWD, NOT $CLAUDE_PROJECT_DIR or any Codex equivalent — same critical-bug guard as the Claude Code Stop hook', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).not.toContain('CLAUDE_PROJECT_DIR')
    expect(script).not.toContain('CODEX_PROJECT_DIR')
  })

  test('hook script encodes session_id in the filename — concurrent-codex race safety', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('sentinel-${sid}.json')
    expect(script).toContain('.done-${sid}')
    expect(script).not.toMatch(/"\$\{PWD\}\/sentinel\.json"/)
  })

  test('hook script extracts session_id via `bun -e` (real JSON parser, not sed) — defense against shadow attacks where last_assistant_message contains escaped `"session_id":"..."` text that greedy sed would extract instead of the structural top-level field', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('bun -e ')
    expect(script).toContain('Bun.file')
    expect(script).toContain('.session_id')
    expect(script).not.toContain('sed -n ')
    expect(script).not.toContain('jq ')
    expect(script).not.toContain('python3')
  })

  test('hook script validates extracted session_id against UUID shape (8-4-4-4-12 hex)', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('case "$sid" in')
    expect(script).toMatch(
      /\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]-\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]/,
    )
  })

  test('hook script falls back to sid=malformed when session_id extraction or validation fails', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('sid=malformed')
  })

  test('hook script writes sentinel atomically via temp-then-rename — the polling loop never sees a partial JSON payload. The temp file lives under .cx-stop-hook-in.<PID> (distinct from the Claude Code .cc-stop-hook-in.<PID>) so an agent with both toggles on does not race on the same temp file', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('.cx-stop-hook-in')
    expect(script).not.toContain('.cc-stop-hook-in')
    expect(script).toMatch(/cat > "\$tmp_in"[\s\S]*mv "\$tmp_in" "\$\{PWD\}\/sentinel-/)
  })

  test('Stop hook script reads the temp file via process.argv[1] (NOT argv[2]) — bun -e strips the -e flag and code-string from argv, unlike Node which preserves them', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('process.argv[1]')
    expect(script).not.toContain('process.argv[2]')
  })

  test('hook script touches .done-<sid> AFTER moving sentinel-<sid>.json into place — polling loop watches .done as the readiness signal', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    const mvIdx = script.indexOf('mv "$tmp_in"')
    const touchIdx = script.indexOf('touch "${PWD}/.done-${sid}"')
    expect(mvIdx).toBeGreaterThan(-1)
    expect(touchIdx).toBeGreaterThan(-1)
    expect(mvIdx).toBeLessThan(touchIdx)
  })

  test('hook script sets `set -eu` for fail-fast on missing PWD or extraction errors', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('set -eu')
  })

  test('hook script has a POSIX shebang (/bin/sh, not /bin/bash)', () => {
    const script = extractStopHookScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })

  test('global hooks.json is written at ~/.codex/hooks.json (user-level scope, applies to every codex invocation regardless of cwd)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('mkdir -p "$HOME/.codex"')
    expect(out).toContain('"$HOME/.codex/hooks.json"')
  })

  test('global hooks.json registers BOTH the SessionStart hook and the Stop hook with the correct shape', () => {
    const parsed = extractGlobalHooks(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(parsed).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: '/usr/local/bin/typeclaw-cx-session-start-hook', args: [] }],
          },
        ],
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '/usr/local/bin/typeclaw-cx-stop-hook', args: [] }],
          },
        ],
      },
    })
  })

  test('SessionStart matcher is `startup|resume` (the two upstream-documented Codex session-origin types — Codex has no `/clear` command or auto-compaction event that Claude Code matches against)', () => {
    const parsed = extractGlobalHooks(buildDockerfile(dockerfileSchema.parse({ codexCli: true }))) as {
      hooks: { SessionStart: Array<{ matcher: string }> }
    }
    expect(parsed.hooks.SessionStart[0]?.matcher).toBe('startup|resume')
  })

  test('hooks.json uses exec form (args: []) so Codex CLI invokes via execvp with kernel-handled shebang and no shell tokenization', () => {
    const parsed = extractGlobalHooks(buildDockerfile(dockerfileSchema.parse({ codexCli: true }))) as {
      hooks: { Stop: Array<{ hooks: Array<{ args?: unknown[] }> }> }
    }
    const args = parsed.hooks.Stop[0]?.hooks[0]?.args
    expect(args).toBeDefined()
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual([])
  })

  test('global hooks.json command paths are absolute, not relative — user-level hooks fire with arbitrary cwds', () => {
    const parsed = extractGlobalHooks(buildDockerfile(dockerfileSchema.parse({ codexCli: true }))) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    const cmd = parsed.hooks.Stop[0]?.hooks[0]?.command
    expect(cmd).toBeDefined()
    expect(cmd?.startsWith('/')).toBe(true)
  })

  test('global hooks.json payload contains no single quotes — required by the printf %s shell-quoting pattern, guaranteed by JSON.stringify', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    const match = out.match(/printf '%s\\n' '([^']+)' > "\$HOME\/\.codex\/hooks\.json"/)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBeDefined()
    expect(match?.[1]).not.toContain("'")
  })

  test('hook script + global hooks.json are ALL omitted when codexCli: false (no orphan artifacts for agents that do not use codex)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: false }))
    expect(out).not.toContain('typeclaw-cx-stop-hook')
    expect(out).not.toContain('typeclaw-cx-session-start-hook')
    expect(out).not.toContain('.codex/hooks.json')
  })

  test('hook script + global hooks.json appear in the versioned (base-image) form too — drift guard so GHCR-base users get the same hook wiring as dev/inline users', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('typeclaw-cx-stop-hook')
    expect(out).toContain('"$HOME/.codex/hooks.json"')
  })

  test('hook layer runs BEFORE the entrypoint shim — same final-layer-is-last invariant as the rest of the toggle layers', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    const hookIdx = out.indexOf('typeclaw-cx-stop-hook')
    const shimIdx = out.indexOf(TYPECLAW_ENTRYPOINT_PATH)
    expect(hookIdx).toBeGreaterThan(-1)
    expect(shimIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeLessThan(shimIdx)
  })

  test('the heredoc is the only build-time mechanism that writes the Stop hook script (no second printf-based copy that could drift) — single source of truth for the script body', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    const heredocMatches = out.match(/cat > \/usr\/local\/bin\/typeclaw-cx-stop-hook/g) ?? []
    expect(heredocMatches.length).toBe(1)
  })
})

describe('Codex CLI global SessionStart hook (pre-baked into the image)', () => {
  function extractSessionStartScript(out: string): string {
    const match = out.match(
      /cat > \/usr\/local\/bin\/typeclaw-cx-session-start-hook <<'TYPECLAW_CX_SESSION_START_HOOK_EOF'\n([\s\S]*?)TYPECLAW_CX_SESSION_START_HOOK_EOF/,
    )
    if (!match || !match[1]) throw new Error('typeclaw-cx-session-start-hook heredoc not found')
    return match[1]
  }

  test('codexCli: true writes the SessionStart hook script at /usr/local/bin/typeclaw-cx-session-start-hook', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('cat > /usr/local/bin/typeclaw-cx-session-start-hook')
    expect(out).toContain('chmod +x /usr/local/bin/typeclaw-cx-session-start-hook')
  })

  test('SessionStart hook script writes $PWD/.session-id with the validated UUID — operator polls this file after spawning codex to learn the session UUID', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('"${PWD}/.session-id"')
    expect(script).toContain('printf')
  })

  test('SessionStart hook script uses a PID-scoped temp filename (.session-id.$$.tmp) — without it, two SessionStart hooks firing concurrently in the same cwd race on .session-id.tmp', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('.session-id.$$.tmp')
  })

  test('SessionStart hook script extracts session_id via `bun -e` and validates against UUID shape — same security model as the Stop hook', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toContain('bun -e ')
    expect(script).toContain('Bun.stdin')
    expect(script).toContain('case "$sid" in')
    expect(script).toContain('sid=malformed')
    expect(script).not.toContain('sed -n ')
  })

  test('SessionStart hook writes .session-id atomically via temp-then-rename', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).toMatch(/printf '%s\\n' "\$sid" > "\$tmp_out"\nmv "\$tmp_out" "\$\{PWD\}\/.session-id"/)
  })

  test('SessionStart hook script does NOT use $CLAUDE_PROJECT_DIR or $CODEX_PROJECT_DIR — operator-controlled cwd via tmux -c is the source of truth', () => {
    const script = extractSessionStartScript(buildDockerfile(dockerfileSchema.parse({ codexCli: true })))
    expect(script).not.toContain('CLAUDE_PROJECT_DIR')
    expect(script).not.toContain('CODEX_PROJECT_DIR')
  })

  test('SessionStart hook layer is omitted when codexCli: false', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: false }))
    expect(out).not.toContain('typeclaw-cx-session-start-hook')
  })

  test('both hook scripts are made executable in the SAME chmod +x invocation — defense against a future edit that accidentally only chmods one', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ codexCli: true }))
    expect(out).toContain('chmod +x /usr/local/bin/typeclaw-cx-session-start-hook /usr/local/bin/typeclaw-cx-stop-hook')
  })
})

function amd64ElseBranchPackages(out: string): string[] {
  const m = out.match(/else \\\n\s+apt-get install -y --no-install-recommends \\\n\s+([^\n]+); \\\n\s+fi/)
  if (!m || !m[1]) throw new Error('amd64 else-branch apt-get install line not found')
  return m[1].split(/\s+/).filter(Boolean)
}

function arm64IfBranchPackages(out: string): string[] {
  const m = out.match(
    /if \[ "\$TARGETARCH" = "arm64" \]; then \\\n\s+apt-get install -y --no-install-recommends ([^\n]+); \\\n\s+else/,
  )
  if (!m || !m[1]) throw new Error('arm64 if-branch apt-get install line not found')
  return m[1].split(/\s+/).filter(Boolean)
}

describe('Chrome runtime deps (amd64)', () => {
  test('amd64 branch installs libglib2.0-0t64 — without it Chrome dies on launch with `libglib-2.0.so.0: cannot open shared object file`', () => {
    expect(amd64ElseBranchPackages(buildDockerfile())).toContain('libglib2.0-0t64')
  })

  test('amd64 branch installs the full Playwright-tested chromium dep set (regression guard against silent drops on agent-browser refactors)', () => {
    const pkgs = amd64ElseBranchPackages(buildDockerfile())
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) expect(pkgs).toContain(p)
  })

  test('amd64 else-branch (Chrome runtime libs) does not install fonts — fonts are not a launch-time linker concern, they layer in via the cjkFonts toggle', () => {
    const pkgs = amd64ElseBranchPackages(buildDockerfile())
    expect(pkgs.some((p) => p.startsWith('fonts-'))).toBe(false)
  })

  test('arm64 branch installs chromium only — Chrome runtime libs are unnecessary when chromium pulls its own deps via apt', () => {
    const pkgs = arm64IfBranchPackages(buildDockerfile())
    expect(pkgs).toContain('chromium')
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) expect(pkgs).not.toContain(p)
  })

  test('Chrome runtime deps are installed in Layer 2 (before agent-browser CLI install in Layer 4), not only via the Layer 5 --with-deps backstop', () => {
    const out = buildDockerfile()
    const layer2Idx = out.indexOf('libglib2.0-0t64')
    const layer4Idx = out.indexOf('bun install -g agent-browser@^0.27.0')
    expect(layer2Idx).toBeGreaterThan(-1)
    expect(layer4Idx).toBeGreaterThan(-1)
    expect(layer2Idx).toBeLessThan(layer4Idx)
  })
})

describe('cjkFonts toggle', () => {
  test('default is auto: with no host-locale signal, fonts-noto-cjk is omitted so the common (non-CJK) case skips the ~89MB layer', () => {
    const out = buildDockerfile()
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test("cjkFonts: 'auto' with cjkFontsAuto=true installs fonts-noto-cjk so a CJK host renders glyphs out of the box", () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: 'auto' }), { cjkFontsAuto: true })
    expect(aptPackages(out)).toContain('fonts-noto-cjk')
  })

  test("cjkFonts: 'auto' with cjkFontsAuto=false omits fonts-noto-cjk", () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: 'auto' }), { cjkFontsAuto: false })
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test('explicit cjkFonts: true overrides auto-detection — installs even when cjkFontsAuto=false', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: true }), { cjkFontsAuto: false })
    expect(aptPackages(out)).toContain('fonts-noto-cjk')
  })

  test('explicit cjkFonts: false overrides auto-detection — omits even when cjkFontsAuto=true', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: false }), { cjkFontsAuto: true })
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test('fonts-noto-cjk lives on the toggle apt layer, not the Chrome-runtime-libs branch (so opt-out works without re-architecting the launch-deps invariant)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: true }))
    expect(aptPackages(out)).toContain('fonts-noto-cjk')
    expect(amd64ElseBranchPackages(out)).not.toContain('fonts-noto-cjk')
    expect(arm64IfBranchPackages(out)).not.toContain('fonts-noto-cjk')
  })

  test('versioned per-agent Dockerfile (base-image-pinning): cjkFonts: true emits fonts-noto-cjk in the per-agent toggle layer (NOT baked into the base image, so opt-out is honored regardless of base-image vintage)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: true }), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    const pkgs = aptInstallMatch![1]!.split(/\s+/).filter(Boolean)
    expect(pkgs).toContain('fonts-noto-cjk')
  })

  test('versioned per-agent Dockerfile (base-image-pinning): cjkFonts: false does not add fonts-noto-cjk on top of the base image', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: false }), { baseImageVersion: '0.1.1' })
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test('base Dockerfile does NOT install fonts-noto-cjk — fonts ride the per-agent toggle apt layer, never the shared base image, so cjkFonts: false truly skips the ~89MB even on GHCR-base agents', () => {
    expect(buildBaseDockerfile()).not.toContain('fonts-noto-cjk')
  })
})

describe('transformers native-deps layer (sharp + onnxruntime linux binaries)', () => {
  test('inline (dev) form installs @huggingface/transformers plus sharp and its arch-matched linux platform packages — without the explicit @img/sharp-linux-* install the container crashes at startup with "Could not load the sharp module using the linux-<arch> runtime", because the bind-mounted host node_modules carries macOS sharp binaries', () => {
    const out = buildDockerfile()
    expect(out).toContain('bun add')
    expect(out).toContain('@huggingface/transformers')
    expect(out).toContain('sharp@0.34.5')
    expect(out).toContain('"@img/sharp-linux-${SHARP_ARCH}@0.34.5"')
    expect(out).toContain('"@img/sharp-libvips-linux-${SHARP_ARCH}@1.2.4"')
  })

  test('layer resolves SHARP_ARCH from the real install arch via `uname -m` (aarch64/arm64 -> arm64, x86_64/amd64 -> x64), failing closed on unknown machines — NOT from the build arg `$TARGETARCH`, whose `:-amd64` default silently seeded x64 sharp packages on arm64 hosts built without buildx and crashed `typeclaw --help` with "Could not load the sharp module using the linux-arm64 runtime"', () => {
    for (const out of [
      buildDockerfile(),
      buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' }),
      buildBaseDockerfile(),
    ]) {
      expect(out).toContain(
        'SHARP_ARCH="$(case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac)"',
      )
      expect(out).not.toContain('${TARGETARCH:-amd64}')
    }
  })

  test('versioned (base-image) form installs the same native-deps set — drift guard so GHCR-base agents whose base image predates this fix still get linux sharp binaries seeded by the per-agent layer', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    expect(out).toContain('@huggingface/transformers')
    expect(out).toContain('sharp@0.34.5')
    expect(out).toContain('"@img/sharp-linux-${SHARP_ARCH}@0.34.5"')
    expect(out).toContain('"@img/sharp-libvips-linux-${SHARP_ARCH}@1.2.4"')
  })

  test('base Dockerfile installs the native-deps layer too — future base images are self-contained so a fresh GHCR-base agent does not depend on the per-agent layer to avoid the sharp crash', () => {
    const out = buildBaseDockerfile()
    expect(out).toContain('@huggingface/transformers')
    expect(out).toContain('sharp@0.34.5')
    expect(out).toContain('"@img/sharp-linux-${SHARP_ARCH}@0.34.5"')
    expect(out).toContain('"@img/sharp-libvips-linux-${SHARP_ARCH}@1.2.4"')
  })

  test('sharp and its libvips platform package are pinned to the same versions @huggingface/transformers@4.2.0 resolves (0.34.5 / 1.2.4) — mismatched sharp/libvips platform packages are a known load-time failure mode', () => {
    const out = buildDockerfile()
    const sharpVersions = out.match(/@img\/sharp-linux-\$\{SHARP_ARCH\}@(\S+?)"/)
    const libvipsVersions = out.match(/@img\/sharp-libvips-linux-\$\{SHARP_ARCH\}@(\S+?)"/)
    expect(sharpVersions?.[1]).toBe('0.34.5')
    expect(libvipsVersions?.[1]).toBe('1.2.4')
  })

  // The Layer 7 `bun add` runs at WORKDIR / with no project lockfile, so the
  // repo bun.lock does NOT constrain it. A bare `@huggingface/transformers`
  // (no version) resolves npm `latest` at build time and would drift past the
  // hard-pinned sharp/libvips below — the day a newer transformers ships, the
  // container installs it against the fixed sharp pins and crashes at import.
  // These guards fail if the version is ever dropped back to a caret/bare name.
  for (const [label, render] of [
    ['inline (dev)', () => buildDockerfile()],
    ['versioned (base-image)', () => buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })],
    ['base', () => buildBaseDockerfile()],
  ] as const) {
    test(`${label} form pins @huggingface/transformers to an EXACT version (not a caret/bare name) so the lockfile-free Layer 7 install can't drift past the sharp pins`, () => {
      const out = render()
      expect(out).toContain(`@huggingface/transformers@${TRANSFORMERS_VERSION}`)
      expect(out).not.toContain('@huggingface/transformers \\')
      expect(out).not.toContain('@huggingface/transformers@^')
    })
  }

  test('TRANSFORMERS_VERSION matches the @huggingface/transformers pin in package.json — host download (models.ts) and container install (Layer 7) must resolve the same library, and the package.json pin is exact (no caret) so the repo install agrees', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@huggingface/transformers']).toBe(TRANSFORMERS_VERSION)
  })

  // Regression guard for the bind-mount masking failure. `typeclaw start`
  // bind-mounts the host agent folder over /agent at runtime, so a `bun add`
  // run under WORKDIR /agent populates /agent/node_modules — which is hidden
  // behind the mount at runtime, so the linux sharp binaries never resolve and
  // the container crashes ("Could not load the sharp module"). The install MUST
  // run from WORKDIR / (landing in the unmasked /node_modules) and then restore
  // WORKDIR /agent. These tests fail if either WORKDIR is dropped.
  for (const [label, render] of [
    ['inline (dev)', () => buildDockerfile()],
    ['versioned (base-image)', () => buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })],
    ['base', () => buildBaseDockerfile()],
  ] as const) {
    test(`${label} form installs the native deps from / (unmasked by the /agent bind mount) and restores WORKDIR /agent`, () => {
      const out = render()
      const installIdx = out.indexOf('@img/sharp-libvips-linux-${SHARP_ARCH}@1.2.4')
      expect(installIdx).toBeGreaterThan(-1)

      const beforeInstall = out.slice(0, installIdx)
      const afterInstall = out.slice(installIdx)

      // WORKDIR / must immediately precede the install (no intervening WORKDIR).
      const lastWorkdirBefore = beforeInstall.lastIndexOf('\nWORKDIR ')
      expect(beforeInstall.slice(lastWorkdirBefore)).toContain('\nWORKDIR /\n')

      // WORKDIR /agent must be restored right after the install.
      expect(afterInstall).toContain('\nWORKDIR /agent')
    })
  }
})

describe('curl-impersonate layer', () => {
  test('embeds the pinned version in the release URL — bumping a constant is a deliberate, reviewable change, not a moving "latest" target', () => {
    const out = buildDockerfile()
    expect(out).toContain(
      `https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.`,
    )
  })

  test('verifies the tarball sha256 — every reviewer can trace the constant to the layer that enforces it, and a tampered binary would fail the build', () => {
    const out = buildDockerfile()
    expect(out).toContain(CURL_IMPERSONATE_SHA256_AMD64)
    expect(out).toContain(CURL_IMPERSONATE_SHA256_ARM64)
    expect(out).toContain('sha256sum -c -')
  })

  test('branches by TARGETARCH so the same Dockerfile produces correct binaries on amd64 and arm64', () => {
    const out = buildDockerfile()
    expect(out).toMatch(/TARGETARCH.*arm64.*aarch64-linux-gnu/s)
    expect(out).toContain('x86_64-linux-gnu')
  })

  test('extracts to /usr/local/bin (on $PATH) and smoke-tests the wrapper at build time so a missing profile fails the build, not the first search', () => {
    const out = buildDockerfile()
    expect(out).toContain('tar -xzf curl-impersonate.tar.gz -C /usr/local/bin/')
    expect(out).toContain(`/usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version`)
  })

  test('curl-impersonate layer is between Layer 2 (apt) and Layer 4 (agent-browser) so an agent-browser bump does not invalidate it and the apt baseline (curl, ca-certificates, tar) is satisfied', () => {
    const out = buildDockerfile()
    const aptIdx = out.indexOf('libglib2.0-0t64') // marker for Layer 2's else-branch (last apt thing in that block)
    const curlImpersonateIdx = out.indexOf('curl-impersonate.tar.gz')
    const agentBrowserIdx = out.indexOf('bun install -g agent-browser@^0.27.0')
    expect(aptIdx).toBeGreaterThan(-1)
    expect(curlImpersonateIdx).toBeGreaterThan(-1)
    expect(agentBrowserIdx).toBeGreaterThan(-1)
    expect(aptIdx).toBeLessThan(curlImpersonateIdx)
    expect(curlImpersonateIdx).toBeLessThan(agentBrowserIdx)
  })
})

describe('cloudflared layer', () => {
  test('cloudflared: true emits the pinned cloudflared download layer', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: true }))

    expect(out).toContain(`${CLOUDFLARED_RELEASE_URL_BASE}/${CLOUDFLARED_VERSION}/cloudflared-linux-`)
    expect(out).toContain('/usr/local/bin/cloudflared --version')
  })

  test('cloudflared: false omits the layer entirely', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: false }))

    expect(out).not.toContain('cloudflared-linux-')
    expect(out).not.toContain('/usr/local/bin/cloudflared --version')
  })

  test('default config omits the cloudflared layer (default false to skip the ~38MB binary; tunnel add / channel add flip it on and prompt for restart)', () => {
    const out = buildDockerfile()

    expect(out).not.toContain('cloudflared-linux-')
    expect(out).not.toContain('/usr/local/bin/cloudflared --version')
  })

  test('cloudflared layer appears after curl-impersonate and before the entrypoint shim', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: true }))
    const curlIdx = out.indexOf('curl-impersonate.tar.gz')
    const cloudflaredIdx = out.indexOf('cloudflared-linux-')
    const entrypointIdx = out.indexOf(`base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)

    expect(curlIdx).toBeGreaterThan(-1)
    expect(cloudflaredIdx).toBeGreaterThan(-1)
    expect(entrypointIdx).toBeGreaterThan(-1)
    expect(curlIdx).toBeLessThan(cloudflaredIdx)
    expect(cloudflaredIdx).toBeLessThan(entrypointIdx)
  })
})

// The base image (ghcr.io/typeclaw/typeclaw-base) and the per-agent
// Dockerfile (emitted by `typeclaw start`) MUST agree on every toolchain
// version, library path, and binary location. When they don't, the
// per-agent Dockerfile's eventual FROM line inherits a base whose contents
// don't match what buildDockerfile() assumes, and the agent fails at
// runtime in subtle ways: web_search silently regresses when curl-impersonate
// is the wrong version, Chrome fails to launch when a runtime lib is
// missing, etc. These tests lock the structural invariant that both
// outputs share the same toolchain pins, install paths, and Layer 0 cache
// trick — so a new toolchain pin in buildDockerfile() that does not also
// appear in buildBaseDockerfile() fails CI.
describe('base ↔ per-agent Dockerfile drift guard', () => {
  test('base Dockerfile pins the same curl-impersonate version, sha256s, and profile as the per-agent Dockerfile', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain(CURL_IMPERSONATE_VERSION)
    expect(base).toContain(CURL_IMPERSONATE_SHA256_AMD64)
    expect(base).toContain(CURL_IMPERSONATE_SHA256_ARM64)
    expect(base).toContain(`/usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version`)
  })

  test('base Dockerfile installs the full Playwright-tested chromium runtime dep set on amd64 — same list the per-agent Dockerfile depends on Chrome to find at launch time', () => {
    const base = buildBaseDockerfile()
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) {
      expect(base).toContain(p)
    }
  })

  test('base Dockerfile installs the agent-browser CLI to the same global location the per-agent Dockerfile expects', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('bun install -g agent-browser@^0.27.0')
  })

  test('base Dockerfile downloads Chrome for Testing on amd64 — without it the per-agent image would FROM a base that lacks the browser binary and `agent-browser install` would have to redo it', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('agent-browser install --with-deps')
  })

  test('base Dockerfile points agent-browser at the apt chromium on arm64 (no Chrome for Testing download path on that arch)', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('/root/.agent-browser/config.json')
    expect(base).toContain('/usr/bin/chromium')
  })

  test('base Dockerfile omits gh keyring bootstrap — toggle-driven layers live in the per-agent Dockerfile so typeclaw.json toggles do not force a base-image rebuild', () => {
    const base = buildBaseDockerfile()
    expect(base).not.toContain('cli.github.com/packages')
    expect(base).not.toContain('githubcli-archive-keyring.gpg')
  })

  test('base Dockerfile main apt-get install line installs only the baseline packages (no gh/python/tmux/ffmpeg/xvfb — xvfb is a toggle layered onto the base by the per-agent Dockerfile)', () => {
    const base = buildBaseDockerfile()
    const match = base.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+?) \\\n/)
    if (!match || !match[1]) throw new Error('main apt-get install line not found in base Dockerfile')
    const pkgs = match[1].split(/\s+/).filter(Boolean)
    expect(pkgs).toEqual([
      'git',
      'ca-certificates',
      'curl',
      'gnupg',
      'iptables',
      'util-linux',
      'bubblewrap',
      'jq',
      'libgomp1',
    ])
  })

  test('base Dockerfile uses the same BuildKit syntax pragma and base image as the per-agent Dockerfile so layer caching across the two is possible', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('# syntax=docker/dockerfile:1.7')
    expect(base).toContain('FROM oven/bun:1-slim')
    expect(base).toContain('WORKDIR /agent')
  })

  test('base Dockerfile preserves the apt-keep-cache trick from Layer 0 — without it, cache mounts on /var/cache/apt are useless', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('docker-clean')
    expect(base).toContain('Keep-Downloaded-Packages "true"')
  })
})

// Count of RUN blocks that match a marker pattern. Used by the versioned-
// form tests to assert structural absence of heavy layers without coupling
// to specific package names or comment prose.
function countRunBlocksMatching(out: string, pattern: RegExp): number {
  return out.split(/\n(?=RUN )/).filter((block) => block.startsWith('RUN ') && pattern.test(block)).length
}

describe('versioned per-agent Dockerfile (base-image-pinning)', () => {
  test('FROMs ghcr.io/typeclaw/typeclaw-base at the requested version', () => {
    // given: a versioned build option
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })

    // then: the FROM line pins the GHCR base image, not oven/bun
    expect(out).toContain(`FROM ${GHCR_BASE_IMAGE_REPO}:0.1.1`)
    expect(out).not.toContain('FROM oven/bun:1-slim')
  })

  test('FROM tag is interpolated verbatim with no coercion', () => {
    // given: an arbitrary version string (the function must not normalize, parse, or rewrite it)
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '9.99.99-beta.1' })

    // then: the tag passes through unchanged
    expect(out).toContain(`FROM ${GHCR_BASE_IMAGE_REPO}:9.99.99-beta.1`)
  })

  test('omits the heavy stack RUN blocks — those layers live in the base image', () => {
    // given: a versioned build with default toggles
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })

    // then: no curl-impersonate download, no agent-browser install, no Chrome download
    // (cloudflared is intentionally NOT part of the prebuilt base image because it is
    // gated by docker.file.cloudflared; the per-agent versioned Dockerfile still emits
    // it when the toggle is on, so this regex deliberately excludes its sha256sum line)
    expect(countRunBlocksMatching(out, /curl-impersonate/)).toBe(0)
    expect(countRunBlocksMatching(out, /bun install -g agent-browser@\^0\.27\.0/)).toBe(0)
    expect(countRunBlocksMatching(out, /agent-browser install --with-deps/)).toBe(0)
    expect(countRunBlocksMatching(out, /apt-keep-cache|Keep-Downloaded-Packages/)).toBe(0)
    // and: no apt-get install line that also installs baseline packages
    expect(out).not.toMatch(/apt-get install[^\n]*\bgit\b[^\n]*\bca-certificates\b/)
  })

  test('with all toggles off: emits no apt install RUN block at all (zero-cost per-agent rebuild)', () => {
    // given: every toggle disabled, so no per-agent apt work is needed
    const out = buildDockerfile(
      dockerfileSchema.parse({
        tmux: false,
        gh: false,
        python: false,
        ffmpeg: false,
        cjkFonts: false,
        xvfb: false,
      }),
      {
        baseImageVersion: '0.1.1',
      },
    )

    // then: zero apt-get blocks
    expect(countRunBlocksMatching(out, /apt-get/)).toBe(0)
  })

  test('with toggles on: emits exactly one apt install RUN block containing only toggle packages', () => {
    // given: gh + tmux enabled, python + ffmpeg + cjkFonts + xvfb disabled
    const out = buildDockerfile(
      dockerfileSchema.parse({
        gh: true,
        tmux: true,
        python: false,
        ffmpeg: false,
        cjkFonts: false,
        xvfb: false,
      }),
      {
        baseImageVersion: '0.1.1',
      },
    )

    // then: there's an apt install line with exactly the toggle packages
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    const pkgs = aptInstallMatch![1]!.split(/\s+/).filter(Boolean)
    expect(pkgs).toEqual(['gh', 'tmux'])
  })

  test('versioned per-agent Dockerfile: xvfb: true (default) emits xvfb in the per-agent toggle layer so older base images without it still get a working virtual display', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    expect(aptInstallMatch![1]!.split(/\s+/).filter(Boolean)).toContain('xvfb')
  })

  test('versioned per-agent Dockerfile: xvfb: false omits xvfb on top of the base image (opt-out honored regardless of base-image vintage)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ xvfb: false }), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    if (aptInstallMatch !== null) {
      expect(aptInstallMatch[1]!.split(/\s+/).filter(Boolean)).not.toContain('xvfb')
    }
  })

  test('keeps gh keyring bootstrap when gh is enabled (per-agent toggle, not base-image content)', () => {
    // when: gh enabled
    const out = buildDockerfile(dockerfileSchema.parse({ gh: true }), { baseImageVersion: '0.1.1' })

    // then: the keyring layer is present
    expect(out).toMatch(/cli\.github\.com\/packages\/githubcli-archive-keyring\.gpg/)
  })

  test('drops gh keyring bootstrap when gh is disabled', () => {
    // when: gh disabled
    const out = buildDockerfile(dockerfileSchema.parse({ gh: false }), { baseImageVersion: '0.1.1' })

    // then: no keyring fetch
    expect(out).not.toMatch(/cli\.github\.com\/packages/)
  })

  test('keeps the per-agent tail: ENV vars, append lines, ENTRYPOINT, CMD', () => {
    // given: a custom append line
    const out = buildDockerfile(dockerfileSchema.parse({ append: ['ENV CUSTOM_TOOL=1'] }), {
      baseImageVersion: '0.1.1',
    })

    // then: every per-agent tail directive is present, in order
    expect(out).toContain('ENV NODE_ENV=production')
    expect(out).toContain('ENV AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger')
    expect(out).toContain('ENV CUSTOM_TOOL=1')
    expect(out).toContain(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)
    expect(out).toContain('CMD ["run"]')
    expect(out.indexOf('ENV CUSTOM_TOOL=1')).toBeLessThan(out.indexOf('ENTRYPOINT'))
  })

  test('emits the entrypoint shim install layer even though the base image already carries it (guards against older base images and shim source edits)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(out).toContain(`echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out).toContain(`chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out.indexOf(TYPECLAW_ENTRYPOINT_PATH)).toBeLessThan(out.indexOf('ENTRYPOINT'))
  })

  test('explicit baseImageVersion: null is identical to the default (inline) form', () => {
    // when: caller explicitly passes null vs omits the option
    const inlineExplicit = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: null })
    const inlineDefault = buildDockerfile(dockerfileSchema.parse({}))

    // then: outputs are byte-identical and use oven/bun (not GHCR base)
    expect(inlineExplicit).toBe(inlineDefault)
    expect(inlineExplicit).toContain('FROM oven/bun:1-slim')
    expect(inlineExplicit).not.toContain(GHCR_BASE_IMAGE_REPO)
  })
})

describe('network egress entrypoint shim', () => {
  test('re-execs the runtime under the host UID/GID after root-only bootstrap on both network paths', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const runtimeExecs = shim.match(/exec setpriv[\s\S]*?TYPECLAW_ENTRYPOINT_RUNTIME=1 "\$0" "\$@"/g) ?? []

    // then
    expect(shim).toContain('TYPECLAW_HOST_UID')
    expect(shim).toContain('TYPECLAW_HOST_GID')
    expect(shim).toContain('--reuid="$TYPECLAW_HOST_UID"')
    expect(shim).toContain('--regid="$TYPECLAW_HOST_GID"')
    expect(shim).toContain('--clear-groups')
    expect(runtimeExecs).toHaveLength(2)
  })

  test('uses a managed persistent runtime HOME and only chowns the TypeClaw-owned home subtree', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const executable = shim
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')

    // then
    expect(shim).toContain('runtime_home="$persist_root/runtime"')
    // The privilege-drop handoffs must NOT use --reset-env: it would wipe the
    // --env-file values and the TypeClaw-injected runtime variables. HOME is
    // overridden via the trailing `env`; everything else is forwarded.
    expect(executable).not.toContain('--reset-env')
    expect(shim.match(/-- env HOME="\$runtime_home" TYPECLAW_ENTRYPOINT_RUNTIME=1 "\$0" "\$@"/g)?.length).toBe(2)
    expect(shim).toContain('chown -R "$TYPECLAW_HOST_UID:$TYPECLAW_HOST_GID" "$persist_root"')
    expect(executable).not.toMatch(/chown -R [^\n]*\/agent(?:\s|$)/)
  })

  test('seeds the managed runtime HOME with image-baked Claude/Codex settings, before the chown, without clobbering persisted files', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('seed_runtime_home() {')
    // The image bakes these three files against /root at build time; the helper
    // copies them into the runtime HOME so onboarding + hooks survive the switch.
    expect(shim).toContain('.claude.json')
    expect(shim).toContain('.claude/settings.json')
    expect(shim).toContain('.codex/hooks.json')
    // cp -n → never overwrite a file the operator already persisted.
    expect(shim).toMatch(/cp -n "\$_src\/\.claude\.json"/)
    // Seeding must run BEFORE the chown so copied files inherit host ownership.
    const seedCallIdx = shim.indexOf('seed_runtime_home "$HOME" "$runtime_home"')
    const chownIdx = shim.indexOf('chown -R "$TYPECLAW_HOST_UID:$TYPECLAW_HOST_GID" "$persist_root"')
    expect(seedCallIdx).toBeGreaterThan(-1)
    expect(chownIdx).toBeGreaterThan(seedCallIdx)
  })

  test('runs persistent-home links, configured symlinks, Xvfb, and bun only in the non-root runtime phase', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const runtimeBranchStart = shim.indexOf('if [ "${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then')
    const bootstrapStart = shim.indexOf('if [ "${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1" ]; then')
    const runtimeBranch = shim.slice(runtimeBranchStart, bootstrapStart)

    // then
    expect(runtimeBranchStart).toBeGreaterThan(-1)
    expect(runtimeBranch).toContain('link_persistent_home_files')
    expect(runtimeBranch).toContain('link_configured_symlinks')
    expect(runtimeBranch).toContain('start_xvfb')
    expect(runtimeBranch).toContain(`exec bun run ${TYPECLAW_CLI_ENTRY} "$@"`)
  })

  test('off-switch path (network.blockInternal=false) installs no iptables rules and reaches the runtime phase before bun starts', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const offBranchStart = shim.indexOf('if [ "${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1" ]; then')
    const offBranchEnd = shim.indexOf('\nfi\n', offBranchStart)
    const offBranch = shim.slice(offBranchStart, offBranchEnd)

    // then
    expect(offBranch).not.toContain('iptables -A OUTPUT')
    expect(offBranch).toContain('TYPECLAW_ENTRYPOINT_RUNTIME=1')
    expect(offBranch).toContain(`exec bun run ${TYPECLAW_CLI_ENTRY} "$@"`)
  })

  test('shim self-heals on Xvfb presence: spawns Xvfb directly (not xvfb-run, which hangs as PID 1) and exports DISPLAY', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('command -v Xvfb')
    expect(shim).toContain('Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp')
    expect(shim).toContain('export DISPLAY=:99')
    // Strip the rationale-block comment lines that explain why we avoid
    // xvfb-run, then assert it is not invoked anywhere in executable code.
    const executable = shim
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable).not.toContain('xvfb-run')
  })

  test('shim waits for Xvfb socket to exist before exec-ing the agent (avoids "cannot open display" race)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('/tmp/.X11-unix/X99')
  })

  test('installs a REJECT rule for every IPv4 network in NETWORK_BLOCK_IPV4_NETS', () => {
    const shim = buildEntrypointShim()
    for (const net of NETWORK_BLOCK_IPV4_NETS) {
      expect(shim).toContain(`iptables -A OUTPUT -d ${net} -j REJECT --reject-with icmp-port-unreachable`)
    }
  })

  test('installs a REJECT rule for every IPv6 network in NETWORK_BLOCK_IPV6_NETS', () => {
    const shim = buildEntrypointShim()
    for (const net of NETWORK_BLOCK_IPV6_NETS) {
      expect(shim).toContain(`ip6tables -A OUTPUT -d ${net} -j REJECT --reject-with icmp6-port-unreachable`)
    }
  })

  test('blocks the canonical home-router scenario (192.168.0.0/16) and the AWS IMDS range (169.254.0.0/16)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('192.168.0.0/16')
    expect(shim).toContain('169.254.0.0/16')
  })

  test('allows loopback traffic explicitly so dev-server dogfooding still works', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('iptables -A OUTPUT -o lo -j ACCEPT')
    expect(shim).toContain('ip6tables -A OUTPUT -o lo -j ACCEPT')
  })

  test('allows ESTABLISHED,RELATED return traffic so Docker port-forward replies survive the RFC1918 REJECT', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
    expect(shim).toContain('ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
  })

  test('ESTABLISHED,RELATED ACCEPT runs before the RFC1918 REJECTs (first-match-wins ordering)', () => {
    const shim = buildEntrypointShim()
    const ctstateIdx = shim.indexOf('--ctstate ESTABLISHED,RELATED -j ACCEPT')
    const rejectIdx = shim.indexOf('192.168.0.0/16 -j REJECT')
    expect(ctstateIdx).toBeGreaterThan(-1)
    expect(rejectIdx).toBeGreaterThan(-1)
    expect(ctstateIdx).toBeLessThan(rejectIdx)
  })

  test('re-allows hostd narrowly: TCP, single port parsed from TYPECLAW_HOSTD_URL, IPv4-only', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('TYPECLAW_HOSTD_URL')
    expect(shim).toContain('getent ahostsv4 host.docker.internal')
    expect(shim).toContain('iptables -A OUTPUT -p tcp -d "$host_gw_ip" --dport "$hostd_port" -j ACCEPT')
  })

  test('does NOT ACCEPT the host gateway IP wholesale (closes the host-port-probing hole)', () => {
    const shim = buildEntrypointShim()
    expect(shim).not.toContain('iptables -A OUTPUT -d "$host_gw_ip" -j ACCEPT')
  })

  test('uses ahostsv4 so a resolver that prefers AAAA cannot crash the shim under set -e', () => {
    const shim = buildEntrypointShim()
    expect(shim).not.toMatch(/getent hosts host\.docker\.internal/)
    expect(shim).toContain('getent ahostsv4')
  })

  test('hostd carve-out is skipped when TYPECLAW_HOSTD_URL is unset (no ACCEPT rule installed at all)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/if \[ -n "\$\{TYPECLAW_HOSTD_URL:-\}" \]; then/)
    expect(shim).toMatch(/if \[ -n "\$\{hostd_port:-\}" \]; then/)
  })

  test('drops NET_ADMIN from bounding+inheritable+ambient sets before exec-ing (matches setpriv(1) warning)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain(
      `exec setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin -- bun run ${TYPECLAW_CLI_ENTRY} "$@"`,
    )
  })

  test('start_xvfb is called before bun on both network-policy runtime paths so DISPLAY is inherited', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const runtimeBranchStart = shim.indexOf('if [ "${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then')
    const runtimeBranchEnd = shim.indexOf('\nfi\n', runtimeBranchStart)
    const runtimeBranch = shim.slice(runtimeBranchStart, runtimeBranchEnd)
    const networkOnTail = shim.slice(shim.lastIndexOf('if [ -n "${TYPECLAW_HOST_UID:-}" ]'))

    // then
    expect(runtimeBranch.indexOf('start_xvfb\n')).toBeLessThan(
      runtimeBranch.indexOf(`exec bun run ${TYPECLAW_CLI_ENTRY}`),
    )
    expect(networkOnTail.indexOf('start_xvfb\n')).toBeLessThan(networkOnTail.indexOf(`exec setpriv --bounding-set`))
  })

  test('Xvfb drops NET_ADMIN via setpriv ONLY on the root/fallback path; in the non-root runtime phase it launches directly (CAP_SETPCAP is already gone, so a second bounding-set drop would fail)', () => {
    const shim = buildEntrypointShim()
    // Root/fallback path: the nested capability drop is retained.
    expect(shim).toMatch(
      /setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin \\\s+-- Xvfb :99/,
    )
    // Runtime phase: Xvfb is launched directly, guarded on TYPECLAW_ENTRYPOINT_RUNTIME.
    const fnStart = shim.indexOf('start_xvfb() {')
    const fnEnd = shim.indexOf('\n}\n', fnStart)
    const fnBody = shim.slice(fnStart, fnEnd)
    expect(fnBody).toContain('if [ "${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then')
    expect(fnBody).toMatch(/then\s+Xvfb :99 -screen 0 1920x1080x24 -ac \+extension RANDR -nolisten tcp/)
  })

  test('Xvfb startup failure is loud: helper detects an early exit via a status-file handshake (NOT kill -0, which reports zombies as alive) and exits non-zero with a stderr line on early exit or socket timeout', () => {
    const shim = buildEntrypointShim()
    // A monitor subshell waits for Xvfb and records its exit; the poll loop
    // reads the status file. The liveness probe must NOT be `kill -0`: it
    // returns success on an unreaped zombie, so an instantly-dead Xvfb was
    // reported as alive until the 3s timeout (the flaky-test root cause).
    expect(shim).not.toMatch(/^\s*if ! kill -0/m)
    expect(shim).toContain('xvfb_status="/tmp/typeclaw-xvfb-status.$$"')
    // The status-file check must precede the socket check, so a "created the
    // socket then immediately died" Xvfb is still treated as a failure.
    const statusIdx = shim.indexOf('[ -f "$xvfb_status" ]')
    const socketIdx = shim.indexOf('[ -S /tmp/.X11-unix/X99 ]')
    expect(statusIdx).toBeGreaterThan(-1)
    expect(socketIdx).toBeGreaterThan(statusIdx)
    expect(shim).toMatch(/typeclaw-entrypoint: Xvfb exited immediately[^\n]+\n[^\n]+exit 1/)
    expect(shim).toMatch(/typeclaw-entrypoint: Xvfb did not create \/tmp\/\.X11-unix\/X99[^\n]+\n[^\n]+exit 1/)
  })

  test('runs `set -eu` so an iptables failure brings PID 1 down (fail closed)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/^#!\/bin\/sh\n[\s\S]*?\nset -eu\n/)
  })

  test('on-mode side effects (iptables OUTPUT rules, the agent-exec setpriv drop) appear only on the on-branch — the off-branch execs the agent directly without firewall installation', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    expect(offBranchEnd).toBeGreaterThan(-1)
    const offBranch = shim.slice(0, offBranchEnd)
    expect(offBranch).not.toContain('iptables -A OUTPUT')
    expect(offBranch).toContain(`exec bun run ${TYPECLAW_CLI_ENTRY} "$@"`)
    expect(offBranch).not.toMatch(/exec setpriv [^\n]*-- bun run/)
  })

  test('per-agent Dockerfile wires ENTRYPOINT to the shim path, not directly to bun run', () => {
    const out = buildDockerfile()
    expect(out).toContain(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)
    expect(out).not.toContain('ENTRYPOINT ["bun", "run", "typeclaw"]')
    expect(out).toContain('CMD ["run"]')
  })

  test('per-agent Dockerfile installs the shim via base64 decode of buildEntrypointShim() output', () => {
    const out = buildDockerfile()
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(out).toContain(`echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out).toContain(`chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`)
  })

  test('base Dockerfile carries the same shim install so prebuilt-base images do not need a per-agent rebuild for it', () => {
    const base = buildBaseDockerfile()
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(base).toContain(encoded)
    expect(base).toContain(TYPECLAW_ENTRYPOINT_PATH)
  })

  test('resolver carve-out is gated on TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1 (default-on via container env, opt-out by setting to 0)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS:-0}" = "1"')
  })

  test('resolver carve-out reads /etc/resolv.conf and ACCEPTs udp+tcp dport 53 to each nameserver (fixes EC2 VPC DNS at 10.0.0.2)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('/etc/resolv.conf')
    expect(shim).toContain("awk '/^[[:space:]]*nameserver[[:space:]]+/{print $2}'")
    expect(shim).toContain('iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT')
    expect(shim).toContain('iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT')
  })

  test('resolver carve-out filters IPv6 nameservers via grep -v : so iptables never sees a v6 address', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/grep -v ':'/)
  })

  test('resolver carve-out is guarded by -r /etc/resolv.conf so a missing file fails open (not a crash under set -e)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('[ -r /etc/resolv.conf ]')
  })

  test('user-supplied allow list is driven by TYPECLAW_NETWORK_ALLOW (comma-separated)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_ALLOW:-}"')
    expect(shim).toContain("IFS=','")
    expect(shim).toContain('iptables -A OUTPUT -d "$cidr" -j ACCEPT')
  })

  test('ACCEPT carve-outs are written BEFORE the REJECT block list (first-match-wins on OUTPUT)', () => {
    const shim = buildEntrypointShim()
    const resolverIdx = shim.indexOf('--dport 53 -j ACCEPT')
    const allowIdx = shim.indexOf('iptables -A OUTPUT -d "$cidr" -j ACCEPT')
    const firstRejectIdx = shim.indexOf('-j REJECT --reject-with icmp-port-unreachable')

    expect(resolverIdx).toBeGreaterThan(-1)
    expect(allowIdx).toBeGreaterThan(-1)
    expect(firstRejectIdx).toBeGreaterThan(-1)
    expect(resolverIdx).toBeLessThan(firstRejectIdx)
    expect(allowIdx).toBeLessThan(firstRejectIdx)
  })

  test('resolver carve-out also runs in the on-branch only, never in the off path', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    const offBranch = shim.slice(0, offBranchEnd)
    expect(offBranch).not.toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS')
    expect(offBranch).not.toContain('TYPECLAW_NETWORK_ALLOW')
    expect(offBranch).not.toContain('/etc/resolv.conf')
  })

  test('allow loop unsets IFS after splitting so subsequent commands see a clean environment', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('unset IFS')
  })

  test('defines link_persistent_home_files that symlinks ~/.codex/auth.json into /agent/.typeclaw/home/ so OAuth credentials survive container restarts', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('link_persistent_home_files() {')
    // Default root is /agent/.typeclaw/home in production; the env var
    // override exists only so the shim's executable tests can rebind
    // the root to a tmpdir without touching /agent on the test host.
    expect(shim).toContain('persist_root="${TYPECLAW_PERSIST_HOME_ROOT:-/agent/.typeclaw/home}"')
    expect(shim).toContain('mkdir -p "$persist_root/.codex" "$HOME/.codex"')
    expect(shim).toContain('ln -sfn "$persist_root/.codex/auth.json" "$HOME/.codex/auth.json"')
  })

  test('defines link_configured_symlinks gated on TYPECLAW_SANDBOX_SYMLINKS and calls it from every runtime path', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const calls = shim.match(/^[ \t]*link_configured_symlinks$/gm)

    // then
    expect(shim).toContain('link_configured_symlinks() {')
    expect(shim).toContain('[ -n "${TYPECLAW_SANDBOX_SYMLINKS:-}" ] || return 0')
    // One shared non-root runtime branch plus root-compatible fallbacks for
    // the network-off and network-on paths when host identity is unavailable.
    expect(calls?.length).toBe(3)
  })

  test('sets GWS_CONFIG_HOME without changing global XDG_CONFIG_HOME so git config lookup is untouched', () => {
    const dockerfile = buildDockerfile(dockerfileSchema.parse({}))
    expect(dockerfile).not.toContain('ENV XDG_CONFIG_HOME=')
    expect(dockerfile).toContain('ENV GWS_CONFIG_HOME=/agent/workspace/.config/gws')
  })

  test('also symlinks Claude Code .credentials.json into /agent/.typeclaw/home/ so OAuth credentials survive container restarts', () => {
    const shim = buildEntrypointShim()
    // Claude Code rotates tokens in-place by rewriting .credentials.json on
    // every successful refresh (anthropics/claude-code#53063). Without the
    // symlink, the refreshed credential lands on the container's overlay
    // and is wiped on the next `stop`+`start`. Same persist-root contract
    // as the codex line above.
    expect(shim).toContain('claude_config_dir="${CLAUDE_CONFIG_DIR:-}"')
    expect(shim).toContain('claude_config_dir="$HOME/.claude"')
    expect(shim).toContain('mkdir -p "$persist_root/.claude" "$claude_config_dir"')
    expect(shim).toContain('ln -sfn "$persist_root/.claude/.credentials.json" "$claude_config_dir/.credentials.json"')
  })

  test('uses ln -sfn (idempotent + non-dereferencing) so re-runs across container lives never fail and never recurse into a pre-existing ~/.codex directory', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/ln -sfn "\$persist_root\/\.codex\/auth\.json" "\$HOME\/\.codex\/auth\.json"/)
    expect(shim).not.toMatch(/ln -s "\$persist_root\/\.codex\/auth\.json"/)
    expect(shim).not.toMatch(/ln -sf "\$persist_root\/\.codex\/auth\.json"/)
  })

  test('claude symlink also uses ln -sfn (same idempotency contract as codex)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(
      /ln -sfn "\$persist_root\/\.claude\/\.credentials\.json" "\$claude_config_dir\/\.credentials\.json"/,
    )
    expect(shim).not.toMatch(/ln -s "\$persist_root\/\.claude\/\.credentials\.json"/)
    expect(shim).not.toMatch(/ln -sf "\$persist_root\/\.claude\/\.credentials\.json"/)
  })

  test('claude symlink honors CLAUDE_CONFIG_DIR when set', () => {
    const shim = buildEntrypointShim()
    const claudeConfigCheckIdx = shim.indexOf('if [ -z "$claude_config_dir" ]; then')
    const claudeSymlinkIdx = shim.indexOf('"$claude_config_dir/.credentials.json"')
    expect(claudeConfigCheckIdx).toBeGreaterThan(-1)
    expect(claudeSymlinkIdx).toBeGreaterThan(claudeConfigCheckIdx)
  })

  test('link_persistent_home_files runs after firewall setup and before bun on the runtime paths', () => {
    // given
    const shim = buildEntrypointShim()

    // when
    const runtimeBranchStart = shim.indexOf('if [ "${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then')
    const runtimeBranchEnd = shim.indexOf('\nfi\n', runtimeBranchStart)
    const runtimeBranch = shim.slice(runtimeBranchStart, runtimeBranchEnd)
    const networkOnTail = shim.slice(shim.lastIndexOf('if [ -n "${TYPECLAW_HOST_UID:-}" ]'))

    // then
    expect(runtimeBranch.indexOf('link_persistent_home_files\n')).toBeLessThan(
      runtimeBranch.indexOf(`exec bun run ${TYPECLAW_CLI_ENTRY}`),
    )
    expect(networkOnTail.indexOf('link_persistent_home_files\n')).toBeLessThan(
      networkOnTail.indexOf(`exec setpriv --bounding-set`),
    )
  })

  test('on-path: link_persistent_home_files runs AFTER iptables OUTPUT rules so a failure in the helper cannot prevent the egress lockdown from taking effect (security invariant pinned by AGENTS.md)', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    const onBranch = shim.slice(offBranchEnd)
    const lastIptablesIdx = onBranch.lastIndexOf('iptables -A OUTPUT')
    const lastIp6tablesIdx = onBranch.lastIndexOf('ip6tables -A OUTPUT')
    const linkIdx = onBranch.lastIndexOf('link_persistent_home_files\n')
    expect(lastIptablesIdx).toBeGreaterThan(-1)
    expect(lastIp6tablesIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeGreaterThan(lastIptablesIdx)
    expect(linkIdx).toBeGreaterThan(lastIp6tablesIdx)
  })

  test('symlink target is unconditional — never gated on auth.json existing — so first-time codex login writes through the link to the persistent location', () => {
    const shim = buildEntrypointShim()
    const fnStart = shim.indexOf('link_persistent_home_files() {')
    const fnEnd = shim.indexOf('\n}\n', fnStart)
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const fnBody = shim.slice(fnStart, fnEnd)
    expect(fnBody).not.toMatch(/if .* -f .*auth\.json/)
    expect(fnBody).not.toMatch(/test -e .*auth\.json/)
    expect(fnBody).not.toMatch(/\[ -e .*auth\.json \]/)
  })
})

// POSIX shell execution, #899.
describe.skipIf(onWindows)('entrypoint shim — executable behavior (Xvfb startup, fail-fast)', () => {
  let workdir: string
  let bindir: string
  let logfile: string

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'typeclaw-shim-test-'))
    bindir = join(workdir, 'bin')
    await mkdir(bindir, { recursive: true })

    logfile = join(workdir, 'agent-args.log')

    // Fake `setpriv` that ignores all flags up to `--` and then execs the
    // rest. Real setpriv drops capabilities; the test doesn't care about
    // capabilities, only that the wrapped command runs.
    await writeShellScript(
      join(bindir, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break;;
    --*) shift;;
    *) shift;;
  esac
done
exec "$@"
`,
    )

    // Fake `bun` that records its argv and the value of $DISPLAY, then
    // exits 0. Stands in for the real \`bun run <cli-entry> "$@"\` exec at
    // the end of the shim.
    await writeShellScript(
      join(bindir, 'bun'),
      `#!/bin/sh
{
  echo "argv: $*"
  echo "DISPLAY: \${DISPLAY:-<unset>}"
} > "${logfile}"
exit 0
`,
    )
  })

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('off-path: when Xvfb exits immediately, the shim writes a diagnostic to stderr and exits non-zero (no silent failure)', async () => {
    // Fake Xvfb that exits 1 the instant it starts. The shim's
    // `kill -0 $xvfb_pid` check should detect this on the next poll
    // iteration and `exit 1` with a clear stderr line.
    await symlinkHostBinaries(bindir, ['mkdir', 'ln', 'readlink'])
    await writeShellScript(
      join(bindir, 'Xvfb'),
      `#!/bin/sh
exit 1
`,
    )

    const testSocketPath = join(workdir, 'x11-socket-X99')
    const shim = buildEntrypointShim().replaceAll('/tmp/.X11-unix/X99', testSocketPath)
    const failShimPath = join(workdir, 'shim-fail.sh')
    await writeShellScript(failShimPath, shim)

    const fakeHome = join(workdir, 'home-xvfb-fail')
    await mkdir(fakeHome, { recursive: true })
    const proc = Bun.spawn(['/bin/sh', failShimPath, 'run'], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: join(workdir, 'persist-xvfb-fail'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('typeclaw-entrypoint: Xvfb exited immediately')
  })

  test('host UID/GID + Xvfb: after the non-root re-exec, Xvfb starts DIRECTLY — a nested bounding-set setpriv would fail (CAP_SETPCAP gone) so it must not be attempted in the runtime phase', async () => {
    const runWorkdir = mkdtempSync(join(tmpdir(), 'typeclaw-shim-runtime-xvfb-'))
    const runBin = join(runWorkdir, 'bin')
    await mkdir(runBin, { recursive: true })
    await symlinkHostBinaries(runBin, ['mkdir', 'ln', 'readlink', 'env', 'sh', 'chown', 'rm', 'sleep'])

    // Fake setpriv: exec the outer --reuid handoff normally, but REFUSE any
    // bounding-set drop once we're in the runtime phase — that is exactly the
    // CAP_SETPCAP-gone 127 the real setpriv returns. If start_xvfb still tried
    // the nested drop here, Xvfb would never launch and the shim would fail.
    await writeShellScript(
      join(runBin, 'setpriv'),
      `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--bounding-set" ] && [ "\${TYPECLAW_ENTRYPOINT_RUNTIME:-0}" = "1" ]; then
    echo "setpriv: cannot modify bounding set: Operation not permitted" >&2
    exit 127
  fi
done
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )

    const socketPath = join(runWorkdir, 'x11-X99')
    // Fake Xvfb: create the socket the poll loop waits on, then idle briefly
    // (long enough for the poll loop to observe the socket, short enough not to
    // hang the test if left orphaned after the shim exec's bun).
    await writeShellScript(
      join(runBin, 'Xvfb'),
      `#!/bin/sh
: > "${socketPath}"
sleep 2
`,
    )
    const logfileRuntime = join(runWorkdir, 'agent-args.log')
    await writeShellScript(
      join(runBin, 'bun'),
      `#!/bin/sh
{
  echo "argv: $*"
  echo "DISPLAY: \${DISPLAY:-<unset>}"
} > "${logfileRuntime}"
exit 0
`,
    )

    const shim = buildEntrypointShim()
      .replaceAll('/tmp/.X11-unix/X99', socketPath)
      .replace('[ -S ' + socketPath + ' ]', '[ -e ' + socketPath + ' ]')
    const shimPath = join(runWorkdir, 'shim-runtime-xvfb.sh')
    await writeShellScript(shimPath, shim)

    const fakeHome = join(runWorkdir, 'home')
    await mkdir(fakeHome, { recursive: true })
    const proc = Bun.spawn(['/bin/sh', shimPath, 'run'], {
      env: {
        PATH: runBin,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: join(runWorkdir, 'persist'),
        TYPECLAW_HOST_UID: String(process.getuid?.() ?? 1000),
        TYPECLAW_HOST_GID: String(process.getgid?.() ?? 1000),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(stderr).not.toContain('Xvfb exited immediately')
    expect(exitCode).toBe(0)
    const log = readFileSync(logfileRuntime, 'utf8')
    expect(log).toContain('DISPLAY: :99')
    rmSync(runWorkdir, { recursive: true, force: true })
  })

  test('host UID/GID re-exec forwards env-file values and TypeClaw-injected vars (no --reset-env), overriding only HOME + RUNTIME', async () => {
    const envWorkdir = mkdtempSync(join(tmpdir(), 'typeclaw-shim-env-'))
    const envBin = join(envWorkdir, 'bin')
    await mkdir(envBin, { recursive: true })
    await symlinkHostBinaries(envBin, ['mkdir', 'ln', 'readlink', 'env', 'sh', 'chown', 'rm', 'sleep'])
    await writeShellScript(
      join(envBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )
    // No Xvfb on PATH → start_xvfb is a no-op, keeping this test focused on env.
    // Fake bun dumps the runtime env so we can assert what survived the re-exec.
    const envDump = join(envWorkdir, 'env.log')
    await writeShellScript(join(envBin, 'bun'), `#!/bin/sh\nenv > "${envDump}"\nexit 0\n`)

    const envShimPath = join(envWorkdir, 'shim-env.sh')
    await writeShellScript(envShimPath, buildEntrypointShim())

    const envFakeHome = join(envWorkdir, 'host-home')
    await mkdir(envFakeHome, { recursive: true })
    const expectedRuntimeHome = join(envWorkdir, 'persist', 'runtime')
    const proc = Bun.spawn(['/bin/sh', envShimPath, 'run'], {
      env: {
        PATH: envBin,
        HOME: envFakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: join(envWorkdir, 'persist'),
        TYPECLAW_HOST_UID: String(process.getuid?.() ?? 1000),
        TYPECLAW_HOST_GID: String(process.getgid?.() ?? 1000),
        // Stand-ins for an --env-file credential and TypeClaw-injected vars.
        OPENAI_API_KEY: 'sk-env-file-value',
        TYPECLAW_TUI_TOKEN: 'tui-tok-123',
        TZ: 'Europe/Berlin',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    const dumped = readFileSync(envDump, 'utf8')
    // Forwarded, not wiped:
    expect(dumped).toContain('OPENAI_API_KEY=sk-env-file-value')
    expect(dumped).toContain('TYPECLAW_TUI_TOKEN=tui-tok-123')
    expect(dumped).toContain('TZ=Europe/Berlin')
    // Overridden for the runtime phase:
    expect(dumped).toContain('TYPECLAW_ENTRYPOINT_RUNTIME=1')
    expect(dumped.split('\n')).toContain(`HOME=${expectedRuntimeHome}`)
    rmSync(envWorkdir, { recursive: true, force: true })
  })

  test('host UID/GID re-exec: image-baked Claude/Codex settings are seeded into the effective non-root runtime HOME', async () => {
    const seedWorkdir = mkdtempSync(join(tmpdir(), 'typeclaw-shim-seed-'))
    const seedBin = join(seedWorkdir, 'bin')
    await mkdir(seedBin, { recursive: true })
    await symlinkHostBinaries(seedBin, ['mkdir', 'ln', 'readlink', 'env', 'sh', 'chown', 'rm', 'sleep', 'cp', 'cat'])
    await writeShellScript(
      join(seedBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )
    // Fake bun records the effective runtime HOME and the settings visible under
    // it — this is the "inspect the effective non-root HOME" the review asks for.
    const seedDump = join(seedWorkdir, 'seed.log')
    await writeShellScript(
      join(seedBin, 'bun'),
      `#!/bin/sh
{
  echo "HOME=$HOME"
  echo "claude_json=$(cat "$HOME/.claude.json" 2>/dev/null)"
  echo "claude_settings=$(cat "$HOME/.claude/settings.json" 2>/dev/null)"
  echo "codex_hooks=$(cat "$HOME/.codex/hooks.json" 2>/dev/null)"
} > "${seedDump}"
exit 0
`,
    )

    // The build-time HOME (/root) where the Dockerfile writes the baked settings.
    const bakedHome = join(seedWorkdir, 'root')
    await mkdir(join(bakedHome, '.claude'), { recursive: true })
    await mkdir(join(bakedHome, '.codex'), { recursive: true })
    await writeFile(join(bakedHome, '.claude.json'), '{"onboarded":true}')
    await writeFile(join(bakedHome, '.claude', 'settings.json'), '{"hooks":"cc"}')
    await writeFile(join(bakedHome, '.codex', 'hooks.json'), '{"hooks":"cx"}')

    const seedShimPath = join(seedWorkdir, 'shim-seed.sh')
    await writeShellScript(seedShimPath, buildEntrypointShim())

    const proc = Bun.spawn(['/bin/sh', seedShimPath, 'run'], {
      env: {
        PATH: seedBin,
        HOME: bakedHome,
        TYPECLAW_PERSIST_HOME_ROOT: join(seedWorkdir, 'persist'),
        TYPECLAW_HOST_UID: String(process.getuid?.() ?? 1000),
        TYPECLAW_HOST_GID: String(process.getgid?.() ?? 1000),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    const dumped = readFileSync(seedDump, 'utf8')
    const expectedRuntimeHome = join(seedWorkdir, 'persist', 'runtime')
    expect(dumped).toContain(`HOME=${expectedRuntimeHome}`)
    expect(dumped).toContain('claude_json={"onboarded":true}')
    expect(dumped).toContain('claude_settings={"hooks":"cc"}')
    expect(dumped).toContain('codex_hooks={"hooks":"cx"}')
    rmSync(seedWorkdir, { recursive: true, force: true })
  })

  test('off-path: link_persistent_home_files creates a dangling symlink (~/.codex/auth.json → persist root) even when no credential exists yet, so the first codex login write lands at the persistent location', async () => {
    const persistRoot = join(workdir, 'persist')
    const fakeHome = join(workdir, 'home')
    await mkdir(fakeHome, { recursive: true })

    const noXvfbBin = join(workdir, 'bin-link-test')
    await mkdir(noXvfbBin, { recursive: true })
    await symlinkHostBinaries(noXvfbBin, ['mkdir', 'ln', 'readlink'])
    await writeShellScript(join(noXvfbBin, 'bun'), `#!/bin/sh\nexit 0\n`)
    await writeShellScript(
      join(noXvfbBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )

    const shim = buildEntrypointShim()
    const shimPath = join(workdir, 'shim-link.sh')
    await writeShellScript(shimPath, shim)

    const proc = Bun.spawn(['/bin/sh', shimPath, 'run'], {
      env: {
        PATH: noXvfbBin,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: persistRoot,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    const linkPath = join(fakeHome, '.codex', 'auth.json')
    const linkStat = lstatSync(linkPath)
    expect(linkStat.isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath)).toBe(join(persistRoot, '.codex', 'auth.json'))
    expect(statSync(join(persistRoot, '.codex')).isDirectory()).toBe(true)

    const claudeLinkPath = join(fakeHome, '.claude', '.credentials.json')
    const claudeLinkStat = lstatSync(claudeLinkPath)
    expect(claudeLinkStat.isSymbolicLink()).toBe(true)
    expect(readlinkSync(claudeLinkPath)).toBe(join(persistRoot, '.claude', '.credentials.json'))
    expect(statSync(join(persistRoot, '.claude')).isDirectory()).toBe(true)
  })

  test('off-path: link_persistent_home_files is idempotent — running the shim twice does not error and leaves the same symlink in place (ln -sfn replaces atomically)', async () => {
    const persistRoot = join(workdir, 'persist-idem')
    const fakeHome = join(workdir, 'home-idem')
    await mkdir(fakeHome, { recursive: true })

    const noXvfbBin = join(workdir, 'bin-idem-test')
    await mkdir(noXvfbBin, { recursive: true })
    await symlinkHostBinaries(noXvfbBin, ['mkdir', 'ln', 'readlink'])
    await writeShellScript(join(noXvfbBin, 'bun'), `#!/bin/sh\nexit 0\n`)
    await writeShellScript(
      join(noXvfbBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )

    const shim = buildEntrypointShim()
    const shimPath = join(workdir, 'shim-idem.sh')
    await writeShellScript(shimPath, shim)

    const env = {
      PATH: noXvfbBin,
      HOME: fakeHome,
      TYPECLAW_PERSIST_HOME_ROOT: persistRoot,
    }
    const first = Bun.spawn(['/bin/sh', shimPath, 'run'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(await first.exited).toBe(0)
    const second = Bun.spawn(['/bin/sh', shimPath, 'run'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(await second.exited).toBe(0)

    const linkPath = join(fakeHome, '.codex', 'auth.json')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath)).toBe(join(persistRoot, '.codex', 'auth.json'))

    const claudeLinkPath = join(fakeHome, '.claude', '.credentials.json')
    expect(lstatSync(claudeLinkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(claudeLinkPath)).toBe(join(persistRoot, '.claude', '.credentials.json'))
  })

  test('off-path: link_configured_symlinks creates from -> /agent/<to> with a ~/ from expanded against $HOME, and makes the target dir', async () => {
    const realBun = Bun.which('bun')
    if (!realBun) throw new Error('bun not on host PATH')

    const persistRoot = join(workdir, 'persist-sym')
    const fakeHome = join(workdir, 'home-sym')
    const fakeAgent = join(workdir, 'agent-sym')
    await mkdir(fakeHome, { recursive: true })
    await mkdir(fakeAgent, { recursive: true })

    const bin = join(workdir, 'bin-sym')
    await mkdir(bin, { recursive: true })
    await symlinkHostBinaries(bin, ['mkdir', 'ln', 'readlink'])
    // Fake `bun`: pass `-e <script>` through to the real bun (link_configured_symlinks
    // needs a real JSON parser + fs), but turn the final `bun run <cli-entry>` exec
    // into a no-op so the shim ends cleanly without launching the agent.
    await writeShellScript(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec ${realBun} "$@"; fi\nexit 0\n`)
    await writeShellScript(
      join(bin, 'setpriv'),
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done\nexec "$@"\n`,
    )

    const shimPath = join(workdir, 'shim-sym.sh')
    await writeShellScript(shimPath, buildEntrypointShim())

    const symlinks = [{ from: '~/.metabase-cli', to: 'workspace/.metabase-cli' }]
    const proc = Bun.spawn(['/bin/sh', shimPath, 'run'], {
      env: {
        PATH: bin,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: persistRoot,
        TYPECLAW_AGENT_DIR: fakeAgent,
        TYPECLAW_SANDBOX_SYMLINKS: Buffer.from(JSON.stringify(symlinks), 'utf8').toString('base64'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)

    const linkPath = join(fakeHome, '.metabase-cli')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath)).toBe(join(fakeAgent, 'workspace', '.metabase-cli'))
    expect(statSync(join(fakeAgent, 'workspace', '.metabase-cli')).isDirectory()).toBe(true)
  })

  test('off-path: link_configured_symlinks refuses to clobber an existing non-symlink at from', async () => {
    const realBun = Bun.which('bun')
    if (!realBun) throw new Error('bun not on host PATH')

    const persistRoot = join(workdir, 'persist-noclobber')
    const fakeHome = join(workdir, 'home-noclobber')
    const fakeAgent = join(workdir, 'agent-noclobber')
    await mkdir(fakeHome, { recursive: true })
    await mkdir(fakeAgent, { recursive: true })
    // a real file already sits at the symlink location
    const existing = join(fakeHome, '.metabase-cli')
    await writeFile(existing, 'real config, do not clobber')

    const bin = join(workdir, 'bin-noclobber')
    await mkdir(bin, { recursive: true })
    await symlinkHostBinaries(bin, ['mkdir', 'ln', 'readlink'])
    await writeShellScript(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec ${realBun} "$@"; fi\nexit 0\n`)
    await writeShellScript(
      join(bin, 'setpriv'),
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done\nexec "$@"\n`,
    )

    const shimPath = join(workdir, 'shim-noclobber.sh')
    await writeShellScript(shimPath, buildEntrypointShim())

    const symlinks = [{ from: '~/.metabase-cli', to: 'workspace/.metabase-cli' }]
    const proc = Bun.spawn(['/bin/sh', shimPath, 'run'], {
      env: {
        PATH: bin,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: persistRoot,
        TYPECLAW_AGENT_DIR: fakeAgent,
        TYPECLAW_SANDBOX_SYMLINKS: Buffer.from(JSON.stringify(symlinks), 'utf8').toString('base64'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)

    // the real file is untouched (still a regular file with its content)
    expect(lstatSync(existing).isSymbolicLink()).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('real config, do not clobber')
  })

  test('off-path: when Xvfb is not on PATH (docker.file.xvfb=false equivalent), the shim execs the agent directly without spawning anything or exporting DISPLAY', async () => {
    // Make Xvfb unfindable by pointing PATH at a directory that contains
    // the bun + setpriv fakes plus the specific coreutils the shim's
    // link_persistent_home_files helper needs (mkdir, ln) — symlinked
    // from the host so they work on Linux CI and macOS dev boxes alike.
    // Crucially we do NOT add /usr/bin or /bin to PATH, because Linux
    // CI runners (GitHub Actions ubuntu-latest in particular) ship a
    // real Xvfb in /usr/bin, which would let `command -v Xvfb` succeed
    // and break the off-switch test premise. Symlinking only the
    // utilities we actually need keeps Xvfb unreachable on every
    // platform. Production containers ship coreutils in the baseline
    // image so the helper's mkdir+ln calls work for the same reason.
    const isolatedBin = join(workdir, 'bin-no-xvfb')
    await mkdir(isolatedBin, { recursive: true })
    await symlinkHostBinaries(isolatedBin, ['mkdir', 'ln', 'readlink'])
    await writeShellScript(
      join(isolatedBin, 'bun'),
      `#!/bin/sh\necho "DISPLAY: \${DISPLAY:-<unset>}" > "${logfile}"\nexit 0\n`,
    )
    await writeShellScript(
      join(isolatedBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )

    const shim = buildEntrypointShim()
    const noXvfbShimPath = join(workdir, 'shim-no-xvfb.sh')
    await writeShellScript(noXvfbShimPath, shim)

    const fakeHome = join(workdir, 'home-no-xvfb')
    await mkdir(fakeHome, { recursive: true })
    const proc = Bun.spawn(['/bin/sh', noXvfbShimPath, 'run'], {
      env: {
        PATH: isolatedBin,
        HOME: fakeHome,
        TYPECLAW_PERSIST_HOME_ROOT: join(workdir, 'persist-no-xvfb'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    const log = await Bun.file(logfile).text()
    expect(log).toContain('DISPLAY: <unset>')
  })
})

async function writeShellScript(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 })
}

// Symlinks specific host binaries into a test's isolated bin directory so
// the shim's helpers (link_persistent_home_files calls mkdir + ln) can
// run without widening PATH to /usr/bin or /bin. Widening PATH would
// drag in real Xvfb on Linux CI (it's preinstalled at /usr/bin/Xvfb on
// GitHub Actions ubuntu-latest), which breaks any test whose premise is
// "Xvfb is unreachable". Resolves each name via Bun.which against the
// host PATH so the test works whether ln is at /bin/ln (Linux) or
// /usr/bin/ln (some BSD/macOS layouts).
async function symlinkHostBinaries(targetDir: string, names: string[]): Promise<void> {
  for (const name of names) {
    const hostPath = Bun.which(name)
    if (!hostPath) throw new Error(`symlinkHostBinaries: ${name} not found on host PATH`)
    await symlink(hostPath, join(targetDir, name))
  }
}

// vercel-labs/agent-browser issue #1083 ("headed silently ignored on
// existing session") leaves --headed / AGENT_BROWSER_HEADED a no-op
// once a daemon has launched a browser headless. Three upstream fix PRs
// (#660, #370, #387) are open and unmerged. Layer 4.5 shims the
// agent-browser binary so a best-effort `agent-browser close` runs
// before `open`/`goto`/`navigate` when headed mode is requested. These
// tests pin the structural invariants (wrapper present in every
// Dockerfile that ships agent-browser, ordering after install, omitted
// when the base image already carries it) and the behavioral matrix
// (allowlist scope, upstream-matching truthy contract, re-entrancy
// defense, exit-code passthrough). Allowlist over denylist is
// deliberate per oracle self-review: pre-closing stateful commands
// (chat, connect, record, trace, tab, batch, stream, ...) would destroy
// live browser/page state the user expects to keep.
describe('agent-browser headed-mode wrapper (Layer 4.5)', () => {
  test('per-agent inline Dockerfile installs the wrapper after the agent-browser bun install — pre-close depends on the real binary existing at the path the wrapper mv-aliases', () => {
    const out = buildDockerfile()
    const installIdx = out.indexOf('bun install -g agent-browser@^0.27.0')
    const wrapperIdx = out.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(installIdx).toBeGreaterThan(-1)
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(installIdx).toBeLessThan(wrapperIdx)
  })

  test('base Dockerfile carries the wrapper too — without it the prebuilt GHCR base ships an unpatched agent-browser, and the per-agent versioned Dockerfile (which omits the install layer) has no way to add the wrapper itself', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(base).toContain('TYPECLAW_AGENT_BROWSER_WRAPPER_EOF')
    const installIdx = base.indexOf('bun install -g agent-browser@^0.27.0')
    const wrapperIdx = base.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(installIdx).toBeLessThan(wrapperIdx)
  })

  test('versioned per-agent Dockerfile omits the wrapper RUN block — the base image already carries it (paired with the install layer) so re-applying would mv a non-existent .real file and break the build', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    expect(out).not.toContain('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(out).not.toContain('TYPECLAW_AGENT_BROWSER_WRAPPER_EOF')
  })

  test('wrapper appears before the Chrome-for-Testing download — pre-close behavior cannot depend on whether the browser binary is present, and the layer ordering is the only thing that guarantees a clean mv+rewrite without racing the install step', () => {
    const out = buildDockerfile()
    const wrapperIdx = out.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    const chromeIdx = out.indexOf('agent-browser install --with-deps')
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(chromeIdx).toBeGreaterThan(-1)
    expect(wrapperIdx).toBeLessThan(chromeIdx)
  })

  test('Chrome-for-Testing download in Layer 5 invokes the shimmed agent-browser binary — `agent-browser install` is not on the allowlist so the wrapper passes through unchanged at build time', () => {
    const out = buildDockerfile()
    expect(out).toContain('agent-browser install --with-deps')
    const wrapperBody = extractWrapperBody(out)
    expect(wrapperBody).toContain('open|goto|navigate')
  })
})

// POSIX shell execution, #899.
describe.skipIf(onWindows)('agent-browser headed-mode wrapper — executable behavior', () => {
  let workdir: string
  let bindir: string
  let logfile: string
  let wrapperPath: string

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'typeclaw-ab-wrap-'))
    bindir = join(workdir, 'bin')
    await mkdir(bindir, { recursive: true })
    logfile = join(workdir, 'real-calls.log')

    const realPath = join(bindir, 'agent-browser.real')
    await writeShellScript(
      realPath,
      `#!/bin/sh
{
  echo "args=[$*]"
  echo "HEADED=\${AGENT_BROWSER_HEADED-unset}"
  echo "handled=\${_TYPECLAW_AGENT_BROWSER_HEADED_HANDLED-unset}"
  echo "---"
} >> "${logfile}"
exit 0
`,
    )

    wrapperPath = join(bindir, 'agent-browser')
    await writeFile(wrapperPath, extractWrapperBody(buildDockerfile()), { mode: 0o755 })
  })

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  async function runWrapper(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ exitCode: number; calls: string[] }> {
    await writeFile(logfile, '')
    const proc = Bun.spawn([wrapperPath, ...args], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: join(bindir, 'agent-browser.real'),
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const log = await Bun.file(logfile).text()
    const calls = log
      .split('---\n')
      .map((s) => s.trim())
      .filter(Boolean)
    return { exitCode, calls }
  }

  test('no headed signal: skips pre-close and calls the real binary once with the original args', async () => {
    const { exitCode, calls } = await runWrapper(['snapshot'])
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[snapshot]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('AGENT_BROWSER_HEADED=1 + open: allowlist hit, pre-closes first then exec-passes through', async () => {
    const { exitCode, calls } = await runWrapper(['open', 'https://example.com'], { AGENT_BROWSER_HEADED: '1' })
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('args=[close]')
    expect(calls[1]).toContain('args=[open https://example.com]')
  })

  test('AGENT_BROWSER_HEADED=1 + goto / navigate aliases: also on the allowlist (upstream maps both to the same action as open)', async () => {
    for (const sub of ['goto', 'navigate']) {
      const { calls } = await runWrapper([sub, 'https://example.com'], { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
      expect(calls[1]).toContain(`args=[${sub} https://example.com]`)
    }
  })

  test('allowlist matches subcommand semantics, not flag soup — headed env without an allowed subcommand never pre-closes', async () => {
    const nonAllowlisted = [
      ['click', '#btn'],
      ['snapshot'],
      ['screenshot'],
      ['eval', '1+1'],
      ['chat', 'hi'],
      ['connect', '9222'],
      ['batch'],
      ['tab', 'list'],
      ['record', 'start', '/tmp/r.webm'],
      ['trace', 'start'],
      ['stream', 'enable'],
      ['cookies', 'get'],
      ['network', 'route', 'https://x'],
      ['react', 'tree'],
      ['vitals'],
    ]
    for (const args of nonAllowlisted) {
      const { calls } = await runWrapper(args, { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(`args=[${args.join(' ')}]`)
      expect(calls[0]).toContain('handled=unset')
    }
  })

  test('--headed argv on a non-allowlisted subcommand: still no pre-close — the wrapper trusts the allowlist over the headed signal so stateful commands stay untouched', async () => {
    const { calls } = await runWrapper(['click', '#btn', '--headed'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[click #btn --headed]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('--headed argv forms on open: bare --headed, --headed=true, --headed=1 all trigger pre-close', async () => {
    for (const flag of ['--headed', '--headed=true', '--headed=1']) {
      const { calls } = await runWrapper([flag, 'open', 'https://x'])
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
      expect(calls[1]).toContain(`args=[${flag} open https://x]`)
    }
  })

  test('AGENT_BROWSER_HEADED broad truthy contract matches upstream env_var_is_truthy: any non-empty value except case-insensitive 0/false/no is truthy', async () => {
    const truthy = ['1', 'true', 'TRUE', 'True', 'yes', 'y', 'on', 'enable', 'random', '2']
    for (const value of truthy) {
      const { calls } = await runWrapper(['open', 'https://x'], { AGENT_BROWSER_HEADED: value })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
    }
  })

  test('AGENT_BROWSER_HEADED falsy values bypass pre-close: 0, false, FALSE, False, no, NO, No, empty', async () => {
    const falsy = ['0', 'false', 'FALSE', 'False', 'no', 'NO', 'No', '']
    for (const value of falsy) {
      const { calls } = await runWrapper(['open', 'https://x'], { AGENT_BROWSER_HEADED: value })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('args=[open https://x]')
    }
  })

  test('close subcommand under headed env: NOT on the allowlist, passes through directly so the user-issued close runs once instead of cascading into a wrapper-injected pre-close', async () => {
    const { exitCode, calls } = await runWrapper(['close'], { AGENT_BROWSER_HEADED: '1' })
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[close]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('--help and --version under headed env: no subcommand match, no pre-close — printing help must never kill an active browser', async () => {
    for (const flag of ['--help', '-h', '--version', '-V']) {
      const { calls } = await runWrapper([flag], { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(`args=[${flag}]`)
      expect(calls[0]).toContain('handled=unset')
    }
  })

  test('no-args invocation under headed env: empty argv, no allowlist match, no pre-close', async () => {
    const { calls } = await runWrapper([], { AGENT_BROWSER_HEADED: '1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('re-entrancy guard: _TYPECLAW_AGENT_BROWSER_HEADED_HANDLED=1 at entry triggers the top-of-script bypass — defends against future subcommands that shell out to agent-browser as a subprocess while headed env is still set', async () => {
    const { calls } = await runWrapper(['open', 'https://x'], {
      AGENT_BROWSER_HEADED: '1',
      _TYPECLAW_AGENT_BROWSER_HEADED_HANDLED: '1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[open https://x]')
    expect(calls[0]).toContain('handled=1')
  })

  test("exit code passes through from the real binary even when pre-close was attempted — the wrapper must never mask the real command's exit status", async () => {
    const failingReal = join(bindir, 'agent-browser-fail.real')
    await writeShellScript(failingReal, `#!/bin/sh\nexit 42\n`)
    const proc = Bun.spawn([wrapperPath, 'open', 'https://x'], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: failingReal,
        AGENT_BROWSER_HEADED: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(42)
  })

  test("pre-close failure is tolerated: when the real binary returns non-zero on close (e.g. stale socket, network blip), the wrapper still execs the user's actual command — false negatives on pre-close must never block legitimate calls", async () => {
    const flakyReal = join(bindir, 'agent-browser-flaky.real')
    await writeShellScript(
      flakyReal,
      `#!/bin/sh
case "$1" in
  close) exit 7 ;;
  *) echo "open_ran" > "${join(workdir, 'flaky-open.flag')}"; exit 0 ;;
esac
`,
    )
    const proc = Bun.spawn([wrapperPath, 'open', 'https://x'], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: flakyReal,
        AGENT_BROWSER_HEADED: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    const flagPath = join(workdir, 'flaky-open.flag')
    expect(await Bun.file(flagPath).text()).toContain('open_ran')
  })
})

describe('buildKit: false (legacy-builder Dockerfile for hosts without buildx)', () => {
  const allTogglesOn = {
    gh: true,
    tmux: true,
    python: true,
    ffmpeg: true,
    cjkFonts: true,
    xvfb: true,
    cloudflared: true,
    claudeCode: true,
    codexCli: true,
    append: [],
  } as Parameters<typeof buildDockerfile>[0]

  test('buildKit defaults to ON — keeps the # syntax pragma and cache mounts', () => {
    for (const baseImageVersion of ['0.36.8', null]) {
      const df = buildDockerfile(allTogglesOn, { baseImageVersion })
      expect(df).toContain('# syntax=docker/dockerfile:1.7')
      expect(df).toContain('--mount=type=cache,target=/var/cache/apt')
      expect(df).toContain('--mount=type=cache,target=/root/.bun/install/cache')
    }
  })

  test('buildKit:false omits the pragma and every cache mount, with no malformed RUN', () => {
    for (const baseImageVersion of ['0.36.8', null]) {
      const df = buildDockerfile(allTogglesOn, { baseImageVersion, buildKit: false })
      expect(df).not.toContain('# syntax=')
      expect(df).not.toContain('--mount')
      // The commands the mounts used to wrap are intact and well-formed.
      expect(df).toContain('RUN apt-get update')
      expect(df).toContain('RUN bun install -g @openai/codex')
      // No artifacts from mechanical rewriting: no double RUN, no dangling `\`,
      // no `RUN ` with a stray gap where a mount used to be.
      expect(df).not.toContain('RUN RUN')
      expect(df).not.toContain('RUN  ')
      expect(df.split('\n').filter((l) => l.trim() === '\\')).toHaveLength(0)
    }
  })

  test('the agent-browser install RUN is well-formed in both modes', () => {
    const bk = buildDockerfile(allTogglesOn, { baseImageVersion: null })
    const lg = buildDockerfile(allTogglesOn, { baseImageVersion: null, buildKit: false })
    expect(bk).toContain('RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \\')
    expect(lg).toContain('RUN bun install -g agent-browser')
  })

  test('legacy mode strips structurally-unsafe append lines (heredoc `<<`) but still emits ENTRYPOINT/CMD', () => {
    const df = buildDockerfile(
      { append: ['RUN echo "usage: cat <<EOF"', 'LABEL note="x << y"'] } as Parameters<typeof buildDockerfile>[0],
      { baseImageVersion: '0.36.8', buildKit: false },
    )
    expect(df).not.toContain('RUN echo "usage: cat <<EOF"')
    expect(df).not.toContain('LABEL note="x << y"')
    expect(df).toContain('typeclaw stripped 2 unsafe docker.file.append line(s)')
    expect(df).toContain('ENTRYPOINT [')
    expect(df).toContain('CMD ["run"]')
  })

  test('the two modes produce the same image recipe — identical once the pragma and cache mounts are normalized away', () => {
    const bk = buildDockerfile(allTogglesOn, { baseImageVersion: null })
    const lg = buildDockerfile(allTogglesOn, { baseImageVersion: null, buildKit: false })
    // Collapse each Dockerfile to its logical instructions (join `\`
    // continuations, drop the pragma + every `--mount=type=cache` token). If the
    // two modes describe the same build, the normalized forms are identical —
    // proving legacy isn't a different image, just one without cross-build cache.
    const normalize = (s: string) =>
      s
        .replace(/\\\n\s*/g, ' ') // join line-continuations into one logical line
        .split('\n')
        .map((l) =>
          l
            .replace(/--mount=type=cache,\S+\s*/g, '')
            .replace(/\s+/g, ' ')
            .trimEnd(),
        )
        .filter((l) => l !== '# syntax=docker/dockerfile:1.7')
        .join('\n')
    expect(normalize(bk)).toBe(normalize(lg))
  })
})

function extractWrapperBody(dockerfile: string): string {
  const shebangIdx = dockerfile.indexOf('#!/bin/sh')
  const endIdx = dockerfile.indexOf('\nTYPECLAW_AGENT_BROWSER_WRAPPER_EOF', shebangIdx)
  if (shebangIdx < 0 || endIdx < 0) throw new Error('wrapper heredoc not found in Dockerfile')
  return dockerfile.slice(shebangIdx, endIdx)
}
