import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// A GIT_ASKPASS helper git invokes for username/password prompts. The token
// rides in TYPECLAW_GIT_TOKEN (env, via the bash env overlay), NEVER in argv or
// git config — so it cannot leak through process listings, logs, or .git/config.
// The script contents are constant and secret-free; only the env value is secret.
//
// Host-scoped: git's prompt is `Username for 'https://github.com': ` etc. We
// answer ONLY when the prompt names github.com; for any other host (e.g. one an
// `insteadOf`/`pushurl` rewrite redirected to) we exit non-zero WITHOUT printing
// the token, so a redirect can never exfiltrate it. The analyzer already blocks
// the known redirect vectors; this is defense-in-depth at the credential edge.
//
// Two prompt shapes must match, because git rewrites the host between the two
// prompts of a single clone/fetch: it first asks `Username for
// 'https://github.com': `, and AFTER we answer `x-access-token` it folds that
// userinfo into the host of the SECOND prompt — `Password for
// 'https://x-access-token@github.com': `. So we accept both bare-host
// (\`//github.com/\` or \`//github.com'\`) and userinfo-host
// (\`//<user>@github.com/\` or \`//<user>@github.com'\`). The anchor is the
// literal \`github.com\` immediately followed by \`/\` or the closing quote git
// wraps the URL in, so it cannot be fooled by \`evil-github.com\`,
// \`github.com.evil/\`, or \`x@github.com.evil/\`. Without the userinfo arm the
// password prompt falls through to \`exit 1\` and every HTTPS clone/fetch fails
// with "unable to read askpass response".
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *//github.com/*|*//github.com\\'*|*//*@github.com/*|*//*@github.com\\'*) : ;;
  *) exit 1 ;;
esac
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$TYPECLAW_GIT_TOKEN" ;;
esac
`

// /usr is --ro-bind mounted into the per-tool bwrap sandbox (src/sandbox/build.ts),
// so a helper here is readable by sandboxed bash; the per-session /tmp bind is not
// a stable path. TYPECLAW_GIT_ASKPASS_PATH overrides it for tests/CI, which
// cannot write under /usr.
export const TYPECLAW_GIT_ASKPASS_PATH = '/usr/local/bin/typeclaw-git-askpass'

function defaultPath(): string {
  const override = process.env.TYPECLAW_GIT_ASKPASS_PATH
  return override !== undefined && override !== '' ? override : TYPECLAW_GIT_ASKPASS_PATH
}

let ensurePromise: Promise<string> | null = null

export function resetGitAskPassHelperForTests(): void {
  ensurePromise = null
}

// Writes the helper once per process (idempotent, race-safe via the shared
// promise) and returns its absolute path. The temp name is unpredictable and
// opened with `wx` (exclusive create, fails on an existing file/symlink) so a
// planted symlink cannot redirect the write; then atomically renamed so a
// concurrent reader never sees a partial file.
export function ensureGitAskPassHelper(path: string = defaultPath()): Promise<string> {
  if (ensurePromise !== null) return ensurePromise
  ensurePromise = (async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.typeclaw-git-askpass.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(tmp, ASKPASS_SCRIPT, { mode: 0o755, flag: 'wx' })
    await chmod(tmp, 0o755)
    await rename(tmp, path)
    return path
  })().catch((err) => {
    ensurePromise = null
    throw err
  })
  return ensurePromise
}
