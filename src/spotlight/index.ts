import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

import type { HelperResponse } from './helper'

// Spotlight re-indexes every append to an agent's session, channel, and todo
// logs. On a long-running macOS host that churn grew one index store to
// 330 GB and filled the disk, which stopped the Docker VM and then the host.
// The agent folder is runtime state nobody searches, so typeclaw adds it to
// Spotlight's Privacy list. No public API or marker file does this:
// `.metadata_never_index` is ignored on current macOS, so the private
// Metadata.framework calls behind System Settings are the only per-folder
// control that works without sudo. See ./helper.ts for how their absence or
// breakage is contained.

export type SpotlightExclusionOutcome =
  | { kind: 'excluded'; changed: boolean }
  | { kind: 'not-excluded' }
  | { kind: 'skipped'; reason: 'not-macos' | 'never-indexed' }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'failed'; detail: string }

export type HelperRun = {
  stdout: string
  exitCode: number | null
  signalCode: string | null
  timedOut: boolean
}

export type SpotlightDeps = {
  platform?: NodeJS.Platform
  runHelper?: (op: 'check' | 'ensure', dir: string) => Promise<HelperRun>
  neverIndexedRoots?: () => string[]
}

const HELPER_ENTRY = join(import.meta.dir, 'helper.ts')
// Covers the helper's whole retry budget plus Bun startup; past it mds is
// treated as hung and the child is killed.
export const HELPER_TIMEOUT_MS = 20_000

export function checkSpotlightExclusion(dir: string, deps: SpotlightDeps = {}): Promise<SpotlightExclusionOutcome> {
  return runOp('check', dir, deps)
}

export function ensureSpotlightExclusion(dir: string, deps: SpotlightDeps = {}): Promise<SpotlightExclusionOutcome> {
  return runOp('ensure', dir, deps)
}

export function spotlightWarning(dir: string, outcome: SpotlightExclusionOutcome): string | null {
  if (outcome.kind !== 'unavailable' && outcome.kind !== 'failed') return null
  return `typeclaw: could not exclude the agent folder from Spotlight (${outcome.detail}). Spotlight re-indexes the agent's logs on every write and its index can grow until the disk fills. Add ${dir} under System Settings > Spotlight > Search Privacy.`
}

async function runOp(op: 'check' | 'ensure', dir: string, deps: SpotlightDeps): Promise<SpotlightExclusionOutcome> {
  if ((deps.platform ?? process.platform) !== 'darwin') return { kind: 'skipped', reason: 'not-macos' }
  let target: string
  try {
    target = realpathSync(dir)
  } catch (error) {
    return { kind: 'failed', detail: `cannot resolve ${dir}: ${errorText(error)}` }
  }
  if (isNeverIndexed(target, deps.neverIndexedRoots?.() ?? NEVER_INDEXED_ROOTS)) {
    return { kind: 'skipped', reason: 'never-indexed' }
  }

  let run: HelperRun
  try {
    run = await (deps.runHelper ?? spawnHelper)(op, target)
  } catch (error) {
    return { kind: 'failed', detail: `could not start the Spotlight helper: ${errorText(error)}` }
  }
  if (run.timedOut) return { kind: 'failed', detail: 'Spotlight did not respond in time' }
  // A signal means the private API crashed the helper, which is how a changed
  // signature shows up; treat it like a missing symbol.
  if (run.signalCode !== null) return { kind: 'unavailable', detail: `Spotlight helper crashed (${run.signalCode})` }

  const response = parseResponse(run.stdout)
  if (response === null) return { kind: 'failed', detail: `Spotlight helper exited ${run.exitCode} without a result` }
  if (!response.ok) {
    return response.code === 'unavailable'
      ? { kind: 'unavailable', detail: `Spotlight exclusion API unavailable: ${response.detail}` }
      : { kind: 'failed', detail: response.detail }
  }
  switch (response.state) {
    case 'excluded':
      return { kind: 'excluded', changed: false }
    case 'newly-excluded':
      return { kind: 'excluded', changed: true }
    case 'not-excluded':
      return { kind: 'not-excluded' }
  }
}

// Spotlight never indexes the system temp locations or anything under a
// dot-directory, so an exclusion there is a no-op that would only clutter the
// Privacy list. The roots are fixed rather than read from TMPDIR, which an
// operator can point at an ordinary, indexed directory.
export const NEVER_INDEXED_ROOTS = ['/private/tmp', '/private/var/folders']

function isNeverIndexed(target: string, roots: string[]): boolean {
  if (target.split(sep).some((part) => part.startsWith('.') && part.length > 1)) return true
  return roots.some((root) => target === root || target.startsWith(`${root}${sep}`))
}

async function spawnHelper(op: 'check' | 'ensure', dir: string): Promise<HelperRun> {
  // Bun auto-loads .env from the working directory; running from the helper's
  // own source directory keeps the agent's .env out of the child on every
  // supported Bun, including versions without --no-env-file.
  const child = Bun.spawn([process.execPath, HELPER_ENTRY, op, dir], {
    cwd: import.meta.dir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: {},
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, HELPER_TIMEOUT_MS)
  try {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { stdout, exitCode: child.exitCode, signalCode: timedOut ? null : child.signalCode, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

const SUCCESS_STATES = new Set(['excluded', 'not-excluded', 'newly-excluded'])
const FAILURE_CODES = new Set(['unavailable', 'not-applied', 'bad-request'])

function parseResponse(stdout: string): HelperResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { ok, state, code, detail } = parsed as Record<string, unknown>
  if (ok === true && typeof state === 'string' && SUCCESS_STATES.has(state)) return parsed as HelperResponse
  if (ok === false && typeof code === 'string' && FAILURE_CODES.has(code) && typeof detail === 'string') {
    return parsed as HelperResponse
  }
  return null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
