import { describeError } from '../../describe-error'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

// Recovers webhook events whose delivery to our ingress FAILED and that GitHub
// never successfully redelivered. The production failure mode is inbound-only: a
// cloudflare-quick tunnel drops ~half its deliveries with 502 "failed to connect
// to host", and GitHub does not auto-redeliver issue_comment events — so a
// `@bot review please` comment is lost with no log entry and no reply.
//
// This sweep is OUTBOUND-only, so it never touches the broken inbound leg: it
// lists each managed hook's delivery log, finds events with no successful
// delivery, fetches the original payload from GitHub's authenticated deliveries
// API, and feeds it through the SAME processVerifiedGithubDelivery core a live
// webhook uses (passed in as `process`). It is a floor, not the primary path —
// webhooks remain low-latency when delivery works; reconcile-open-prs.ts is the
// sibling floor for review-state drift.

export type ManagedHook = { repo: string; hookId: number }

// Recovery-owned idempotency keyed by delivery GUID, retained for the FULL
// lookback window. The shared live dedup cannot serve this alone: it is a
// fixed 1000-entry LRU, so during a 70h lookback across many repos it can evict
// a GUID we already recovered, after which the still-listed failed delivery
// would be re-fetched and re-routed. This TTL log holds only RECOVERED GUIDs
// (failed-then-recovered deliveries, a small set), expiring each exactly when it
// also falls out of the scan window — so a recovered delivery is routed once
// regardless of live-dedup churn. (The shared dedup still guards the live-vs-
// sweep concurrency race; this guards cross-sweep durability.)
export type RecoveredGuidLog = { has: (guid: string) => boolean; record: (guid: string) => void }

export function createRecoveredGuidLog(ttlMs: number, now: () => number = Date.now): RecoveredGuidLog {
  const expiresAt = new Map<string, number>()
  return {
    has(guid: string): boolean {
      const expiry = expiresAt.get(guid)
      if (expiry === undefined) return false
      if (expiry <= now()) {
        expiresAt.delete(guid)
        return false
      }
      return true
    },
    record(guid: string): void {
      const t = now()
      for (const [g, expiry] of expiresAt) if (expiry <= t) expiresAt.delete(g)
      expiresAt.set(guid, t + ttlMs)
    },
  }
}

export type RecoverFailedDeliveriesOptions = {
  hooks: readonly ManagedHook[]
  token: (repoSlug: string) => Promise<string>
  // The shared processVerifiedGithubDelivery, bound to the adapter's handler
  // options. `delivery` is the GUID; the core dedups, filters by allowlist,
  // drops self-authored, and routes exactly as the live path does.
  process: (input: {
    event: string
    delivery: string
    payload: Record<string, unknown>
    recovered: true
  }) => Promise<void>
  // Fast-path skip backed by the LIVE delivery dedup (shared with the webhook
  // handler): a guid here was just routed live (or reserved by `process` on
  // entry), so skip it. Best-effort only — it is a 1000-entry LRU and may evict
  // within the lookback window, which is exactly why `recoveredLog` exists.
  alreadySeen: (guid: string) => boolean
  // Durable recovery idempotency for the whole lookback window (see
  // createRecoveredGuidLog). Caller-owned so it persists across sweeps.
  recoveredLog: RecoveredGuidLog
  lookbackMs: number
  maxPerSweep: number
  logger: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => number
  fetchImpl?: typeof fetch
}

export type RecoverOutcome = { recovered: number; scanned: number }

export async function recoverFailedGithubDeliveries(options: RecoverFailedDeliveriesOptions): Promise<RecoverOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const cutoff = now() - options.lookbackMs
  let recovered = 0
  let scanned = 0

  for (const hook of options.hooks) {
    // maxPerSweep is a GLOBAL budget across all hooks (an LLM-session storm
    // guard), so pass the remaining budget into each hook rather than letting
    // every hook recover up to the full cap independently.
    const remaining = options.maxPerSweep - recovered
    if (remaining <= 0) break
    const target = parseRepo(hook.repo)
    if (target === null) {
      options.logger.warn(`[github] recovery skipped malformed repo slug "${hook.repo}"`)
      continue
    }
    try {
      const result = await recoverHook(hook, target, cutoff, options, remaining, fetchImpl)
      scanned += result.scanned
      recovered += result.recovered
      if (result.recovered > 0) {
        options.logger.info(`[github] recovered ${result.recovered} missed delivery(s) on ${hook.repo}`)
      }
    } catch (err) {
      // Per-hook isolation: one repo's token/list/detail failure must not abort
      // the others. The next interval retries this hook.
      options.logger.warn(`[github] delivery recovery failed for ${hook.repo}: ${describeError(err)}`)
    }
  }
  return { recovered, scanned }
}

