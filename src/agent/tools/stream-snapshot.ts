import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { formatLocalDateTime } from '@/shared'
import type { ScanFilter, Stream, StreamMessage, TargetFilter } from '@/stream'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_PAYLOAD_SUMMARY_CHARS = 200

const TARGET_KINDS = ['broadcast', 'session', 'new-session', 'cron'] as const
type TargetKind = (typeof TARGET_KINDS)[number]

export type CreateStreamSnapshotToolOptions = {
  stream: Stream
  // Clock source for the `since_ms_ago` cutoff. Defaults to the real clock;
  // injectable so tests can pin `now` and assert the time filter without
  // depending on wall-clock timing between publish and execute.
  now?: () => number
}

export function createStreamSnapshotTool({ stream, now = Date.now }: CreateStreamSnapshotToolOptions) {
  return defineTool({
    name: 'stream_snapshot',
    label: 'Stream Snapshot',
    description:
      'Snapshot recent activity on the in-process message stream that connects the WS server, cron scheduler, and any subagents. ' +
      'Useful for: confirming a cron job actually fired, seeing what user prompts arrived recently, observing broadcast notifications, ' +
      'or debugging why something did not happen. Read-only — this tool cannot publish messages. Returns the most recent N events ' +
      'matching the optional filter (target_kind, target_id, since_ms_ago).',
    parameters: Type.Object({
      target_kind: Type.Optional(
        Type.Union(
          TARGET_KINDS.map((k) => Type.Literal(k)),
          { description: 'Filter to a specific target kind. Omit to see all targets.' },
        ),
      ),
      target_id: Type.Optional(
        Type.String({
          description:
            'Pin to a specific session id (session), subagent name (new-session), or job id (cron). Ignored for broadcast.',
        }),
      ),
      since_ms_ago: Type.Optional(
        Type.Integer({
          description: 'Only return events from the last N milliseconds. Defaults to no time filter.',
          minimum: 1,
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: `Max number of events to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}). Most recent are kept.`,
          minimum: 1,
          maximum: MAX_LIMIT,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const limit = clampLimit(params.limit)
      const filter = buildFilter(params.target_kind, params.target_id, params.since_ms_ago, limit, now)
      const events = stream.scan(filter)
      return formatResult(events, params)
    },
  })
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT)
}

function buildFilter(
  kind: TargetKind | undefined,
  id: string | undefined,
  sinceMsAgo: number | undefined,
  limit: number,
  now: () => number,
): ScanFilter {
  const filter: ScanFilter = { limit }
  if (kind !== undefined) filter.target = buildTargetFilter(kind, id)
  if (sinceMsAgo !== undefined) filter.sinceTs = now() - sinceMsAgo
  return filter
}

function buildTargetFilter(kind: TargetKind, id: string | undefined): TargetFilter {
  switch (kind) {
    case 'broadcast':
      return { kind }
    case 'session':
      return id !== undefined ? { kind, sessionId: id } : { kind }
    case 'new-session':
      return id !== undefined ? { kind, subagent: id } : { kind }
    case 'cron':
      return id !== undefined ? { kind, jobId: id } : { kind }
  }
}

function formatResult(
  events: StreamMessage[],
  params: { target_kind?: TargetKind; target_id?: string; since_ms_ago?: number; limit?: number },
) {
  const filterDesc = describeFilter(params)
  const details = {
    count: events.length,
    filter: filterDesc,
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      target: e.target,
      payload: e.payload,
      ...(e.replyTo !== undefined ? { replyTo: e.replyTo } : {}),
      ...(e.meta !== undefined ? { meta: e.meta } : {}),
    })),
  }

  if (events.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No stream events matching ${filterDesc}.` }],
      details,
    }
  }

  const header = `${events.length} stream event(s) matching ${filterDesc} (oldest → newest):`
  const lines = [header, '']
  for (const event of events) {
    lines.push(formatEventLine(event))
  }
  return {
    content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
    details,
  }
}

function describeFilter(params: {
  target_kind?: TargetKind
  target_id?: string
  since_ms_ago?: number
  limit?: number
}): string {
  const parts: string[] = []
  if (params.target_kind !== undefined) {
    parts.push(
      params.target_id !== undefined
        ? `target=${params.target_kind}:${params.target_id}`
        : `target=${params.target_kind}`,
    )
  }
  if (params.since_ms_ago !== undefined) parts.push(`since=${params.since_ms_ago}ms`)
  if (params.limit !== undefined) parts.push(`limit=${params.limit}`)
  return parts.length === 0 ? 'all (default limit)' : parts.join(', ')
}

function formatEventLine(event: StreamMessage): string {
  const time = formatLocalDateTime(new Date(event.ts))
  const targetLabel = describeTarget(event.target)
  const payloadSummary = summarizePayload(event.payload)
  const replyMarker = event.replyTo !== undefined ? ` [reply→${event.replyTo}]` : ''
  return `${time}  ${targetLabel}${replyMarker}  ${payloadSummary}`
}

function describeTarget(target: StreamMessage['target']): string {
  switch (target.kind) {
    case 'broadcast':
      return 'broadcast'
    case 'session':
      return `session:${target.sessionId}`
    case 'new-session':
      return `new-session:${target.subagent}`
    case 'cron':
      return `cron:${target.jobId}`
  }
}

function summarizePayload(payload: unknown): string {
  let text: string
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    text = '<unserializable>'
  }
  if (text.length > MAX_PAYLOAD_SUMMARY_CHARS) {
    return `${text.slice(0, MAX_PAYLOAD_SUMMARY_CHARS)}… (${text.length} chars)`
  }
  return text
}
