import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { defineTool } from '@/plugin'

import { fragmentContentHash } from './fragment-parser'
import { dailyStreamPath } from './memory-paths'
import { detectSecrets } from './secret-detector'
import { newEventId, timestampFromId } from './stream-events'
import type { FragmentEvent, WatermarkEvent } from './stream-events'
import { appendEvents, readEvents } from './stream-io'

export const appendTool = defineTool({
  description:
    "Append a memory fragment to today's JSONL daily stream and advance the watermark. The runtime serializes your call into a JSON line and chooses the filename — do not emit raw JSON and do not pass a path. `topic`/`body` are the fragment's substance; `source` is the parent session id; `entry` is the transcript-entry-id this fragment anchors to; `latestEntryId` is the latest transcript-entry-id you evaluated in this run (advances the watermark, may equal `entry` or be later). Refuses content with recognized credential patterns and refuses byte-equivalent topic+body within the same daily stream.",
  parameters: z.object({
    topic: z.string().min(1),
    body: z.string().min(1),
    source: z.string().min(1),
    entry: z.string().min(1),
    latestEntryId: z.string().min(1),
  }),
  async execute({ topic, body, source, entry, latestEntryId }, ctx) {
    const streamPath = dailyStreamPath(ctx.agentDir)
    assertNoSecrets(`${topic}\n${body}`)

    const hash = fragmentContentHash({ topic, body })
    const events = await readEvents(streamPath)
    const duplicate = events
      .filter((event) => event.type === 'fragment')
      .find((event) => fragmentContentHash(event) === hash)
    if (duplicate !== undefined) {
      throw new Error(
        `Refusing to append: fragment "${duplicate.topic}" already exists in ${streamPath} with byte-equivalent content. ` +
          `The dreaming subagent will see the existing fragment; do not write it again. If the new occurrence ` +
          `is genuinely informative, write a fragment that says so explicitly rather than restating the original.`,
      )
    }

    const fragmentId = newEventId()
    const watermarkId = newEventId()
    const fragment: FragmentEvent = {
      type: 'fragment',
      id: fragmentId,
      ts: timestampFromId(fragmentId),
      source,
      entry,
      topic,
      body,
    }
    const watermark: WatermarkEvent = {
      type: 'watermark',
      id: watermarkId,
      ts: timestampFromId(watermarkId),
      source,
      entry: latestEntryId,
    }

    await mkdir(dirname(streamPath), { recursive: true })
    await appendEvents(streamPath, [fragment, watermark])

    return {
      content: [{ type: 'text' as const, text: `Appended memory fragment and watermark to ${streamPath}` }],
      details: { path: streamPath, fragmentId: fragment.id, watermarkId: watermark.id },
    }
  },
})

export const advanceWatermarkTool = defineTool({
  description:
    'Advance the daily-stream watermark without writing a fragment. Use this when you evaluated transcript entries this run but decided none warranted a fragment — still call this once so the next run does not re-read the same prefix. The runtime writes the watermark line and chooses the filename.',
  parameters: z.object({
    source: z.string().min(1),
    latestEntryId: z.string().min(1),
  }),
  async execute({ source, latestEntryId }, ctx) {
    const streamPath = dailyStreamPath(ctx.agentDir)
    const watermarkId = newEventId()
    const watermark: WatermarkEvent = {
      type: 'watermark',
      id: watermarkId,
      ts: timestampFromId(watermarkId),
      source,
      entry: latestEntryId,
    }

    await mkdir(dirname(streamPath), { recursive: true })
    await appendEvents(streamPath, [watermark])

    return {
      content: [{ type: 'text' as const, text: `Advanced memory watermark in ${streamPath}` }],
      details: { path: streamPath, watermarkId: watermark.id },
    }
  },
})

function assertNoSecrets(content: string): void {
  const secrets = detectSecrets(content)
  if (secrets.length === 0) return

  const ruleNames = [...new Set(secrets.map((s) => s.rule))].join(', ')
  throw new Error(
    `Refusing to append: content contains a recognized credential pattern (${ruleNames}). ` +
      `Memory fragments must never quote secret values verbatim. Record the env var name and how it ` +
      `was discovered, not the value itself.`,
  )
}
