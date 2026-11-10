import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { defineTool } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { fragmentContentHash } from './fragment-parser'
import { streamFilePath } from './paths'
import { sanitizeProvenanceName } from './provenance-sanitize'
import { detectSecrets } from './secret-detector'
import { newEventId, timestampFromId } from './stream-events'
import type { FragmentEvent, FragmentProvenance, WatermarkEvent } from './stream-events'
import { appendEvents, readEvents, type FragmentsAppendedContext } from './stream-io'
import { transcriptEntryId } from './transcript-cursor'

export type FragmentsAppendedHook = (fragments: FragmentEvent[], context: FragmentsAppendedContext) => Promise<void>

// Lets the memory-logger thread its spawn-time `payload.origin` into the append
// tool so `where` is stamped server-side. A provider closure (not a static
// value) because the same factory builds tools whose origin is only known later.
export type OriginProvider = () => SessionOrigin | undefined

// Returns the set of reference slugs the agent is allowed to cite from
// `references[]`: every reference that exists on disk (a `store_reference` call
// writes the file synchronously before returning the slug, so a same-run store
// is already on disk by append time). Lets the append tool strip hallucinated
// slugs the model invents without ever calling `store_reference`.
export type ReferenceSlugResolver = (agentDir: string) => Promise<Iterable<string>>
export type TranscriptPathProvider = () => string | undefined

export type CreateAppendToolOptions = {
  onFragmentsAppended?: FragmentsAppendedHook
  originProvider?: OriginProvider
  referenceSlugResolver?: ReferenceSlugResolver
  transcriptPathProvider?: TranscriptPathProvider
  validateCheckpoint?: (source: string, checkpoint: string, entry?: string) => void
  deferWatermark?: () => boolean
  beginWrite?: () => (() => void) | undefined
}

// Stamped fields are the stable channel coordinates only. Author identity is
// deliberately excluded: a channel session sees many speakers and the origin's
// `lastInboundAuthorId` is just the spawn-time one, so attributing it to every
// fragment would misattribute fragments about earlier speakers. `who` is the
// LLM's job, per fragment, from the transcript speaker line.
export function provenanceFromOrigin(origin: SessionOrigin | undefined): FragmentProvenance | undefined {
  if (origin === undefined || origin.kind !== 'channel') return undefined
  const where: FragmentProvenance = {
    adapter: origin.adapter,
    workspace: origin.workspace,
    chat: origin.chat,
    thread: origin.thread,
  }
  // workspaceName/chatName are external channel data force-committed to memory.
  // The agent cannot rewrite them (they come from the origin, not a tool arg),
  // so a credential-shaped name is dropped rather than thrown — keep the raw id,
  // never let the leaky display string reach git. Raw ids are platform-issued
  // identifiers, not free text, so they are not scanned.
  const workspaceName = sanitizeProvenanceName(origin.workspaceName)
  const chatName = sanitizeProvenanceName(origin.chatName)
  const parentChatName = sanitizeProvenanceName(origin.parentChatName)
  if (workspaceName !== undefined) where.workspaceName = workspaceName
  if (chatName !== undefined) where.chatName = chatName
  if (origin.parentChat !== undefined) where.parentChat = origin.parentChat
  if (parentChatName !== undefined) where.parentChatName = parentChatName
  return where
}

