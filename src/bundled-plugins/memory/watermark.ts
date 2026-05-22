import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readEvents } from './stream-io'

// Daily stream files are named `YYYY-MM-DD.jsonl` (see `formatLocalDate` in
// `src/shared`). The cross-day lookup ignores any other file the user or a
// plugin may have dropped into `memory/`.
const DAILY_STREAM_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export async function readWatermarkFromFile(streamFilePath: string, parentSessionId: string): Promise<string | null> {
  const events = await readEvents(streamFilePath)

  let lastEntryId: string | null = null
  for (const event of events) {
    if ((event.type === 'fragment' || event.type === 'watermark') && event.source === parentSessionId) {
      lastEntryId = event.entry
    }
  }
  return lastEntryId
}

// Returns the latest watermark entry id for `parentSessionId` across all
// `YYYY-MM-DD.jsonl` daily-stream files under `streamsDir`, walking newest-first
// (by filename, which is equivalent to chronological order). Short-circuits
// on the first file that contains a matching marker.
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
export async function readLatestWatermark(streamsDir: string, parentSessionId: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(streamsDir)
  } catch {
    return null
  }
  const dailyStreams = entries
    .filter((name) => DAILY_STREAM_NAME.test(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of dailyStreams) {
    const watermark = await readWatermarkFromFile(join(streamsDir, name), parentSessionId)
    if (watermark !== null) return watermark
  }
  return null
}
