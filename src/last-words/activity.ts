import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import type { SessionOrigin } from '@/agent/session-origin'
import { channelKeyId } from '@/channels/types'

import type { LastWordsTurn } from './file'

type ActiveTurn = { getOrigin: () => SessionOrigin | undefined; startedAt: string; tools: Map<string, string> }

const activeTurns = new Map<symbol, ActiveTurn>()

export function trackTurnActivity(
  session: { subscribe: (listener: (event: AgentSessionEvent) => void) => () => void },
  getOrigin: () => SessionOrigin | undefined,
  now: () => Date = () => new Date(),
): () => void {
  const id = Symbol('turn')
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_start') {
      activeTurns.set(id, { getOrigin, startedAt: now().toISOString(), tools: new Map() })
    } else if (event.type === 'agent_end') {
      activeTurns.delete(id)
    } else if (event.type === 'tool_execution_start') {
      activeTurns.get(id)?.tools.set(event.toolCallId, event.toolName)
    } else if (event.type === 'tool_execution_end') {
      activeTurns.get(id)?.tools.delete(event.toolCallId)
    }
  })
  return () => {
    unsubscribe()
    activeTurns.delete(id)
  }
}

export function listActiveTurns(): LastWordsTurn[] {
  return [...activeTurns.values()].map((turn) => {
    const origin = turn.getOrigin()
    const tool = [...turn.tools.values()].at(-1)
    return { ...describeOrigin(origin), startedAt: turn.startedAt, ...(tool === undefined ? {} : { tool }) }
  })
}

function describeOrigin(origin: SessionOrigin | undefined): Pick<LastWordsTurn, 'origin' | 'key'> {
  switch (origin?.kind) {
    case undefined:
    case 'tui':
      return { origin: 'tui', key: 'tui' }
    case 'channel':
      return { origin: 'channel', key: channelKeyId(origin) }
    case 'cron':
      return { origin: 'cron', key: origin.jobId }
    case 'subagent':
      return { origin: 'subagent', key: origin.subagent }
    case 'system':
      return { origin: 'system', key: origin.component }
  }
}
