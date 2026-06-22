import { isWindows } from '../shared/platform'

export type InstallResult = { ok: true } | { ok: false; reason: string }

const INSTALL_TIMEOUT_MS = 300_000

export type InstallRunnerOptions = {
  // Append `--force` to the bun install argv to bypass the cache for
  // `file:` / `link:` deps. Bun treats name+version of a `file:` dep as a
  // cache hit even after the source on disk has changed, so changes to a
  // locally-linked typeclaw never propagate into <agent>/node_modules until
  // either the typeclaw version is bumped or the install is forced.
  force?: boolean
  timeoutMs?: number
  spawn?: typeof Bun.spawn
  // Defaults to `process.platform`; tests inject it to assert the backend
  // argv without mutating the read-only `process.platform`.
  platform?: NodeJS.Platform
}

// On Windows, Bun's default install backend is `hardlink` (CreateHardLinkW).
// When the hardlink fails — cross-context copies, locked files, antivirus
// (Defender) real-time scanning of the cache or destination — Bun's per-file
// path falls back to CopyFileW, but if that ALSO fails it aborts the whole
// install: the outer hardlink→copyfile fallback in Bun is `#[cfg(not(windows))]`,
// so Windows has no recovery and surfaces "EPERM: failed copying files from
// cache to destination". This bites the `bun link` dev workflow hardest, where
// a `file:` typeclaw dep copies the whole source tree (including `.git/`) into
// <agent>/node_modules. `--backend=copyfile` skips CreateHardLinkW entirely and
// uses CopyFileW directly, which sidesteps the hardlink-permission failure.
// POSIX keeps Bun's default (hardlink on Linux, clonefile on macOS).
function bunInstallBackendArgs(platform?: NodeJS.Platform): string[] {
  return isWindows(platform ?? process.platform) ? ['--backend=copyfile'] : []
}

// Signature for the function `runInit` uses to materialize the agent folder's
// dependencies. Exposed as a named type so callers (and tests) can pass their
// own stub without re-declaring the shape, mirroring `HatchRunner` and
// `KakaotalkAuthRunner` in `./index.ts`.
export type InstallRunner = (cwd: string, opts?: InstallRunnerOptions) => Promise<InstallResult>

export async function runBunInstall(cwd: string, opts?: InstallRunnerOptions): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    // `--linker=hoisted` sidesteps a deadlock in Bun 1.3.x's isolated linker
    // (the default since 1.3.0). When any single package fetch fails — 401,
    // SHA-512 mismatch, transient registry 5xx, the kind of flake that's
    // routine on GitHub Actions shared-IP runners — the isolated linker
    // hangs the process indefinitely instead of erroring out
    // (oven-sh/bun#26341, oven-sh/bun#29646). `bun install` runs here over
    // ~500 transitive packages with no lockfile, so the odds of triggering
    // the bug are non-trivial. Hoisted is the fallback strategy bun shipped
    // before 1.3 — slightly slower for huge monorepos, indistinguishable
    // for an agent folder, and not affected by the bug.
    //
    // `--force` is conditional: it bypasses the package cache so file:/link:
    // deps re-copy their current on-disk source into node_modules. Bun's
    // file-dep cache is keyed on name+version, so without --force, edits to
    // a `file:..` typeclaw never reach the container after the first install.
    const backend = bunInstallBackendArgs(opts?.platform)
    return await runTimedBunProcess({
      cmd: opts?.force
        ? ['bun', 'install', '--linker=hoisted', ...backend, '--force']
        : ['bun', 'install', '--linker=hoisted', ...backend],
      cwd,
      timeoutMs: opts?.timeoutMs ?? INSTALL_TIMEOUT_MS,
      spawn: opts?.spawn ?? bun.spawn,
      timeoutReason: (seconds) => `bun install timed out after ${seconds}s`,
      failureReason: (code, stderr) => `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}`,
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Signature for the function that re-resolves a SINGLE dep against its
// current spec. Distinct from InstallRunner because the auto-upgrade path
// MUST force re-resolution against the registry (lockfile-honoring `bun
// install` would no-op when the existing lockfile entry already satisfies
// an in-range spec — which is the exact regression auto-upgrade exists to
// prevent).
export type UpdateRunnerOptions = Pick<InstallRunnerOptions, 'timeoutMs' | 'spawn' | 'platform'>

export type UpdateRunner = (cwd: string, pkg: string, opts?: UpdateRunnerOptions) => Promise<InstallResult>

export async function runBunUpdate(cwd: string, pkg: string, opts?: UpdateRunnerOptions): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    // `bun update <pkg> --latest` re-resolves <pkg> against the registry,
    // capped by the spec in package.json. For a caret/tilde range this
    // pulls the highest in-range version (the case `bun install` won't
    // upgrade because the lockfile already satisfies the spec). For an
    // exact pin it's effectively a force re-fetch of that exact version.
    // `--linker=hoisted` for the same Bun 1.3.x deadlock reason as
    // runBunInstall above.
    return await runTimedBunProcess({
      cmd: ['bun', 'update', pkg, '--latest', '--linker=hoisted', ...bunInstallBackendArgs(opts?.platform)],
      cwd,
      timeoutMs: opts?.timeoutMs ?? INSTALL_TIMEOUT_MS,
      spawn: opts?.spawn ?? bun.spawn,
      timeoutReason: (seconds) => `bun update ${pkg} timed out after ${seconds}s`,
      failureReason: (code, stderr) => `bun update ${pkg} exited with code ${code}: ${stderr.trim() || 'no stderr'}`,
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function runTimedBunProcess({
  cmd,
  cwd,
  timeoutMs,
  spawn,
  timeoutReason,
  failureReason,
}: {
  cmd: string[]
  cwd: string
  timeoutMs: number
  spawn: typeof Bun.spawn
  timeoutReason: (seconds: number) => string
  failureReason: (code: number, stderr: string) => string
}): Promise<InstallResult> {
  const proc = spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    const code = await proc.exited
    if (timedOut) return { ok: false, reason: timeoutReason(timeoutMs / 1000) }
    if (code === 0) return { ok: true }
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, reason: failureReason(code, stderr) }
  } finally {
    clearTimeout(timeout)
  }
}
