import { readFile } from 'node:fs/promises'

import { decodeTranscriptCursor, encodeTranscriptCursor, transcriptDigest } from './transcript-cursor'
import { projectTranscriptLine } from './transcript-view'

// Pack complete projected records where possible. Large records are paged
// reversibly; the checkpoint includes the next character offset and digest,
// so an interrupted or changed entry is replayed rather than skipped.
export const PRELOAD_MAX_BYTES = 256 * 1024
const MIN_USEFUL_PRELOAD_BYTES = 8 * 1024
// Byte-level BPE tokenizers emit at most one token per UTF-8 byte, so byte
// length is a tokenizer-independent upper bound on token count. The overhead
// covers tool schemas and the preload header; each model's output allowance is
// reserved separately.
export const PRELOAD_OVERHEAD_TOKENS = 8192
// The header lines and <transcript> tags rendered around the slice. They sit in
// the same user message as the slice, so the slice budget must leave room for
// them; otherwise a line-granular slice that lands just under its budget
// overflows the tightest window by the frame's size.
export const PRELOAD_FRAME_BYTES = 512

export type PreloadModelLimits = { contextWindow: number; outputTokens: number }

// The preload is one unprocessed user message, so it must fit the smallest
// model the subagent can fall back to: compaction cannot shrink it and
// context-overflow errors do not fail over. Returns null when no useful slice
// fits, so the caller keeps the incremental read loop.
export function preloadBudgetBytes(models: readonly PreloadModelLimits[], promptBytes: number): number | null {
  if (models.length === 0) return null
  const tightest = Math.min(...models.map((m) => m.contextWindow - m.outputTokens))
  const budget = Math.min(PRELOAD_MAX_BYTES, tightest - promptBytes - PRELOAD_OVERHEAD_TOKENS)
  return budget >= MIN_USEFUL_PRELOAD_BYTES ? budget : null
}

export type TranscriptPreload = {
  text: string
  startLine: number
  endLine: number
  totalLines: number
  truncatedLines: number
  watermarkFound: boolean
  checkpoint: string | null
  startCheckpoint: string | null
  entryIds: string[]
  // First unread line when the byte cap stopped the preload early; null when
  // the preload reaches the end of the transcript.
  nextOffset: number | null
}

export async function buildTranscriptPreload(
  path: string,
  watermark: string | null,
  options: { maxBytes?: number; untilLine?: number } = {},
): Promise<TranscriptPreload | null> {
  const maxBytes = options.maxBytes ?? PRELOAD_MAX_BYTES
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const lines = raw.length === 0 ? [] : raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = Math.min(lines.length, options.untilLine ?? lines.length)

  let startIndex = 0
  let startOffset = 0
  let watermarkFound = false
  const cursor = decodeTranscriptCursor(watermark)
  if (watermark !== null) {
    const entryId = cursor?.entry ?? watermark
    const found = lines.findIndex((line) => recordId(line) === entryId)
    if (found !== -1) {
      startIndex = cursor === null ? found + 1 : found
      watermarkFound = true
      if (cursor !== null) {
        const text = projectTranscriptLine(lines[found] ?? '')
        if (
          cursor.file === transcriptDigest(path) &&
          cursor.digest === transcriptDigest(text) &&
          cursor.offset <= text.length &&
          !isInsideSurrogatePair(text, cursor.offset)
        ) {
          startOffset = cursor.offset
        }
      }
    }
  }

  const out: string[] = []
  const entryIds: string[] = []
  let bytes = 0
  let checkpoint = watermark
  const firstId = recordId(lines[startIndex] ?? '')
  const startCheckpoint =
    firstId === null
      ? null
      : encodeTranscriptCursor(path, firstId, projectTranscriptLine(lines[startIndex] ?? ''), startOffset)
  let partial = false
  let index = startIndex
  for (; index < totalLines; index++) {
    const source = lines[index] ?? ''
    const id = recordId(source)
    // A live writer's incomplete tail is never acknowledged.
    if (id === null) break
    const text = projectTranscriptLine(source)
    const offset = index === startIndex ? startOffset : 0
    const separatorBytes = out.length === 0 ? 0 : 1
    if (offset === 0 && bytes + separatorBytes + Buffer.byteLength(text, 'utf8') <= maxBytes) {
      out.push(text)
      entryIds.push(id)
      bytes += separatorBytes + Buffer.byteLength(text, 'utf8')
      checkpoint = id
      continue
    }
    if (out.length > 0) break

    const context = entryContext(text)
    let low = offset
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const part = JSON.stringify({ type: 'entry-part', id, context, offset, text: text.slice(offset, middle) })
      if (Buffer.byteLength(part, 'utf8') <= maxBytes) low = middle
      else high = middle - 1
    }
    const end = isInsideSurrogatePair(text, low) ? low - 1 : low
    if (end <= offset) throw new Error('Memory transcript page budget cannot hold the next character.')
    out.push(JSON.stringify({ type: 'entry-part', id, context, offset, text: text.slice(offset, end) }))
    entryIds.push(id)
    checkpoint = end === text.length ? id : encodeTranscriptCursor(path, id, text, end)
    partial = end < text.length
    if (end === text.length) index++
    break
  }

  return {
    text: out.join('\n'),
    startLine: startIndex + 1,
    endLine: index + (partial ? 1 : 0),
    totalLines,
    truncatedLines: 0,
    watermarkFound,
    checkpoint,
    startCheckpoint,
    entryIds,
    nextOffset: index < totalLines ? index + 1 : null,
  }
}

function entryContext(text: string): Record<string, unknown> {
  const entry: unknown = JSON.parse(text)
  if (!isRecord(entry)) return {}
  const context: Record<string, unknown> = {}
  for (const key of ['parentId', 'timestamp']) {
    if (key in entry) context[key] = entry[key]
  }
  if (isRecord(entry.message)) {
    for (const key of [
      'role',
      'timestamp',
      'toolCallId',
      'toolName',
      'isError',
      'stopReason',
      'authorId',
      'authorName',
      'who',
      'where',
    ]) {
      if (key in entry.message) context[`message.${key}`] = entry.message[key]
    }
  }
  return context
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordId(line: string): string | null {
  try {
    const entry: unknown = JSON.parse(line)
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) return null
    return typeof entry.id === 'string' ? entry.id : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function isInsideSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}
