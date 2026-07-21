import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// A GIT_ASKPASS helper git invokes for username/password prompts. The token
// rides in TYPECLAW_GIT_TOKEN (a runtime-owned git env), NEVER in argv or
// git config — so it cannot leak through process listings, logs, or .git/config.
// The script contents are constant and secret-free; only the env value is secret.
//
// Host-scoped: git's prompt is `Username for 'https://github.com': ` etc. We
// answer ONLY when the prompt names github.com; for any other host (e.g. one an
// `insteadOf`/`pushurl` rewrite redirected to) we exit non-zero WITHOUT printing
// the token, so a redirect can never exfiltrate it. Runtime-owned callers also
// constrain git config; this is defense-in-depth at the credential edge.
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

// The base is the FIXED real `/tmp`, NOT `os.tmpdir()`: os.tmpdir() honors
// TMPDIR/TMP/TEMP, so an env pointing it at a model-writable location would let a
// model-driven tool replace the cached helper before a later runtime-owned reviewer
// checkout / backup push executes it with TYPECLAW_GIT_TOKEN in env. A random
// `mkdtemp` subdir (mode 0700) keeps the name unpredictable.
const ASKPASS_DIR_BASE = '/tmp/typeclaw-git-askpass-'

let defaultDirPromise: Promise<string> | null = null

function configuredPath(): string | undefined {
  const path = process.env.TYPECLAW_GIT_ASKPASS_PATH
  return path !== undefined && path !== '' ? path : undefined
}

function resolveDefaultDir(): Promise<string> {
  if (defaultDirPromise === null) defaultDirPromise = mkdtemp(ASKPASS_DIR_BASE)
  return defaultDirPromise.catch((err) => {
    defaultDirPromise = null
    throw err
  })
}

// The path runtime-owned execFile consumers (reviewer checkout, backup push) use:
// a runtime-writable, unpredictable real-/tmp path. They don't run under bwrap, so
// /tmp masking doesn't apply, and a non-root runtime can write here.
async function defaultPath(): Promise<string> {
  return configuredPath() ?? join(await resolveDefaultDir(), 'typeclaw-git-askpass')
}

// Keyed by resolved path: a single shared promise would let the first caller's
// path win even when a later caller explicitly asks for a different one.
const ensurePromises = new Map<string, Promise<string>>()

export function resetGitAskPassHelperForTests(): void {
  ensurePromises.clear()
  defaultDirPromise = null
}

// Returns the helper's absolute path, creating it once per path if needed. When
// an executable file already exists at the resolved path, we return it without
// rewriting. Creates when absent at the runtime /tmp path or a writable test
// override. Idempotent + race-safe via the per-path promise; the create uses an
// unpredictable temp opened `wx` (fails on an existing file/symlink) then renamed.
export async function ensureGitAskPassHelper(path?: string): Promise<string> {
  const resolved = path ?? (await defaultPath())
  const existing = ensurePromises.get(resolved)
  if (existing !== undefined) return existing
  const pending = (async () => {
    try {
      await access(resolved, constants.X_OK)
      return resolved
    } catch {
      // not present (or not executable) — fall through to create it
    }
    await mkdir(dirname(resolved), { recursive: true })
    const tmp = join(dirname(resolved), `.typeclaw-git-askpass.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(tmp, ASKPASS_SCRIPT, { mode: 0o755, flag: 'wx' })
    await chmod(tmp, 0o755)
    await rename(tmp, resolved)
    return resolved
  })().catch((err) => {
    ensurePromises.delete(resolved)
    throw err
  })
  ensurePromises.set(resolved, pending)
  return pending
}
