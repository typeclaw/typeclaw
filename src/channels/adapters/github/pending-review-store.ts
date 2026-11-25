import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { describeError } from '../../describe-error'
import { canonicalGithubRepo } from '../../github-repo'

const pendingReviewSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  prNumber: z.number().int().positive(),
  prId: z.number().int().positive(),
  kind: z.enum(['review', 'rereview']),
  headSha: z.string().min(1),
  admittedAt: z.number().finite().nonnegative(),
  authorId: z.string().min(1),
  authorName: z.string(),
  authorIsBot: z.boolean(),
  // Absent on legacy records and work admitted without an assignment trigger.
  assignmentTriggered: z.literal(true).optional(),
})

export type PendingReview = Readonly<z.infer<typeof pendingReviewSchema>>

export type PendingReviewStore = {
  list: () => Promise<readonly PendingReview[]>
  has: (repo: string, prNumber: number) => boolean
  record: (entry: PendingReview) => Promise<void>
  clear: (
    repo: string,
    prNumber: number,
    expected?: PendingReview,
    reason?: 'review-request-removed',
  ) => Promise<boolean>
}

type Logger = { warn: (message: string) => void }

export function pendingReviewPath(agentDir: string): string {
  return join(agentDir, 'channels', 'github-pending-reviews.json')
}

function key(repo: string, prNumber: number): string {
  return `${canonicalGithubRepo(repo)}#${prNumber}`
}

// All instances share a lane. A detached old adapter must not overwrite the
// replacement's admissions from a stale snapshot.
const fileLanes = new Map<string, Promise<void>>()

function onFileLane<T>(path: string, task: () => Promise<T>): Promise<T> {
  const result = (fileLanes.get(path) ?? Promise.resolve()).then(task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  fileLanes.set(path, tail)
  void tail.then(() => {
    if (fileLanes.get(path) === tail) fileLanes.delete(path)
  })
  return result
}

export async function loadPendingReviewStore(agentDir: string, logger: Logger = console): Promise<PendingReviewStore> {
  const path = pendingReviewPath(agentDir)
  let entries = await onFileLane(path, () => readEntries(path, logger))
  const latest = async (): Promise<Map<string, PendingReview>> => {
    entries = await readEntries(path, logger)
    return new Map(entries)
  }
  const persist = async (next: Map<string, PendingReview>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, `${JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2)}\n`, 'utf8')
    await rename(`${path}.tmp`, path)
    entries = next
  }
  return {
    list: () => onFileLane(path, async () => [...(await latest()).values()]),
    has: (repo, prNumber) => entries.has(key(repo, prNumber)),
    record: (entry) =>
      onFileLane(path, async () => {
        const next = await latest()
        const id = key(entry.repo, entry.prNumber)
        const previous = next.get(id)
        if (previous !== undefined && previous.admittedAt > entry.admittedAt) return
        const sameObligation = previous?.headSha === entry.headSha && previous.kind === entry.kind
        const assignmentTriggered =
          entry.assignmentTriggered ?? (sameObligation ? previous.assignmentTriggered : undefined)
        // Several thread siblings can carry the same push. They share one PR
        // obligation; keep its original admission time for completion checks.
        const sameAdmission =
          sameObligation &&
          previous.authorId === entry.authorId &&
          previous.authorName === entry.authorName &&
          previous.authorIsBot === entry.authorIsBot
        if (sameAdmission && previous.assignmentTriggered === assignmentTriggered) return
        next.set(id, {
          ...entry,
          ...(sameAdmission ? { admittedAt: previous.admittedAt } : {}),
          ...(assignmentTriggered === true ? { assignmentTriggered } : {}),
        })
        await persist(next)
      }),
    clear: (repo, prNumber, expected, reason) =>
      onFileLane(path, async () => {
        const next = await latest()
        const id = key(repo, prNumber)
        const current = next.get(id)
        if (current === undefined) return true
        // Decide on the latest persisted obligation inside the admission lane,
        // never on an old removal payload's snapshot of the PR's assignees.
        if (reason === 'review-request-removed' && current.assignmentTriggered === true) return false
        if (
          expected !== undefined &&
          (current.prId !== expected.prId ||
            current.headSha !== expected.headSha ||
            current.kind !== expected.kind ||
            current.admittedAt !== expected.admittedAt ||
            current.authorId !== expected.authorId ||
            current.authorName !== expected.authorName ||
            current.authorIsBot !== expected.authorIsBot ||
            current.assignmentTriggered !== expected.assignmentTriggered)
        )
          return false
        next.delete(id)
        await persist(next)
        return true
      }),
  }
}

async function readEntries(path: string, logger: Logger): Promise<Map<string, PendingReview>> {
  const entries = new Map<string, PendingReview>()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return entries
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn(`[github] pending review log corrupted: ${describeError(error)}; starting fresh`)
    return entries
  }
  const envelope = z.object({ version: z.literal(1), entries: z.array(z.unknown()) }).safeParse(parsed)
  if (!envelope.success) {
    logger.warn('[github] pending review log has an unsupported format; starting fresh')
    return entries
  }
  for (const value of envelope.data.entries) {
    const entry = pendingReviewSchema.safeParse(value)
    if (entry.success) entries.set(key(entry.data.repo, entry.data.prNumber), entry.data)
  }
  return entries
}
