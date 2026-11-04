import type { TunnelManager } from './manager'

// The container's running tunnel manager, for in-process runtime code that
// needs a tunnel's current public URL at call time (quick-tunnel URLs rotate
// on every restart, so a boot-time snapshot would go stale).
let active: Pick<TunnelManager, 'urlFor'> | undefined

export function setActiveTunnelManager(manager: Pick<TunnelManager, 'urlFor'> | undefined): void {
  active = manager
}

export function activeTunnelUrl(tunnelName: string): string | null {
  return active?.urlFor(tunnelName) ?? null
}
