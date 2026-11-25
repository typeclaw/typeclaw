import type { SessionOrigin } from '@/agent/session-origin'

import type { WatchWakeTarget } from './types'

export function watchTarget(origin: SessionOrigin): WatchWakeTarget {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui', sessionId: origin.sessionId }
    case 'channel': {
      const { adapter, workspace, chat, thread, lastInboundAuthorId, lastInboundAuthorAdapter } = origin
      if (!lastInboundAuthorId) throw new Error('A channel watch needs an authenticated requester')
      return {
        kind: 'channel',
        key: { adapter, workspace, chat, thread },
        ...(origin.isDm !== undefined ? { isDm: origin.isDm } : {}),
        ...(origin.room ? { room: origin.room } : {}),
        requester: { authorId: lastInboundAuthorId, authorAdapter: lastInboundAuthorAdapter ?? adapter },
      }
    }
    case 'subagent':
      return origin.spawnedByOrigin ? watchTarget(origin.spawnedByOrigin) : { kind: 'fresh' }
    case 'cron':
      return origin.scheduledByOrigin && origin.scheduledByOrigin.kind !== 'config-file'
        ? watchTarget(origin.scheduledByOrigin)
        : { kind: 'fresh' }
    case 'system':
      return { kind: 'fresh' }
  }
}
export function conversationKey(t: WatchWakeTarget): string {
  if (t.kind === 'channel') return JSON.stringify([t.kind, t.key.adapter, t.key.workspace, t.key.chat, t.key.thread])
  return t.kind
}
