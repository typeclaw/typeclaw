import type { SessionOrigin } from '@/agent/session-origin'

import type { ResolveWatchGithubCredential } from './github-credential'
import type { ProbeRegistry } from './runner'
import type { WatchService } from './service'
import type { WatchRecord } from './store'

export type WatchRuntime = {
  service: WatchService
  registry: ProbeRegistry
  isAutoEnabled?: () => boolean
  resolveGithubCredential?: ResolveWatchGithubCredential
}

// Type-only imports keep this registry loadable from the todo continuation
// path without pulling the tool and runner modules into it.
const runtimes = new Map<string, WatchRuntime>()

export function registerWatchRuntime(dir: string, runtime: WatchRuntime) {
  runtimes.set(dir, runtime)
  return () => {
    if (runtimes.get(dir) === runtime) runtimes.delete(dir)
  }
}

export function getWatchRuntime(dir: string): WatchRuntime | undefined {
  return runtimes.get(dir)
}

// Only a watch created this turn can stand in for its continuation. A paused
// watch wakes nothing until it is rearmed.
export function hasActiveWatchFor(dir: string, origin: SessionOrigin, createdSince: number): boolean {
  const records = runtimes.get(dir)?.service.store.records ?? []
  return records.some((w) => w.status === 'active' && w.createdAt >= createdSince && wakesConversation(w, origin))
}

function wakesConversation(w: WatchRecord, origin: SessionOrigin): boolean {
  const target = w.wakeTarget
  switch (origin.kind) {
    case 'channel':
      return (
        target.kind === 'channel' &&
        target.key.adapter === origin.adapter &&
        target.key.workspace === origin.workspace &&
        target.key.chat === origin.chat &&
        target.key.thread === origin.thread
      )
    // TUI todos are one agent-wide scope (see resolveTodoScope), so any TUI
    // watch is a wake source for it.
    case 'tui':
      return target.kind === 'tui'
    case 'cron':
    case 'subagent':
    case 'system':
      return false
  }
}
