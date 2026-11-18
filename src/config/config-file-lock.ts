import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, fstatSync, openSync, statSync, unlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'

// Cross-process lock for an agent config file (typeclaw.json, cron.json). The
// agent folder is bind-mounted into the container, so `<file>.lock` next to the
// file is shared by host CLI processes and the container runtime. Every writer
// holds it from its read (or guard check) through its write, so no other
// writer's bytes can land in between and be clobbered by a stale result.

const ACQUIRE_TIMEOUT_MS = 5_000
// A holder finishes in milliseconds; a lock this old was left by a crashed
// process and would otherwise wedge config writes until removed by hand.
const STALE_LOCK_MS = 10_000
const RETRY_MS = 20

export type ConfigFileLockOptions = { timeoutMs?: number }

type Held = { lock: string; ino: number }

// Locks held by the current call chain, so a writer that reaches another
// locked writer (a mutation validating config, which may persist a migration)
// re-enters instead of waiting on itself.
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()
// Locks this process holds from an async holder. A sync acquirer outside that
// holder's call chain cannot wait for it: the event loop the holder needs to
// finish is blocked by the wait.
const asyncHeld = new Set<string>()

export function configFileLockPath(file: string): string {
  return `${resolve(file)}.lock`
}

export async function withConfigFileLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: ConfigFileLockOptions = {},
): Promise<T> {
  const lock = configFileLockPath(file)
  if (heldLocks.getStore()?.has(lock)) return fn()
  const deadline = Date.now() + (options.timeoutMs ?? ACQUIRE_TIMEOUT_MS)
  let held = tryAcquire(lock)
  while (held === undefined) {
    if (Date.now() >= deadline) throw lockTimeoutError(file, lock)
    await new Promise((done) => setTimeout(done, RETRY_MS))
    held = tryAcquire(lock)
  }
  asyncHeld.add(lock)
  try {
    return await heldLocks.run(withLock(lock), fn)
  } finally {
    asyncHeld.delete(lock)
    release(held)
  }
}

export function withConfigFileLockSync<T>(file: string, fn: () => T, options: ConfigFileLockOptions = {}): T {
  const lock = configFileLockPath(file)
  if (heldLocks.getStore()?.has(lock)) return fn()
  if (asyncHeld.has(lock)) {
    throw new Error(
      `${basename(file)} is being written by another operation in this process (${lock}); retry once it finishes.`,
    )
  }
  const deadline = Date.now() + (options.timeoutMs ?? ACQUIRE_TIMEOUT_MS)
  let held = tryAcquire(lock)
  while (held === undefined) {
    if (Date.now() >= deadline) throw lockTimeoutError(file, lock)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS)
    held = tryAcquire(lock)
  }
  try {
    return heldLocks.run(withLock(lock), fn)
  } finally {
    release(held)
  }
}

function withLock(lock: string): ReadonlySet<string> {
  return new Set([...(heldLocks.getStore() ?? []), lock])
}

function tryAcquire(lock: string): Held | undefined {
  try {
    const fd = openSync(lock, 'wx')
    try {
      return { lock, ino: fstatSync(fd).ino }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  reclaimIfStale(lock)
  return undefined
}

function reclaimIfStale(lock: string): void {
  const stale = statOrUndefined(lock)
  if (stale === undefined || Date.now() - stale.mtimeMs < STALE_LOCK_MS) return
  // Re-stat so a lock another waiter just reclaimed and re-created is left alone.
  const current = statOrUndefined(lock)
  if (current?.ino !== stale.ino || current.mtimeMs !== stale.mtimeMs) return
  unlinkIfPresent(lock)
}

function release(held: Held): void {
  // Leave the lock alone if it was reclaimed as stale and now belongs to someone else.
  if (statOrUndefined(held.lock)?.ino === held.ino) unlinkIfPresent(held.lock)
}

function statOrUndefined(lock: string): { ino: number; mtimeMs: number } | undefined {
  try {
    return statSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function unlinkIfPresent(lock: string): void {
  try {
    unlinkSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function lockTimeoutError(file: string, lock: string): Error {
  return new Error(
    `Timed out waiting for the ${basename(file)} write lock (${lock}). Another typeclaw process is writing ${basename(file)}; retry once it finishes. If no typeclaw process is writing it, remove the stale lock with \`rm "${lock}"\`.`,
  )
}
