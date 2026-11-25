import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { createAndOpenAnchoredDirectory } from '@/agent/tool-file-safety'
import { ADAPTER_IDS } from '@/channels/schema'
import { credentialStagingDir } from '@/init/staged-write'

import type { WatchWakeTarget } from './types'

const adapter = z.enum(ADAPTER_IDS)
const channel = z.object({ adapter, workspace: z.string(), chat: z.string(), thread: z.string().nullable() })
const roomContext = {
  isDm: z.boolean().optional(),
  room: z
    .object({ kind: z.literal('thread'), parentChat: z.string().optional(), parentChatName: z.string().optional() })
    .optional(),
}
const tui = z.object({ kind: z.literal('tui'), sessionId: z.string().min(1) })
const origin: z.ZodType<SessionOrigin> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    tui,
    channel.extend({
      kind: z.literal('channel'),
      ...roomContext,
      parentChat: z.string().optional(),
      lastInboundAuthorId: z.string().optional(),
      lastInboundAuthorAdapter: adapter.optional(),
    }),
    z.object({
      kind: z.literal('subagent'),
      subagent: z.string(),
      parentSessionId: z.string(),
      spawnedByRole: z.string().optional(),
      spawnedByOrigin: origin.optional(),
    }),
    z.object({
      kind: z.literal('cron'),
      jobId: z.string(),
      jobKind: z.enum(['exec', 'prompt', 'subagent', 'handler', 'watch']),
      scheduledByRole: z.string().optional(),
      scheduledByOrigin: z.union([origin, z.object({ kind: z.literal('config-file') })]).optional(),
    }),
    z.object({ kind: z.literal('system'), component: z.string(), triggeredBy: origin.optional() }),
  ]),
)
const target: z.ZodType<WatchWakeTarget> = z.discriminatedUnion('kind', [
  tui,
  z.object({ kind: z.literal('fresh') }),
  z.object({
    kind: z.literal('channel'),
    key: channel,
    ...roomContext,
    requester: z.object({ authorId: z.string().min(1), authorAdapter: adapter, authorName: z.string().optional() }),
  }),
])
export const probeSchema = z.union([
  z.strictObject({ command: z.string().min(1), cwd: z.string().min(1).optional() }),
  z.strictObject({ bundled: z.string().min(1), target: z.json() }),
])
export const recordSchema = z.object({
  id: z.uuid(),
  description: z.string().min(1).max(1024),
  waitsFor: z.string().min(1).optional(),
  probe: probeSchema,
  mode: z.enum(['judge', 'diff']),
  createdAt: z.number(),
  deadline: z.number(),
  createdByRole: z.string(),
  createdByOrigin: origin,
  wakeTarget: target,
  nextRunAt: z.number(),
  lastRunAt: z.number().optional(),
  lastSummaryFingerprint: z.string().optional(),
  consecutiveWakes: z.int().nonnegative(),
  consecutiveFailures: z.int().nonnegative(),
  status: z.enum(['active', 'paused', 'done', 'expired', 'cancelled']),
  state: z.json().optional(),
  pending: z.array(
    z.object({ key: z.uuid(), summary: z.string(), final: z.boolean(), sequence: z.int().positive().optional() }),
  ),
})
export type WatchRecord = z.infer<typeof recordSchema>

export function watchOrigin(w: WatchRecord): Extract<SessionOrigin, { kind: 'cron' }> {
  return {
    kind: 'cron',
    jobId: `watch:${w.id}`,
    jobKind: 'watch',
    scheduledByRole: w.createdByRole,
    scheduledByOrigin: w.createdByOrigin,
  }
}

// The Linux runtime walks every component no-follow. Dev-stage fixtures on
// other systems have no /proc/fd and do not run model-controlled processes.
export async function withWatchDirectory<T>(path: string, create: boolean, fn: (p: string) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 })
    return fn(path)
  }
  const dir = await createAndOpenAnchoredDirectory(path, create)
  try {
    return await fn(`/proc/self/fd/${dir.fd}`)
  } finally {
    await dir.close()
  }
}

export class WatchStore {
  private rows: WatchRecord[] = []
  private tail = Promise.resolve()
  constructor(private readonly agentDir: string) {}
  get records(): readonly WatchRecord[] {
    return this.rows
  }
  isVerdictPending(watchId: string, runId: string): boolean {
    return this.rows.find((w) => w.id === watchId)?.pending.some((p) => p.key === runId) ?? false
  }
  async acknowledgeWakes(keys: ReadonlySet<string>): Promise<boolean> {
    if (!this.rows.some((watch) => watch.pending.some((wake) => keys.has(wake.key)))) return false
    let releasedLink = false
    await this.update((rows) => {
      for (const watch of rows) {
        if (watch.waitsFor !== undefined && watch.pending.some((wake) => keys.has(wake.key))) {
          delete watch.waitsFor
          releasedLink = true
        }
        watch.pending = watch.pending.filter((wake) => !keys.has(wake.key))
      }
    })
    return releasedLink
  }
  async restore() {
    const file = join(this.agentDir, '.typeclaw', 'watches.json')
    try {
      const text = await withWatchDirectory(dirname(file), false, async (parent) => {
        const fd = await open(join(parent, 'watches.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          return await fd.readFile('utf8')
        } finally {
          await fd.close()
        }
      })
      // Sandbox initialization may already have materialized an empty mask target.
      this.rows = text === '' ? [] : z.array(recordSchema).parse(JSON.parse(text))
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
    }
  }
  update(fn: (rows: WatchRecord[]) => void, signal?: AbortSignal) {
    const task = this.tail.then(async () => {
      if (signal?.aborted) return
      const rows = structuredClone(this.rows)
      fn(rows)
      const text = JSON.stringify(rows)
      // Stage inside an existing canonical directory mask: a temporary
      // sibling of the file would be readable (and replaceable) by model bash.
      await withWatchDirectory(join(this.agentDir, '.typeclaw'), true, (parent) =>
        withWatchDirectory(credentialStagingDir(this.agentDir), true, async (staging) => {
          const tmp = join(staging, `${crypto.randomUUID()}.tmp`)
          try {
            await writeFile(tmp, text, { flag: 'wx', mode: 0o600 })
            if (signal?.aborted) return
            await rename(tmp, join(parent, 'watches.json'))
            this.rows = rows
          } finally {
            await rm(tmp, { force: true })
          }
        }),
      )
    })
    this.tail = task.catch(() => {})
    return task
  }
}