export function createAppendTool(options: CreateAppendToolOptions = {}) {
  const { onFragmentsAppended, originProvider, referenceSlugResolver, transcriptPathProvider } = options
  return defineTool({
    description:
      "Append a memory fragment to today's JSONL daily stream and advance the watermark. The runtime serializes your call into a JSON line and chooses the filename — do not emit raw JSON and do not pass a path. `topic`/`body` are the fragment's substance; `source` is the parent session id; `entry` is the transcript-entry-id this fragment anchors to; `latestEntryId` is the latest transcript-entry-id you evaluated in this run (advances the watermark, may equal `entry` or be later). `references` may ONLY contain slugs returned by `store_reference` (it returns the slug it wrote) — never topic ids, PR names, stream paths, or invented labels; unknown slugs are dropped. `who` is the display name/handle of the person the fragment's evidence is attributable to — set it ONLY when one transcript speaker clearly owns the evidence; omit it when the fact is the user's own, spans multiple speakers, or is not attributable. The channel/room/platform (`where`) is stamped automatically from the session origin — do not pass it and do not restate it in the body. Refuses content with recognized credential patterns and refuses byte-equivalent topic+body within the same daily stream.",
    parameters: z.object({
      topic: z.string().min(1),
      body: z.string().min(1),
      source: z.string().min(1),
      entry: z.string().min(1),
      latestEntryId: z.string().min(1),
      references: z.array(z.string()).optional(),
      who: z.string().min(1).optional(),
    }),
    // None of these is a local path — topic/body are prose, the rest are session/
    // entry/reference ids. The runtime chooses the stream filename; the tool never
    // opens a caller path. Declared so a body carrying "/" or a slug/id that
    // collides with an agent-root dir name is not misread as a file operand.
    fileOperands: {
      nonFile: ['topic', 'body', 'source', 'entry', 'latestEntryId', 'references', 'who'],
    },
    async execute({ topic, body, source, entry, latestEntryId, references, who }, ctx) {
      options.validateCheckpoint?.(source, latestEntryId, entry)
      const finishWrite = options.beginWrite?.()
      try {
        const streamPath = dailyStreamPath(ctx.agentDir)
        const where = provenanceFromOrigin(originProvider?.())
        const transcriptPath = transcriptPathProvider?.()
        if (
          transcriptPath !== undefined &&
          (await anchorBelongsToOperationalIncident(transcriptPath, entry, latestEntryId))
        ) {
          throw new Error(
            'Refusing to append: the transcript anchor belongs to a deterministic operational incident sequence. ' +
              'Operational defects are owned by the incident ledger, not semantic memory.',
          )
        }
        // `who` is LLM-supplied and force-committed to memory, so it clears the
        // same secret guard as topic/body — a token-shaped display name is refused
        // with the same retryable error. (`where` names are origin-derived and the
        // agent can't rewrite them, so they are self-redacted in provenanceFromOrigin
        // instead of throwing here.)
        assertNoSecrets([topic, body, who])

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
        const validReferences = await resolveValidReferences(references, referenceSlugResolver, ctx)
        if (validReferences.length > 0) {
          fragment.references = validReferences
        }
        const safeWho = sanitizeProvenanceName(who)
        if (safeWho !== undefined) fragment.who = safeWho
        if (where !== undefined) fragment.where = where
        const watermark: WatermarkEvent = {
          type: 'watermark',
          id: watermarkId,
          ts: timestampFromId(watermarkId),
          source,
          entry: latestEntryId,
        }

        await mkdir(dirname(streamPath), { recursive: true })
        const deferred = options.deferWatermark?.() ?? false
        await appendEvents(
          streamPath,
          deferred ? [fragment] : [fragment, watermark],
          onFragmentsAppended,
          onFragmentsAppended
            ? (err) => {
                ctx.logger?.warn(
                  `[memory] post-append vector hook failed: ${err instanceof Error ? err.message : String(err)}`,
                )
              }
            : undefined,
        )

        return {
          content: [
            {
              type: 'text' as const,
              text: `Appended memory fragment${deferred ? '; complete the page after all fragments' : ' and watermark'} to ${streamPath}`,
            },
          ],
          details: { path: streamPath, fragmentId: fragment.id, ...(deferred ? {} : { watermarkId: watermark.id }) },
        }
      } finally {
        finishWrite?.()
      }
    },
  })
}

const OPERATIONAL_INCIDENT_MARKER = 'TYPECLAW_OPERATIONAL_INCIDENT '

export async function anchorBelongsToOperationalIncident(
  transcriptPath: string,
  entryId: string,
  latestEntryId = entryId,
): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch {
    return false
  }
  const entries = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line): unknown[] => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
  const anchorIndex = entries.findIndex((entry) => entryIdOf(entry) === entryId)
  const latestIndex = entries.findIndex((entry) => entryIdOf(entry) === transcriptEntryId(latestEntryId))
  if (anchorIndex < 0 || latestIndex < anchorIndex) return false

  for (let i = anchorIndex; i <= latestIndex; i++) {
    if (entryBelongsToOperationalIncident(entries, i)) return true
  }
  return false
}

