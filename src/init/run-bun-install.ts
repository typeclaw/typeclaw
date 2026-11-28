import { existsSync, lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { credentialStagingDir, ensureOwnerOnlyDir } from './staged-write'

export type InstallResult = { ok: true } | { ok: false; reason: string }

const INSTALL_TIMEOUT_MS = 300_000

// Written into node_modules after an install that built the tree from empty
// with the copyfile backend and verified no installed file shares an inode with
// anything else (the host's Bun cache). ensureDeps rebuilds when it is missing.
export const COPYFILE_INSTALL_MARKER = '.typeclaw-copyfile-install'

export type InstallRunnerOptions = {
  // Append `--force` to the bun install argv to bypass the package cache and
  // re-install every package. Not needed to refresh a `file:` dep: a plain
  // install already re-copies it from its current source.
  force?: boolean
  timeoutMs?: number
  spawn?: typeof Bun.spawn
  // The host environment the install would otherwise inherit. Test seam; the
  // child only ever receives the hostInstallEnv() subset of it.
  env?: Record<string, string | undefined>
}

// Signature for the function `runInit` uses to materialize the agent folder's
// dependencies. Exposed as a named type so callers (and tests) can pass their
// own stub without re-declaring the shape, mirroring `HatchRunner` and
// `KakaotalkAuthRunner` in `./index.ts`.
export type InstallRunner = (cwd: string, opts?: InstallRunnerOptions) => Promise<InstallResult>

export async function runBunInstall(cwd: string, opts?: InstallRunnerOptions): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  const env = hostInstallEnv(opts?.env ?? process.env)
  if (!env.ok) return env
  const nodeModules = join(cwd, 'node_modules')
  const buildsFromEmpty = !existsSync(nodeModules)
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
    const result = await withOperatorDotenvHidden(cwd, () =>
      runTimedBunProcess({
        cmd: hostBunCommand(['install', ...HOST_INSTALL_FLAGS, ...(opts?.force ? ['--force'] : [])]),
        cwd,
        env: env.env,
        timeoutMs: opts?.timeoutMs ?? INSTALL_TIMEOUT_MS,
        spawn: opts?.spawn ?? bun.spawn,
        timeoutReason: (seconds) => `bun install timed out after ${seconds}s`,
        failureReason: (code, stderr) => `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}`,
      }),
    )
    if (result.ok && buildsFromEmpty && existsSync(nodeModules) && !(await sharesInodes(nodeModules))) {
      writeFileSync(join(nodeModules, COPYFILE_INSTALL_MARKER), '')
    }
    return result
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
export type UpdateRunnerOptions = Pick<InstallRunnerOptions, 'timeoutMs' | 'spawn' | 'env'>

export type UpdateRunner = (cwd: string, pkg: string, opts?: UpdateRunnerOptions) => Promise<InstallResult>

export async function runBunUpdate(cwd: string, pkg: string, opts?: UpdateRunnerOptions): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  const env = hostInstallEnv(opts?.env ?? process.env)
  if (!env.ok) return env
  try {
    // `bun update <pkg> --latest` re-resolves <pkg> against the registry,
    // capped by the spec in package.json. For a caret/tilde range this
    // pulls the highest in-range version (the case `bun install` won't
    // upgrade because the lockfile already satisfies the spec). For an
    // exact pin it's effectively a force re-fetch of that exact version.
    // `--linker=hoisted` for the same Bun 1.3.x deadlock reason as
    // runBunInstall above.
    return await withOperatorDotenvHidden(cwd, () =>
      runTimedBunProcess({
        cmd: hostBunCommand(['update', pkg, '--latest', ...HOST_INSTALL_FLAGS]),
        cwd,
        env: env.env,
        timeoutMs: opts?.timeoutMs ?? INSTALL_TIMEOUT_MS,
        spawn: opts?.spawn ?? bun.spawn,
        timeoutReason: (seconds) => `bun update ${pkg} timed out after ${seconds}s`,
        failureReason: (code, stderr) => `bun update ${pkg} exited with code ${code}: ${stderr.trim() || 'no stderr'}`,
      }),
    )
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Bun's package manager loads the project's dotenv files and expands them
// through .npmrc, and nothing turns that off (on Bun 1.4.0, `--no-env-file`,
// `--env-file`, bunfig `env = false`, and `--cwd` from elsewhere all still load
// them). The agent can write .npmrc and every dotenv file except the operator's
// .env, so .env is the only one holding values the agent does not already know:
// it waits in the masked credential-staging dir while host Bun runs. A rename
// keeps the file's inode, so its ownership and ACLs come back unchanged.
export function recoverHiddenOperatorDotenv(cwd: string): void {
  const staged = hiddenDotenvPath(cwd)
  if (!lexists(staged)) return
  if (lexists(join(cwd, '.env'))) rmSync(staged, { force: true })
  else renameSync(staged, join(cwd, '.env'))
}

async function withOperatorDotenvHidden<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  recoverHiddenOperatorDotenv(cwd)
  const dotenv = join(cwd, '.env')
  if (!lexists(dotenv)) return await run()
  ensureOwnerOnlyDir(credentialStagingDir(cwd))
  renameSync(dotenv, hiddenDotenvPath(cwd))
  try {
    return await run()
  } finally {
    recoverHiddenOperatorDotenv(cwd)
  }
}

function hiddenDotenvPath(cwd: string): string {
  return join(credentialStagingDir(cwd), 'host-bun.env')
}

function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

async function sharesInodes(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (await sharesInodes(path)) return true
    } else if (entry.isFile() && (await lstat(path)).nlink > 1) {
      return true
    }
  }
  return false
}

