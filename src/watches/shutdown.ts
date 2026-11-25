import type { WakeDispatcher } from './delivery'
import { systemClock, type WatchService } from './service'

// One budget for the entire subsystem, not a fresh timeout per worker. Leave
// the rest of the runtime's 8s grace for channels and durable journals.
const WATCH_SHUTDOWN_GRACE_MS = 2000

export async function stopWatchWorkers(service: WatchService, dispatcher: WakeDispatcher, clock = systemClock) {
  const deadline = Promise.withResolvers<void>()
  const cancelDeadline = clock.after(WATCH_SHUTDOWN_GRACE_MS, async () => {
    console.warn('[watch] shutdown grace elapsed; interrupted probes and unacknowledged reminders remain pending')
    deadline.resolve()
  })
  try {
    await Promise.race([Promise.all([service.stop(), dispatcher.stop()]), deadline.promise])
  } finally {
    cancelDeadline()
  }
}