function entryBelongsToOperationalIncident(entries: unknown[], entryIndex: number): boolean {
  if (containsIncidentMarker(entries[entryIndex])) return true
  for (let i = entryIndex - 1; i >= 0; i--) {
    const entry = entries[i]
    if (containsIncidentMarker(entry)) return true
    if (messageRole(entry) === 'user') return false
  }
  return false
}

function entryIdOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const id = (entry as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

function messageRole(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const message = (entry as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const role = (message as { role?: unknown }).role
  return typeof role === 'string' ? role : undefined
}

function containsIncidentMarker(entry: unknown): boolean {
  return JSON.stringify(entry).includes(OPERATIONAL_INCIDENT_MARKER)
}

export const appendTool = createAppendTool()

export function createAdvanceWatermarkTool(
  options: {
    validateCheckpoint?: (source: string, checkpoint: string) => void
    onAdvanced?: () => void
  } = {},
) {
  return defineTool({
    description:
      'Advance the daily-stream watermark without writing a fragment. Use this when you evaluated transcript entries this run but decided none warranted a fragment — still call this once so the next run does not re-read the same prefix. The runtime writes the watermark line and chooses the filename.',
    parameters: z.object({
      source: z.string().min(1),
      latestEntryId: z.string().min(1),
    }),
    async execute({ source, latestEntryId }, ctx) {
      options.validateCheckpoint?.(source, latestEntryId)
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
      options.onAdvanced?.()

      return {
        content: [{ type: 'text' as const, text: `Advanced memory watermark in ${streamPath}` }],
        details: { path: streamPath, watermarkId: watermark.id },
      }
    },
  })
}

export const advanceWatermarkTool = createAdvanceWatermarkTool()

function dailyStreamPath(agentDir: string): string {
  return streamFilePath(agentDir, formatLocalDate())
}

// The model treats `references[]` as a free-text related-id field, citing empty
// strings, stream paths, and slugs for references it never stored. Every path
// first normalizes: trim, drop blank/whitespace-only entries, and de-duplicate
// — an empty or repeated citation is never meaningful regardless of wiring.
// With a resolver, only slugs backed by a real reference file then survive; the
// rest are dropped and logged so dangling citations never reach the stream.
// Without one (the standalone `appendTool` export, no reference subsystem
// wired) the normalized slugs pass through.
async function resolveValidReferences(
  references: string[] | undefined,
  resolver: ReferenceSlugResolver | undefined,
  ctx: { agentDir: string; logger?: { warn(message: string): void } },
): Promise<string[]> {
  if (references === undefined || references.length === 0) return []
  const requested = [...new Set(references.map((slug) => slug.trim()).filter((slug) => slug.length > 0))]
  if (resolver === undefined) return requested

  const known = new Set(await resolver(ctx.agentDir))
  const valid = requested.filter((slug) => known.has(slug))
  const dropped = requested.filter((slug) => !known.has(slug))
  if (dropped.length > 0) {
    ctx.logger?.warn(
      `[memory] dropped ${dropped.length} unknown reference slug(s) from fragment: ${dropped.join(', ')}. ` +
        `references[] may only cite slugs returned by store_reference.`,
    )
  }
  return valid
}

function assertNoSecrets(parts: ReadonlyArray<string | undefined>): void {
  const content = parts.filter((part): part is string => part !== undefined).join('\n')
  const secrets = detectSecrets(content)
  if (secrets.length === 0) return

  const ruleNames = [...new Set(secrets.map((s) => s.rule))].join(', ')
  throw new Error(
    `Refusing to append: content contains a recognized credential pattern (${ruleNames}). ` +
      `Memory fragments must never quote secret values verbatim. Record the env var name and how it ` +
      `was discovered, not the value itself.`,
  )
}
