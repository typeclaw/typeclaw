import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BackgroundObligationStore } from './background-obligations'

export async function takeLostBackgroundContext(
  agentDir: string,
  obligations: BackgroundObligationStore,
  sessionId: string,
): Promise<string[]> {
  const lost = (await obligations.list()).filter(
    (row) =>
      row.parentSessionId === sessionId &&
      row.epoch !== obligations.epoch &&
      row.transfer?.cause !== 'live-turn-ended' &&
      (row.outcome === undefined ||
        (row.outcome.kind === 'intentionally-suppressed' &&
          (row.outcome.reason === 'operator-log-only' || row.outcome.reason === 'adapter-redelivered'))),
  )
  if (lost.length === 0) return []
  const directory = join(agentDir, 'channels', 'lost-background-context')
  await mkdir(directory, { recursive: true })
  const taskIds: string[] = []
  for (const row of lost) {
    try {
      // A separate at-most-once issuance receipt leaves continuity authority untouched.
      // Empty exclusive files also survive another process boot without schema migration.
      await writeFile(join(directory, row.obligationId), '', { flag: 'wx', mode: 0o600 })
      taskIds.push(row.taskId)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
  }
  if (taskIds.length === 0) return []
  return [
    [
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      `Background tasks terminated by a process restart: ${taskIds.join(', ')}.`,
      'Their results will never arrive. Redo their work if it is still needed.',
      'Do not acknowledge or reply to this notice.',
      '---',
    ].join('\n'),
  ]
}
