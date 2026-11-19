// Spaces outbound requests to one search engine by a minimum interval, process-
// wide. A concurrency cap bounds parallelism but not rate, and the free engines
// gate on rate: a subagent fan-out fires a burst of searches at once, so each
// caller reserves the next free slot and sleeps until it, turning the burst
// into a queue instead of a volley. The first request in a quiet period goes
// out immediately.

export type PacerOptions = {
  intervalMs: number
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type RequestPacer = {
  waitForSlot(signal?: AbortSignal): Promise<void>
}

export function createRequestPacer(options: PacerOptions): RequestPacer {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? abortableSleep
  let nextRequestAt = 0
  return {
    async waitForSlot(signal) {
      const at = now()
      const slot = Math.max(at, nextRequestAt)
      nextRequestAt = slot + options.intervalMs
      if (slot > at) await sleep(slot - at, signal)
    },
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
