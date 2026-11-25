import { defineTool } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

import { zodToToolParameters } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'

import { detectCreatedGithubTargets } from './detect-created'
import { githubParams } from './probes/github'
import { getWatchRuntime } from './runtime'
import { probeSchema } from './store'
import { conversationKey, watchTarget } from './target'
import { duration } from './verdict'

const createRequest = z.strictObject({
  action: z.literal('create'),
  description: z.string().min(1).max(1024),
  probe: probeSchema,
  mode: z.enum(['judge', 'diff']).optional(),
  deadline: z.string().optional(),
})
const id = z.uuid()
const request = z.discriminatedUnion('action', [
  createRequest,
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.enum(['rearm', 'cancel']), id }),
])
// Providers validate tool declarations before choosing a tool. Advertise an
// object at the root; the action-specific requirements still apply at execution.
const parameters = createRequest
  .partial()
  .extend({ action: z.enum(['create', 'list', 'rearm', 'cancel']), id: id.optional() })

export async function registerWatchesFromBash(
  dir: string,
  origin: SessionOrigin,
  permissions: PermissionService,
  command: string,
  output: string,
): Promise<string[]> {
  const runtime = getWatchRuntime(dir)
  if (!runtime?.isAutoEnabled?.() || !permissions.has(origin, CORE_PERMISSIONS.watchCreate)) return []
  const targets = detectCreatedGithubTargets(command, output)
  if (targets.length === 0) return []
  const wakeTarget = watchTarget(origin)
  const createdByRole = permissions.resolveRole(origin)
  const notices: string[] = []
  for (const { kind, repo, number } of targets) {
    const label = `${kind === 'github-pr' ? 'PR' : 'issue'} ${repo}#${number}`
    try {
      const target = { repo, number }
      runtime.registry.get(kind).parseParams(target)
      const credential = await runtime.resolveGithubCredential?.(origin, repo)
      if (credential?.kind !== 'token') {
        const reason = credential?.reason ?? 'No GitHub polling credential resolver is available.'
        notices.push(`Follow-up watch not scheduled for ${label}: ${reason.replace(/\s+/g, ' ').trim()}`)
        continue
      }
      const id = await runtime.service.create(
        {
          description: `Follow up on ${label}`,
          probe: { bundled: kind, target },
          mode: 'judge',
          createdByRole,
          createdByOrigin: origin,
          wakeTarget,
        },
        ({ probe }) => {
          if (!('bundled' in probe) || probe.bundled !== kind) return false
          const existing = githubParams.safeParse(probe.target)
          return existing.success && existing.data.repo === repo && existing.data.number === number
        },
      )
      if (id !== undefined) notices.push(`Follow-up watch registered for ${label}: ${id}`)
    } catch (error) {
      console.warn(`[watch] auto-registration failed for ${label}:`, error)
      notices.push(`Follow-up watch not scheduled for ${label}: credential or watch setup failed.`)
    }
  }
  return notices
}
export function createWatchTool(
  dir: string,
  getOrigin: () => SessionOrigin | undefined,
  permissions: PermissionService,
) {
  return defineTool({
    name: 'watch',
    label: 'Watch',
    description:
      'Create a follow-up probe; list, cancel or rearm a paused watch. Probes are at-least-once: side effects must be idempotent. Use judge mode for multi-step statuses, not diff (wakes on changed stdout). Exit 0 quiet, 10 wake, 20 finish silently, 30 finish and wake. Or end stdout with JSON {verdict:"quiet"|"wake"|"done",wake?,summary?,next?}; done is silent unless wake is true. next and deadline are durations like 5m or 2d. Other exits fail. A channel wake returns to the original conversation as a system reminder.',
    parameters: zodToToolParameters(parameters),
    async execute(_id, args) {
      const input = request.parse(args)
      const origin = getOrigin(),
        runtime = getWatchRuntime(dir)
      if (!runtime || !origin) throw new Error('No watch runtime or requester for this session')
      const { service, registry } = runtime
      const role = permissions.resolveRole(origin)
      if (
        (input.action === 'create' || input.action === 'rearm') &&
        !permissions.has(origin, CORE_PERMISSIONS.watchCreate)
      )
        throw new Error('Denied by watch.create; ask the operator to grant this permission.')
      const target = watchTarget(origin)
      const scoped = service.store.records.filter(
        (w) =>
          role === 'owner' ||
          (target.kind === 'fresh'
            ? origin.kind === 'cron' &&
              (origin.jobId === `watch:${w.id}` ||
                (w.createdByOrigin.kind === 'cron' && w.createdByOrigin.jobId === origin.jobId))
            : conversationKey(w.wakeTarget) === conversationKey(target)),
      )
      let details: unknown
      if (input.action === 'create') {
        if ('bundled' in input.probe) {
          if (input.mode === 'diff') throw new Error('Bundled probes return verdicts; use judge mode.')
          registry.get(input.probe.bundled).parseParams(input.probe.target)
        }
        details = {
          id: await service.create({
            ...input,
            mode: input.mode ?? 'judge',
            deadlineMs: input.deadline === undefined ? undefined : duration(input.deadline),
            createdByRole: role,
            createdByOrigin: origin,
            wakeTarget: target,
          }),
        }
      } else if (input.action === 'list') {
        details = scoped.map(({ id, description, status, nextRunAt, deadline }) => ({
          id,
          description,
          status,
          nextRunAt,
          deadline,
        }))
      } else {
        const row = scoped.find((w) => w.id === input.id)
        if (!row) throw new Error('No such watch in this conversation')
        if (input.action === 'rearm' && role !== 'owner' && row.createdByRole !== role)
          throw new Error('Cannot rearm as another role')
        await service.change(input.id, input.action)
        details = { id: input.id, status: input.action === 'cancel' ? 'cancelled' : 'active' }
      }
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
    },
  })
}
