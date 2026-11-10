import { createHash } from 'node:crypto'

import { z } from 'zod'

const PREFIX = 'memory-page:'
const cursorSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  entry: z.string().min(1),
  digest: z.string(),
  offset: z.number().int().nonnegative(),
})

export function transcriptDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function encodeTranscriptCursor(path: string, entry: string, text: string, offset: number): string {
  const cursor = { version: 1, file: transcriptDigest(path), entry, digest: transcriptDigest(text), offset }
  return `${PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

export function decodeTranscriptCursor(value: string | null): z.infer<typeof cursorSchema> | null {
  if (!value?.startsWith(PREFIX)) return null
  return cursorSchema.parse(JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8')))
}

export function transcriptEntryId(value: string): string {
  return decodeTranscriptCursor(value)?.entry ?? value
}
