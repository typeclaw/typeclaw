import { z } from 'zod'

// Event ids are UUIDv7. The 48-bit Unix-ms timestamp prefix gives two
// load-bearing properties:
//   1. Lexicographic order = chronological order. Sort ids as strings and
//      they come out in creation order — across files, within a file, and
//      after any future compaction that may reorder events on disk.
//   2. The timestamp in the `ts` field is structurally derivable from the
//      id, so `ts` is now a denormalized convenience for grep-ability rather
//      than independent state. Append paths derive `ts` from the id at write
//      time so the two never drift.
//
// Bun.randomUUIDv7() is the single id source for this subsystem. Node's
// `crypto.randomUUID()` (v4) is not used here.
export function newEventId(): string {
  return Bun.randomUUIDv7()
}

// Recover the wall-clock instant a UUIDv7 was minted at. The first 48 bits
// of the 128-bit id are big-endian milliseconds since the Unix epoch. We
// only need the first 12 hex chars (= 48 bits) — the 4-bit version nibble
// at position 12 and the 12-bit random tail that follow are not part of the
// timestamp. Returns ISO 8601 in UTC. Throws on shapes that lack a parseable
// timestamp prefix; callers should only pass ids produced by `newEventId`.
export function timestampFromId(id: string): string {
  const hex = id.replace(/-/g, '').slice(0, 12)
  if (hex.length !== 12) throw new Error(`timestampFromId: not a UUIDv7-shaped id: ${id}`)
  const ms = Number.parseInt(hex, 16)
  if (!Number.isFinite(ms)) throw new Error(`timestampFromId: unparseable timestamp prefix in: ${id}`)
  return new Date(ms).toISOString()
}

// Runtime-stamped (not LLM-supplied): the channel/room/platform is stable for a
// whole logger run, so unlike `who` it cannot be misattributed across speakers.
// All-optional so legacy fragments and non-channel (TUI) origins parse with it
// absent; names are best-effort (resolver may not have run). Never embedded.
export const fragmentProvenanceSchema = z
  .object({
    adapter: z.string(),
    workspace: z.string(),
    workspaceName: z.string().optional(),
    chat: z.string(),
    chatName: z.string().optional(),
    thread: z.string().nullable().optional(),
    parentChat: z.string().optional(),
    parentChatName: z.string().optional(),
  })
  .passthrough()

export const fragmentEventSchema = z
  .object({
    type: z.literal('fragment'),
    id: z.string().min(1),
    ts: z.string().datetime(),
    source: z.string(),
    entry: z.string(),
    topic: z.string(),
    body: z.string(),
    // Deliberate main-agent capture; absent on legacy/logger fragments.
    kind: z.literal('explicit').optional(),
    references: z.array(z.string()).optional(),
    // WHO the evidence is attributable to (display name/handle of the speaker).
    // LLM-supplied by the memory-logger, set ONLY when one transcript speaker
    // line clearly owns the evidence — a single logger run spans many speakers,
    // so this is per-fragment, never stamped from the spawn-time origin.
    who: z.string().min(1).optional(),
    // WHERE the evidence happened. Runtime-stamped from the session origin.
    where: fragmentProvenanceSchema.optional(),
  })
  .passthrough()

export const watermarkEventSchema = z
  .object({
    type: z.literal('watermark'),
    id: z.string().min(1),
    ts: z.string().datetime(),
    source: z.string(),
    entry: z.string(),
  })
  .passthrough()

export const legacyProseEventSchema = z
  .object({
    type: z.literal('legacy_prose'),
    ts: z.string().datetime(),
    text: z.string(),
    origin: z.literal('migration'),
  })
  .passthrough()

export const streamEventSchema = z.discriminatedUnion('type', [
  fragmentEventSchema,
  watermarkEventSchema,
  legacyProseEventSchema,
])

export type FragmentProvenance = z.infer<typeof fragmentProvenanceSchema>
export type FragmentEvent = z.infer<typeof fragmentEventSchema>
export type WatermarkEvent = z.infer<typeof watermarkEventSchema>
export type LegacyProseEvent = z.infer<typeof legacyProseEventSchema>
export type StreamEvent = FragmentEvent | WatermarkEvent | LegacyProseEvent

export function parseEventLine(line: string): StreamEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const result = streamEventSchema.safeParse(raw)
  if (!result.success) return null
  return result.data
}
