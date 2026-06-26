import { rm } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const MAX_ATTEMPTS = 30
const RETRY_DELAY_MS = 200
const RETRYABLE_RM_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

export async function rmTempDir(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // bun:sqlite keeps the index.db file handle alive through Statement
      // wrappers that have not been GC'd, which blocks rmdir on Windows with
      // EBUSY (Bun #25964). Forcing GC runs their finalizers and releases the
      // handle before each removal attempt; the retry covers any residual lag.
      Bun.gc(true)
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (!isRetryableRmError(err) || attempt === MAX_ATTEMPTS) throw err
      await setTimeout(RETRY_DELAY_MS)
    }
  }
}

function isRetryableRmError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && RETRYABLE_RM_CODES.has(String(err.code))
}
