import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { StreamEvent } from './stream-events'
import { readEvents } from './stream-io'

// Daily stream files are named `YYYY-MM-DD.jsonl` (see `formatLocalDate` in
// `src/shared`). The cross-day lookup ignores any other file the user or a
// plugin may have dropped into `memory/`.
const DAILY_STREAM_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export async function readWatermarkFromFile(streamFilePath: string, parentSessionId: string): Promise<string | null> {
  const events = await readEvents(streamFilePath)

  const progress = findProgress(events, parentSessionId)
  return progress.checkpoint ?? progress.legacy
}

// Returns the latest watermark entry id for `parentSessionId` across all
// `YYYY-MM-DD.jsonl` daily-stream files under `memoryDir`, walking newest-first
// (by filename, which is equivalent to chronological order). Short-circuits
// on the first file that contains a matching marker — for the common case
// where memory-logger ran yesterday, this reads exactly one file.
//
// Why cross-day: channel sessions (Slack, Discord, KakaoTalk) routinely
// survive the midnight rollover because the same human keeps the same
// session alive across days. If `readWatermark` only looked at today's
// stream file, every midnight would force a full transcript reread for
// every long-lived session — burning ~135k input tokens per memory-logger
// run on a 762KB transcript (observed on a real Discord agent: PR #207).
//
// The append target stays today's file; only the lookup crosses the day
// boundary. This means yesterday's stream is treated as read-only history,
// which it already is by construction (dreaming snapshots full days, never
// touches in-progress days).
export async function readLatestWatermark(memoryDir: string, parentSessionId: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return null
  }
  const dailyStreams = entries
    .filter((name) => DAILY_STREAM_NAME.test(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  let legacy: string | null = null
  for (const name of dailyStreams) {
    const progress = findProgress(await readEvents(join(memoryDir, name)), parentSessionId)
    if (progress.checkpoint !== null) return progress.checkpoint
    legacy ??= progress.legacy
  }
  return legacy
}

function findProgress(events: StreamEvent[], source: string): { checkpoint: string | null; legacy: string | null } {
  let checkpoint: string | null = null
  let legacy: string | null = null
  for (const event of events) {
    if (event.type === 'watermark' && event.source === source) checkpoint = event.entry
    if (event.type === 'fragment' && event.source === source) legacy = event.entry
  }
  return { checkpoint, legacy }
}
