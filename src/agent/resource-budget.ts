import { config, deriveProcessResourceBudgetLimits, type ModelToolLimits } from '@/config'

export type ResourceClaim = {
  memoryBytes: number
  pinnedBytes: number
  pinnedCount: number
}

export type ResourceBudgetLimits = {
  maxMemoryBytes: number
  maxPinnedBytes: number
  maxPinnedCount: number
  maxWaiters: number
}

export type ResourceLease = {
  tryResize(next: Partial<ResourceClaim>): boolean
  release(): void
}

type AdmissionRequest = {
  claim: ResourceClaim
  signal?: AbortSignal
  resolve(lease: ResourceLease): void
  reject(error: Error): void
  onAbort?: () => void
}

const EMPTY_CLAIM: ResourceClaim = { memoryBytes: 0, pinnedBytes: 0, pinnedCount: 0 }

export class WeightedResourceBudget {
  private usageState: ResourceClaim = { ...EMPTY_CLAIM }
  private readonly queue: AdmissionRequest[] = []

  constructor(private readonly limits: ResourceBudgetLimits) {}

  async acquire(claim: Partial<ResourceClaim>, signal?: AbortSignal): Promise<ResourceLease> {
    const normalized = normalizeClaim(claim)
    this.assertWithinAbsoluteLimits(normalized)
    if (signal?.aborted === true) throw admissionAbortError(signal)
    if (this.queue.length >= this.limits.maxWaiters) {
      throw new Error(`process resource waiter queue is full (${this.limits.maxWaiters} waiters)`)
    }
    return await new Promise<ResourceLease>((resolve, reject) => {
      const request: AdmissionRequest = { claim: normalized, signal, resolve, reject }
      if (signal !== undefined) {
        request.onAbort = () => {
          const index = this.queue.indexOf(request)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(admissionAbortError(signal))
          this.drain()
        }
        signal.addEventListener('abort', request.onAbort, { once: true })
      }
      this.queue.push(request)
      this.drain()
    })
  }

  usage(): ResourceClaim & { waiters: number } {
    return { ...this.usageState, waiters: this.queue.length }
  }

  private assertWithinAbsoluteLimits(claim: ResourceClaim): void {
    if (claim.memoryBytes > this.limits.maxMemoryBytes)
      throw new Error('resource request exceeds the process-wide memory budget')
    if (claim.pinnedBytes > this.limits.maxPinnedBytes || claim.pinnedCount > this.limits.maxPinnedCount)
      throw new Error('resource request exceeds the process-wide pinned snapshot budget')
  }

  private fits(claim: ResourceClaim, current: ResourceClaim = this.usageState): boolean {
    return (
      current.memoryBytes + claim.memoryBytes <= this.limits.maxMemoryBytes &&
      current.pinnedBytes + claim.pinnedBytes <= this.limits.maxPinnedBytes &&
      current.pinnedCount + claim.pinnedCount <= this.limits.maxPinnedCount
    )
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0] as AdmissionRequest
      if (!this.fits(next.claim)) return
      this.queue.shift()
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort)
      this.add(next.claim)
      let leased = next.claim
      let released = false
      next.resolve({
        tryResize: (patch) => {
          if (released) return false
          const resized = normalizeClaim({ ...leased, ...patch })
          try {
            this.assertWithinAbsoluteLimits(resized)
          } catch {
            return false
          }
          const withoutLease = subtractClaims(this.usageState, leased)
          if (!this.fits(resized, withoutLease)) return false
          this.usageState = addClaims(withoutLease, resized)
          leased = resized
          this.drain()
          return true
        },
        release: () => {
          if (released) return
          released = true
          this.usageState = subtractClaims(this.usageState, leased)
          this.drain()
        },
      })
    }
  }

  private add(claim: ResourceClaim): void {
    this.usageState = addClaims(this.usageState, claim)
  }
}

export function createProcessResourceBudget(limits: ModelToolLimits): WeightedResourceBudget {
  return new WeightedResourceBudget(deriveProcessResourceBudgetLimits(limits))
}

export const processResourceBudget = createProcessResourceBudget(config.modelTools.limits)

function normalizeClaim(claim: Partial<ResourceClaim>): ResourceClaim {
  const normalized = { ...EMPTY_CLAIM, ...claim }
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid process resource claim ${name}: ${value}`)
  }
  return normalized
}

function addClaims(left: ResourceClaim, right: ResourceClaim): ResourceClaim {
  return {
    memoryBytes: left.memoryBytes + right.memoryBytes,
    pinnedBytes: left.pinnedBytes + right.pinnedBytes,
    pinnedCount: left.pinnedCount + right.pinnedCount,
  }
}

function subtractClaims(left: ResourceClaim, right: ResourceClaim): ResourceClaim {
  return {
    memoryBytes: left.memoryBytes - right.memoryBytes,
    pinnedBytes: left.pinnedBytes - right.pinnedBytes,
    pinnedCount: left.pinnedCount - right.pinnedCount,
  }
}

function admissionAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return new Error(`process resource wait aborted${reason === undefined ? '' : `: ${String(reason)}`}`)
}
