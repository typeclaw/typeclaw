import { readFile } from 'node:fs/promises'

// The runtime hands memory-logger the transcript slice past the watermark in
// its first prompt, so a typical run is one model call instead of a
// find_entry/read/read/read chain. A JSONL line over `maxLineBytes` is cut
// rather than skipped: `read` refuses lines over its 50 KB limit outright,
// which made the subagent silently skip large entries (long cron prompts,
// big tool results) because it has no shell fallback.
export const PRELOAD_MAX_BYTES = 256 * 1024
export const PRELOAD_MAX_LINE_BYTES = 16 * 1024
const MIN_USEFUL_PRELOAD_BYTES = 8 * 1024
const TRUNCATION_MARKER_BYTES = 128
// Byte-level BPE tokenizers emit at most one token per UTF-8 byte, so byte
// length is a tokenizer-independent upper bound on token count. The overhead
// covers tool schemas and the preload header; each model's output allowance is
// reserved separately.
export const PRELOAD_OVERHEAD_TOKENS = 8192

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
  // First unread line when the byte cap stopped the preload early; null when
  // the preload reaches the end of the transcript.
  nextOffset: number | null
}

export async function buildTranscriptPreload(
  path: string,
  watermark: string | null,
  options: { maxBytes?: number; maxLineBytes?: number } = {},
): Promise<TranscriptPreload | null> {
  const maxBytes = options.maxBytes ?? PRELOAD_MAX_BYTES
  const maxLineBytes = Math.min(options.maxLineBytes ?? PRELOAD_MAX_LINE_BYTES, maxBytes - TRUNCATION_MARKER_BYTES)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const lines = raw.length === 0 ? [] : raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = lines.length

  let startIndex = 0
  let watermarkFound = false
  if (watermark !== null) {
    const needle = `"id":"${watermark}"`
    const found = lines.findIndex((line) => line.includes(needle))
    if (found !== -1) {
      startIndex = found + 1
      watermarkFound = true
    }
  }

  const out: string[] = []
  let bytes = 0
  let truncatedLines = 0
  let index = startIndex
  for (; index < totalLines; index++) {
    let line = lines[index] ?? ''
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > maxLineBytes) {
      line = `${Buffer.from(line, 'utf8').subarray(0, maxLineBytes).toString('utf8')} …[line ${index + 1} truncated: ${Math.round(lineBytes / 1024)}KB total, first ${Math.round(maxLineBytes / 1024)}KB shown]`
      truncatedLines++
    }
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (out.length > 0 && bytes + cost > maxBytes) break
    out.push(line)
    bytes += cost
  }

  return {
    text: out.join('\n'),
    startLine: startIndex + 1,
    endLine: index,
    totalLines,
    truncatedLines,
    watermarkFound,
    nextOffset: index < totalLines ? index + 1 : null,
  }
}