// Resolves the latest published version of a package for plugin reconcile.
// Runs from a neutral directory so the agent folder's .npmrc is never read,
// with the same config and env isolation as the installs.
export async function runBunPmViewVersion(
  packageName: string,
  opts?: Pick<InstallRunnerOptions, 'env' | 'spawn'>,
): Promise<{ ok: true; stdout: string } | { ok: false; code: number | null; stderr: string }> {
  const env = hostInstallEnv(opts?.env ?? process.env)
  if (!env.ok) return { ok: false, code: null, stderr: env.reason }
  const proc = (opts?.spawn ?? Bun.spawn)({
    cmd: hostBunCommand(['pm', 'view', packageName, 'version']),
    cwd: operatorConfigDir(),
    env: env.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return code === 0 ? { ok: true, stdout } : { ok: false, code, stderr }
}

// The agent folder is agent-writable: its root and workspace manifests, and
// its bunfig.toml and .npmrc. Host Bun runs there as the operator, so the
// agent must not reach host execution or host secrets through it:
// - `--ignore-scripts` stops every lifecycle script (root, workspace, and
//   dependency). The agent runs trusted scripts itself, in the sandbox.
// - `--config` points Bun at a private empty bunfig, so the agent's
//   bunfig.toml (including `[install.security] scanner`, a module Bun loads
//   during install) is never read.
// - `--backend=copyfile` keeps installed files off the host cache's inodes;
//   Linux defaults to hardlinks, and the agent can write node_modules.
// - .npmrc expands `${VAR}` from this env into registry auth headers, so the
//   child gets only what an install needs, never the operator's shell secrets.
//   Proxy and registry URLs stay because corporate networks and mirrors cannot
//   install without them, but one carrying credentials is refused rather than
//   exposed.
const HOST_INSTALL_FLAGS = ['--linker=hoisted', '--ignore-scripts', '--backend=copyfile']

function hostBunCommand(args: string[]): string[] {
  return ['bun', `--config=${join(operatorConfigDir(), 'bunfig.toml')}`, ...args]
}

let configDir: string | undefined

function operatorConfigDir(): string {
  if (configDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-bun-'))
    writeFileSync(join(dir, 'bunfig.toml'), '')
    // `bun pm view` refuses to run without a manifest in its working directory.
    writeFileSync(join(dir, 'package.json'), '{"name":"typeclaw-registry-lookup","private":true}\n')
    configDir = dir
  }
  return configDir
}

const URL_ENV_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'BUN_CONFIG_REGISTRY', 'NPM_CONFIG_REGISTRY'])

const HOST_INSTALL_ENV_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'BUN_INSTALL',
  'BUN_INSTALL_CACHE_DIR',
  'BUN_INSTALL_GLOBAL_DIR',
  'BUN_CONFIG_REGISTRY',
  'NPM_CONFIG_REGISTRY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
])

function hostInstallEnv(
  env: Record<string, string | undefined>,
): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  const allowed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase()
    if (value === undefined || !HOST_INSTALL_ENV_NAMES.has(upper)) continue
    if (URL_ENV_NAMES.has(upper) && value.includes('@')) {
      return {
        ok: false,
        reason: `${name} carries credentials in its URL. TypeClaw does not pass a credentialed URL to Bun in the agent folder, because the folder's agent-writable .npmrc can copy environment values into registry requests. Point ${name} at a URL without credentials (for a proxy, a local authenticating proxy; for a registry, a token in your user-level ~/.npmrc) and retry.`,
      }
    }
    allowed[name] = value
  }
  return { ok: true, env: allowed }
}

async function runTimedBunProcess({
  cmd,
  cwd,
  env,
  timeoutMs,
  spawn,
  timeoutReason,
  failureReason,
}: {
  cmd: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  spawn: typeof Bun.spawn
  timeoutReason: (seconds: number) => string
  failureReason: (code: number, stderr: string) => string
}): Promise<InstallResult> {
  const proc = spawn({ cmd, cwd, env, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    // Drain both pipes alongside exit: an undrained 'pipe' stdout/stderr holds
    // its fd (and can deadlock a child that fills the buffer) until GC. A drain
    // that rejects must not escape before the child is reaped — otherwise the
    // `finally` clears the timeout while the process is still alive. Kill and
    // await exit on any drain failure so the timer never disarms a live child.
    const stdoutDrain = new Response(proc.stdout).text()
    const stderrDrain = new Response(proc.stderr).text()
    let code: number
    let stderr: string
    try {
      ;[code, , stderr] = await Promise.all([proc.exited, stdoutDrain, stderrDrain])
    } catch (err) {
      proc.kill('SIGKILL')
      await Promise.allSettled([proc.exited, stdoutDrain, stderrDrain])
      throw err
    }
    if (timedOut) return { ok: false, reason: timeoutReason(timeoutMs / 1000) }
    if (code === 0) return { ok: true }
    return { ok: false, reason: failureReason(code, stderr) }
  } finally {
    clearTimeout(timeout)
  }
}