async function recoverHook(
  hook: ManagedHook,
  target: RepoTarget,
  cutoff: number,
  options: RecoverFailedDeliveriesOptions,
  budget: number,
  fetchImpl: typeof fetch,
): Promise<RecoverOutcome> {
  const token = await options.token(hook.repo)
  const deliveries = await listRecentDeliveries(fetchImpl, token, target, hook.hookId, cutoff)

  // Any 2xx/3xx delivery for a guid means the event got through (e.g. GitHub
  // auto-redelivered, or a manual redeliver succeeded). Never recover those.
  const succeededGuids = new Set<string>()
  for (const d of deliveries) {
    if (isSuccess(d.statusCode)) succeededGuids.add(d.guid)
  }

  let recovered = 0
  let scanned = 0
  const handledThisSweep = new Set<string>()
  for (const delivery of deliveries) {
    if (recovered >= budget) break
    if (isSuccess(delivery.statusCode)) continue
    scanned += 1
    const guid = delivery.guid
    if (guid === '') continue
    if (
      succeededGuids.has(guid) ||
      handledThisSweep.has(guid) ||
      options.alreadySeen(guid) ||
      options.recoveredLog.has(guid)
    ) {
      continue
    }
    handledThisSweep.add(guid)

    const payload = await fetchDeliveryPayload(fetchImpl, token, target, hook.hookId, delivery.id)
    if (payload === null) continue
    await options.process({ event: delivery.event, delivery: guid, payload, recovered: true })
    // Record AFTER process resolves: an unexpected throw leaves the guid
    // unrecorded so the next sweep retries it. A no-op classify still records
    // (process returned), so a non-routable failed delivery is not refetched.
    options.recoveredLog.record(guid)
    recovered += 1
  }
  return { recovered, scanned }
}

type RepoTarget = { owner: string; repo: string }

type DeliverySummary = { id: number; guid: string; event: string; statusCode: number }

async function listRecentDeliveries(
  fetchImpl: typeof fetch,
  token: string,
  target: RepoTarget,
  hookId: number,
  cutoff: number,
): Promise<DeliverySummary[]> {
  const summaries: DeliverySummary[] = []
  let url: string | null =
    `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/hooks/${hookId}/deliveries?per_page=100`
  while (url !== null) {
    const response = await fetchImpl(url, { headers: githubJsonHeaders(token) })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`GitHub deliveries ${response.status}${body !== '' ? `: ${body}` : ''}`)
    }
    const page = (await response.json().catch(() => null)) as DeliveryRow[] | null
    if (page === null) throw new Error('GitHub deliveries returned non-JSON')
    // Deliveries are newest-first; once a page's oldest entry predates the
    // lookback cutoff we can stop paginating instead of walking the full log.
    let reachedCutoff = false
    for (const row of page) {
      const parsed = parseDeliveryRow(row)
      if (parsed === null) continue
      if (parsed.deliveredAt !== null && parsed.deliveredAt < cutoff) {
        reachedCutoff = true
        continue
      }
      summaries.push(parsed.summary)
    }
    if (reachedCutoff) break
    url = nextLink(response.headers.get('link'))
  }
  return summaries
}

async function fetchDeliveryPayload(
  fetchImpl: typeof fetch,
  token: string,
  target: RepoTarget,
  hookId: number,
  deliveryId: number,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/hooks/${hookId}/deliveries/${deliveryId}`,
    { headers: githubJsonHeaders(token) },
  )
  if (!response.ok) return null
  const raw = (await response.json().catch(() => null)) as { request?: { payload?: unknown } } | null
  return coercePayload(raw?.request?.payload)
}

function coercePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(value) ? value : null
}

// GitHub records a non-delivery (connection refused / DNS / tunnel down) as
// status_code 0, and HTTP failures as 4xx/5xx. Treat 2xx and 3xx as success.
function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400
}

type DeliveryRow = {
  id?: unknown
  guid?: unknown
  event?: unknown
  status_code?: unknown
  delivered_at?: unknown
}

function parseDeliveryRow(row: DeliveryRow): { summary: DeliverySummary; deliveredAt: number | null } | null {
  const id = typeof row.id === 'number' ? row.id : null
  const guid = typeof row.guid === 'string' ? row.guid : null
  const event = typeof row.event === 'string' ? row.event : null
  const statusCode = typeof row.status_code === 'number' ? row.status_code : null
  if (id === null || guid === null || event === null || statusCode === null) return null
  const deliveredAt = typeof row.delivered_at === 'string' ? Date.parse(row.delivered_at) || null : null
  return { summary: { id, guid, event, statusCode }, deliveredAt }
}

function parseRepo(slug: string): RepoTarget | null {
  const [owner, repo, ...rest] = slug.trim().split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) return null
  return { owner, repo }
}

function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (m !== null) return m[1] ?? null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
