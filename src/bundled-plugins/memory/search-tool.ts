import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { z } from 'zod'

import { defineTool } from '@/plugin'

import { loadAllShards, loadShard, type TopicShard } from './load-shards'
import {
  buildProvenanceIndex,
  buildProvenanceIndexFrom,
  type MemoryScope,
  type ProvenanceChild,
} from './provenance-index'
import { sanitizeProvenanceName } from './provenance-sanitize'
import { renderReference } from './references/frontmatter'
import { bumpReferenceAccess, loadAllReferences, loadReference, type Reference } from './references/load-references'
import { vectorDbPath } from './search-command'
import { hydrateHybridMatches } from './search-tool-hybrid'
import type { FragmentEvent, FragmentProvenance, LegacyProseEvent, StreamEvent } from './stream-events'
import { filterUndreamedEvents, readAllStreamDays, type UndreamedStreamDay } from './stream-io'
import { hybridSearch, type EmbedFn, type HybridSearchResult } from './vector/hybrid'
import { VectorStore } from './vector/store'

const DEFAULT_MAX_RESULTS = 10
const EXCERPT_CONTEXT_LINES = 3
const EXCERPT_HEAD_LINES = 7

export type TopicMatch = {
  source: 'topic'
  shardPath: string
  slug: string
  heading: string
  excerpt: string
  fullBody?: string
  provenance?: ProvenanceChild[]
}

export type StreamMatch = {
  source: 'stream'
  streamPath: string
  date: string
  eventId?: string
  topic: string
  excerpt: string
  fullBody?: string
  who?: string
  when?: string
  where?: FragmentProvenance
}

export type ReferenceMatch = {
  source: 'reference'
  slug: string
  title: string
  excerpt: string
  created: string
  fullBody?: string
}

export type MemorySearchMatch = TopicMatch | StreamMatch | ReferenceMatch

export type MemorySearchResult = { matches: MemorySearchMatch[]; truncatedAt?: number } | { error: string }

export type Matcher = (haystack: string) => boolean

export function createMemorySearchTool(embedFn?: EmbedFn) {
  return defineTool({
    description:
      'Search long-term memory and recent undreamed fragments by meaning and keywords (default mode: hybrid). Use mode: lexical for case-insensitive phrase-first search with token-OR fallback. Use asRegex: true for exact regex semantics without token fallback, or topic for one exact topic/reference slug; both bypass semantic search. If the semantic index is unavailable, the result reports lexical fallback. full: true returns complete bodies. Runtime-owned provenance from active topic citations is searchable but never embedded. `workspace`, `chat`, and `thread` scope both topics and recent fragments to matching captured origin IDs or names; legacy `where` remains an alias for `chat`. Scoped topic eligibility, lexical matching, and returned provenance use the same eligible active cited children. Unresolved citations remain explicit in unscoped results and never gain invented metadata.',
    parameters: z.object({
      query: z.string().optional(),
      mode: z.enum(['hybrid', 'lexical']).default('hybrid'),
      topic: z.string().optional(),
      asRegex: z.boolean().default(false),
      full: z.boolean().default(false),
      maxResults: z.number().int().min(0).default(DEFAULT_MAX_RESULTS),
      since: z.string().optional(),
      before: z.string().optional(),
      where: z.string().optional(),
      workspace: z.string().optional(),
      chat: z.string().optional(),
      thread: z.string().optional(),
    }),
    // Every string field is a search term, an exact topic/reference slug, an ISO
    // date, or an origin id/name — none is a local path (the tool reads memory/
    // internally, never a caller path). Declared so a `topic` slug that collides
    // with an agent-root dir, or a `since` date like "2026-01-01", is not
    // misread as a file operand.
    fileOperands: {
      nonFile: ['query', 'mode', 'topic', 'since', 'before', 'where', 'workspace', 'chat', 'thread'],
    },
    async execute(
      { query, mode, topic, asRegex, full, maxResults, since, before, where, workspace, chat, thread },
      ctx,
    ) {
      if ((query === undefined) === (topic === undefined)) {
        return resultToToolResult({ error: 'provide exactly one of `query` or `topic`' })
      }

      const chatScope = chat ?? where
      const requestedScope: MemoryScope = {
        ...(workspace === undefined ? {} : { workspace }),
        ...(chatScope === undefined ? {} : { chat: chatScope }),
        ...(thread === undefined ? {} : { thread }),
      }
      const scope = requestedScope

      if (topic !== undefined) {
        return resultToToolResult(await lookupTopic(ctx.agentDir, topic, scope, ctx.logger))
      }

      const matcherOrError = buildMatcher(query!, asRegex)
      if (typeof matcherOrError === 'string') {
        return resultToToolResult({ error: matcherOrError })
      }
      const dateFilter = parseReferenceDateFilter(since, before)
      if ('error' in dateFilter) return resultToToolResult(dateFilter)
      let fallbackReason: string | undefined
      if (query !== undefined && mode === 'hybrid' && !asRegex) {
        const dbPath = vectorDbPath(ctx.agentDir)
        if (!existsSync(dbPath)) {
          fallbackReason = 'memory/.vectors/index.db is absent'
        } else {
          try {
            const store = VectorStore.open(dbPath)
            let hits: HybridSearchResult[]
            try {
              hits = await hybridSearch(query, store, ctx.agentDir, maxResults, embedFn, { scope })
            } finally {
              store.close()
            }
            const matches = (await hydrateHybridMatches(ctx.agentDir, hits, full)).filter(
              (match) => match.source !== 'reference' || referenceDateAllowed(match.created, dateFilter),
            )
            await bumpReferenceAccess(
              ctx.agentDir,
              matches.flatMap((match) => (match.source === 'reference' ? [match.slug] : [])),
              { logger: ctx.logger },
            )
            return resultToToolResult({ matches })
          } catch (err) {
            fallbackReason = err instanceof Error ? err.message : String(err)
          }
        }
        ctx.logger.warn(`[memory-search] semantic index unavailable: ${fallbackReason}`)
      }
      const [shards, allStreamDays, allReferences] = await Promise.all([
        loadAllShards(ctx.agentDir, { logger: ctx.logger }),
        readAllStreamDays(ctx.agentDir),
        loadAllReferences(ctx.agentDir, { logger: ctx.logger }),
      ])
      const provenanceIndex = await buildProvenanceIndexFrom(ctx.agentDir, shards, allStreamDays)
      const scoped = hasMemoryScope(scope)
      const streamDays: UndreamedStreamDay[] = allStreamDays.flatMap((day) => {
        const events: StreamEvent[] = []
        for (const event of filterUndreamedEvents(day.events, day.dreamedIds)) {
          if (event.type !== 'fragment') {
            if (!scoped) events.push(event)
            continue
          }
          const citation = `streams/${day.date}#${event.id}`
          if (provenanceIndex.isActivelyCited(citation) || provenanceIndex.isSuperseded(citation)) continue
          const child = provenanceIndex.undreamedChild(citation, scope)
          if (child !== undefined) events.push(safeStreamEvent(event, child))
        }
        return events.length === 0 ? [] : [{ date: day.date, path: day.path, name: day.name, events }]
      })

      const roomFilteredDays = streamDays
      const scopedShards = shards.filter((shard) => provenanceIndex.topicEligible(shard.slug, scope))
      const references = !scoped ? allReferences.filter((r) => referenceCandidateAllowed(r, dateFilter)) : []
      const topicDocuments = new Map(
        scopedShards.map((shard) => [
          shard.slug,
          `${shardSearchText(shard)}\n${provenanceIndex.lexicalTextForTopic(shard.slug, scope)}`,
        ]),
      )
      const topicProvenance = new Map(
        scopedShards.map((shard) => [shard.slug, provenanceIndex.childrenForTopic(shard.slug, scope)]),
      )
      const streamDocuments = new Map<string, string>()
      for (const day of roomFilteredDays) {
        for (const event of day.events) {
          if (event.type !== 'fragment') continue
          const citation = `streams/${day.date}#${event.id}`
          streamDocuments.set(
            citation,
            `${eventSearchText(event)}\n${provenanceIndex.lexicalTextForUndreamed(citation, scope)}`,
          )
        }
      }

      if (scopedShards.length === 0 && roomFilteredDays.length === 0 && references.length === 0) {
        return resultToToolResult({ matches: [], truncatedAt: 0 }, fallbackReason)
      }

      const searchOptions = { full, maxResults, references, topicDocuments, topicProvenance, streamDocuments }
      let result = searchAll(scopedShards, roomFilteredDays, matcherOrError, searchOptions)
      if ('matches' in result && result.matches.length === 0) {
        const fallback = tokenFallback(query!, asRegex, scopedShards, roomFilteredDays, references, searchOptions)
        if (fallback !== null) result = fallback
      }
      if ('matches' in result) await bumpReturnedReferences(allReferences, result.matches)
      return resultToToolResult(result, fallbackReason)
    },
  })
}

function safeStreamEvent(event: FragmentEvent, child: ProvenanceChild): FragmentEvent {
  const safe = { ...event }
  delete safe.who
  delete safe.where
  if (child.who !== undefined) safe.who = child.who
  if (child.where !== undefined) safe.where = child.where
  return safe
}

export const memorySearchTool = createMemorySearchTool()

// Exact slug lookup, so the agent can read a topic OR reference whose slug the
// per-turn injection already showed it without re-running a fuzzy search for a
// body the retrieval layer already located. The injected memory block renders
// both topic and reference entries with a `slug:` line and a single recovery
// hint (`memory_search({ topic: "<slug>" })`), so this lookup must resolve both:
// it tries the topic shard first, then falls back to a reference of the same
// slug. A traversal slug makes the path builder throw inside the loader — caught
// and returned as a structured error, not a crash. A slug that matches neither
// returns empty matches, the same shape as a search that hit nothing.
async function lookupTopic(
  agentDir: string,
  slug: string,
  scope: MemoryScope,
  logger?: { warn(message: string): void },
): Promise<MemorySearchResult> {
  const loaderOptions = logger === undefined ? {} : { logger }
  let shard: TopicShard | null
  try {
    shard = await loadShard(agentDir, slug, loaderOptions)
  } catch (err) {
    return { error: `invalid topic slug: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (shard !== null) {
    const index = await buildProvenanceIndex(agentDir)
    if (!index.topicEligible(shard.slug, scope)) return { matches: [] }
    const provenance = index.childrenForTopic(shard.slug, scope)
    return { matches: [topicMatchWithFullBody(shard, provenance)] }
  }

  if (hasMemoryScope(scope)) return { matches: [] }
  const reference = await loadReference(agentDir, slug, loaderOptions)
  if (reference !== null) {
    const match = referenceMatchWithFullBody(reference)
    // A reference reached via topic-slug lookup is a real access — record it so
    // it advances accessCount/lastAccessed the same as a query hit, otherwise the
    // injected-slug use case this fallback unlocks would still decay as unused.
    await bumpReturnedReferences([reference], [match])
    return { matches: [match] }
  }

  return { matches: [] }
}

function hasMemoryScope(scope: MemoryScope): boolean {
  return scope.workspace !== undefined || scope.chat !== undefined || scope.thread !== undefined
}

function topicMatchWithFullBody(shard: TopicShard, provenance: ProvenanceChild[] = []): TopicMatch {
  return {
    source: 'topic',
    shardPath: shard.path,
    slug: shard.slug,
    heading: shard.frontmatter.heading,
    excerpt: excerpt(shard.body),
    fullBody: shard.body,
    ...(provenance.length > 0 ? { provenance } : {}),
  }
}

function referenceMatchWithFullBody(reference: Reference): ReferenceMatch {
  return {
    source: 'reference',
    slug: reference.slug,
    title: reference.frontmatter.title,
    excerpt: excerpt(reference.body),
    created: reference.frontmatter.created,
    fullBody: reference.body,
  }
}

function excerpt(body: string): string {
  return splitBodyLines(body).slice(0, EXCERPT_HEAD_LINES).join('\n')
}

// Phrase-first/token-fallback: the descriptive multi-word queries the
// retrieval subagent issues rarely appear verbatim in any body, so a
// whole-phrase substring search returns nothing while every component word is
// present. When the phrase search comes up empty, split on whitespace and
// OR-match the distinct tokens, ranking each hit by how many tokens it
// matched (richer matches first) with the natural topic-first/newest-stream
// order as the stable tiebreak. Returns null when tokenizing cannot widen the
// search: regex mode (whitespace is intentional pattern syntax), or a token
// set that is identical to the phrase already tried (a single clean token, so
// the phrase search already covered it).
function tokenFallback(
  query: string,
  asRegex: boolean,
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  references: Reference[],
  options: {
    full: boolean
    maxResults: number
    topicDocuments?: Map<string, string>
    topicProvenance?: Map<string, ProvenanceChild[]>
    streamDocuments?: Map<string, string>
  },
): MemorySearchResult | null {
  if (asRegex) return null
  const tokens = distinctTokens(query)
  if (tokens.length === 0) return null
  if (tokens.length === 1 && tokens[0] === query.trim().toLowerCase()) return null
  return searchAllRanked(shards, streamDays, tokens, { ...options, references })
}

export function distinctTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    ),
  ]
}

export function buildMatcher(query: string, asRegex: boolean): Matcher | string {
  if (asRegex) {
    try {
      const regex = new RegExp(query, 'i')
      return (haystack) => regex.test(haystack)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `invalid regex: ${message}`
    }
  }

  const needle = query.toLowerCase()
  return (haystack) => haystack.toLowerCase().includes(needle)
}

// Result-ordering contract: topic shards first (alphabetical by slug, the
// order `loadAllShards` returns), then stream days (newest first). Truncation
// cuts from the tail of this concatenation — stream matches are sacrificed
// before topic matches when `maxResults` is exhausted. The agent reading
// results in this order sees long-term consolidated truth before recent
// ephemeral fragments, which mirrors the injection-side rendering order.
export function searchAll(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  matcher: Matcher,
  options: {
    full: boolean
    maxResults: number
    references?: Reference[]
    topicDocuments?: Map<string, string>
    topicProvenance?: Map<string, ProvenanceChild[]>
    streamDocuments?: Map<string, string>
  },
): MemorySearchResult {
  const matches: MemorySearchMatch[] = []
  let truncatedAt: number | undefined

  const push = (match: MemorySearchMatch): boolean => {
    if (matches.length >= options.maxResults) {
      truncatedAt = options.maxResults
      return false
    }
    matches.push(match)
    return true
  }

  for (const shard of shards) {
    const match = matchShard(
      shard,
      matcher,
      options.full,
      options.topicDocuments?.get(shard.slug),
      options.topicProvenance?.get(shard.slug),
    )
    if (match === null) continue
    if (!push(match)) return { matches, truncatedAt: truncatedAt! }
  }

  for (const reference of options.references ?? []) {
    const match = matchReference(reference, matcher, options.full)
    if (match === null) continue
    if (!push(match)) return { matches, truncatedAt: truncatedAt! }
  }

  for (let i = streamDays.length - 1; i >= 0; i--) {
    const day = streamDays[i]!
    for (const event of day.events) {
      const match = matchStreamEvent(day, event, matcher, options.full, options.streamDocuments)
      if (match === null) continue
      if (!push(match)) return { matches, truncatedAt: truncatedAt! }
    }
  }

  return truncatedAt === undefined ? { matches } : { matches, truncatedAt }
}

// Token-OR variant of searchAll. Builds each match with an any-token matcher
// (so a hit requires only one token and the excerpt anchors on the first line
// matching any token), then scores it by how many distinct tokens appear in
// its full searchable text. Results sort by score descending; ties keep the
// natural enumeration order (topics first in loadAllShards order, then stream
// days newest-first), so the established ordering contract holds within each
// score band. maxResults truncation is applied last, after ranking.
//
// `tokenMatchMode` defaults to 'substring' (the tool-path contract: `memory_search`
// is a deliberate agent query). The hybrid keyword lane opts into 'ascii-boundary'
// because its query is a whole user prompt, where unanchored substrings let short
// tokens ('in', 'do', 'ci') match inside unrelated words and over-score verbose
// shards. Both the match predicate and the score use the SAME per-token matchers,
// so a shard cannot rank on a hit the matcher wouldn't have counted.
export function searchAllRanked(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  tokens: string[],
  options: {
    full: boolean
    maxResults: number
    references?: Reference[]
    tokenMatchMode?: 'substring' | 'ascii-boundary'
    topicDocuments?: Map<string, string>
    topicProvenance?: Map<string, ProvenanceChild[]>
    streamDocuments?: Map<string, string>
  },
): MemorySearchResult {
  const tokenMatchers = tokens.map((t) => buildTokenMatcher(t, options.tokenMatchMode ?? 'substring'))
  const anyToken: Matcher = (haystack) => {
    const lower = haystack.toLowerCase()
    return tokenMatchers.some((matches) => matches(lower))
  }
  const scoreOf = (text: string): number => {
    const lower = text.toLowerCase()
    return tokenMatchers.reduce((n, matches) => (matches(lower) ? n + 1 : n), 0)
  }

  const scored: Array<{ match: MemorySearchMatch; score: number; order: number }> = []
  let order = 0

  for (const shard of shards) {
    const match = matchShard(
      shard,
      anyToken,
      options.full,
      options.topicDocuments?.get(shard.slug),
      options.topicProvenance?.get(shard.slug),
    )
    if (match === null) continue
    scored.push({
      match,
      score: scoreOf(options.topicDocuments?.get(shard.slug) ?? shardSearchText(shard)),
      order: order++,
    })
  }

  for (const reference of options.references ?? []) {
    const match = matchReference(reference, anyToken, options.full)
    if (match === null) continue
    scored.push({ match, score: scoreOf(referenceSearchText(reference)), order: order++ })
  }

  for (let i = streamDays.length - 1; i >= 0; i--) {
    const day = streamDays[i]!
    for (const event of day.events) {
      const match = matchStreamEvent(day, event, anyToken, options.full, options.streamDocuments)
      if (match === null) continue
      const citation = event.type === 'fragment' ? `streams/${day.date}#${event.id}` : undefined
      scored.push({
        match,
        score: scoreOf(
          (citation === undefined ? undefined : options.streamDocuments?.get(citation)) ?? eventSearchText(event),
        ),
        order: order++,
      })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.order - b.order)

  if (scored.length > options.maxResults) {
    return { matches: scored.slice(0, options.maxResults).map((s) => s.match), truncatedAt: options.maxResults }
  }
  return { matches: scored.map((s) => s.match) }
}

// A per-token predicate over an ALREADY-lowercased haystack. 'substring' is plain
// `includes`. 'ascii-boundary' anchors ASCII tokens between alnum boundaries
// (NOT `\b`, which is unreliable for CJK) so 'in'/'do' stop matching inside
// 'reload'/'docker'; a token containing any non-ASCII char (e.g. '홍길동') has no
// reliable ASCII boundary and falls back to substring.
function buildTokenMatcher(token: string, mode: 'substring' | 'ascii-boundary'): (lowerHaystack: string) => boolean {
  if (mode === 'substring' || hasNonAscii(token)) {
    return (lower) => lower.includes(token)
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`)
  return (lower) => boundary.test(lower)
}

export function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return true
  }
  return false
}

function shardSearchText(shard: TopicShard): string {
  return [shard.slug, shard.frontmatter.heading, ...(shard.frontmatter.tags ?? []), shard.body].join('\n')
}

function eventSearchText(event: StreamEvent): string {
  if (event.type === 'fragment') return `${event.topic}\n${event.body}`
  if (event.type === 'legacy_prose') return event.text
  return ''
}

function referenceSearchText(reference: Reference): string {
  return [reference.slug, reference.frontmatter.title, ...reference.frontmatter.tags, reference.body].join('\n')
}

function matchShard(
  shard: TopicShard,
  matcher: Matcher,
  full: boolean,
  searchText = shardSearchText(shard),
  provenance?: ProvenanceChild[],
): TopicMatch | null {
  const bodyLines = splitBodyLines(shard.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))

  const matched =
    matcher(shard.slug) ||
    matcher(shard.frontmatter.heading) ||
    (shard.frontmatter.tags?.some((tag) => matcher(tag)) ?? false) ||
    firstBodyLineIndex !== -1 ||
    matcher(searchText)
  if (!matched) return null

  const match: TopicMatch = {
    source: 'topic',
    shardPath: shard.path,
    slug: shard.slug,
    heading: shard.frontmatter.heading,
    excerpt:
      firstBodyLineIndex === -1 ? fallbackExcerpt(shard, matcher) : excerptForLine(bodyLines, firstBodyLineIndex),
  }
  if (full) match.fullBody = shard.body
  if (provenance !== undefined && provenance.length > 0) match.provenance = provenance
  return match
}

function matchReference(reference: Reference, matcher: Matcher, full: boolean): ReferenceMatch | null {
  const bodyLines = splitBodyLines(reference.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))
  const matched =
    matcher(reference.slug) ||
    matcher(reference.frontmatter.title) ||
    reference.frontmatter.tags.some((tag) => matcher(tag)) ||
    firstBodyLineIndex !== -1
  if (!matched) return null

  const match: ReferenceMatch = {
    source: 'reference',
    slug: reference.slug,
    title: reference.frontmatter.title,
    excerpt:
      firstBodyLineIndex === -1
        ? fallbackReferenceExcerpt(reference, matcher)
        : excerptForLine(bodyLines, firstBodyLineIndex),
    created: reference.frontmatter.created,
  }
  if (full) match.fullBody = reference.body
  return match
}

// Stream-event matcher. `fragment` events expose `topic` + `body` for search;
// `legacy_prose` exposes `text` (no id, no topic). `watermark` events carry
// no human content and are skipped — they only mark dreaming progress.
//
// Fragment matches set `eventId` to the canonical citation format
// `streams/yyyy-MM-dd#<id>` so the agent can paste search hits straight into
// shard citations. Legacy prose has no fragment id and therefore omits
// `eventId` — `parseCitations` would reject any value we synthesised, so we
// leave the field absent to make the asymmetry visible to the agent.
function matchStreamEvent(
  day: UndreamedStreamDay,
  event: StreamEvent,
  matcher: Matcher,
  full: boolean,
  streamDocuments?: Map<string, string>,
): StreamMatch | null {
  if (event.type === 'watermark') return null
  if (event.type === 'fragment') {
    return matchFragmentEvent(day, event, matcher, full, streamDocuments?.get(`streams/${day.date}#${event.id}`))
  }
  return matchLegacyProseEvent(day, event, matcher, full)
}

function matchFragmentEvent(
  day: UndreamedStreamDay,
  event: FragmentEvent,
  matcher: Matcher,
  full: boolean,
  searchText = eventSearchText(event),
): StreamMatch | null {
  const bodyLines = splitBodyLines(event.body)
  const firstBodyLineIndex = bodyLines.findIndex((line) => matcher(line))
  const matched = matcher(event.topic) || firstBodyLineIndex !== -1 || matcher(searchText)
  if (!matched) return null

  const match: StreamMatch = {
    source: 'stream',
    streamPath: day.path,
    date: day.date,
    eventId: `streams/${day.date}#${event.id}`,
    topic: event.topic,
    excerpt: firstBodyLineIndex === -1 ? event.topic : excerptForLine(bodyLines, firstBodyLineIndex),
    when: event.ts,
  }
  const who = sanitizeProvenanceName(event.who)
  if (who !== undefined) match.who = who
  if (event.where !== undefined) match.where = event.where
  if (full) match.fullBody = event.body
  return match
}

function matchLegacyProseEvent(
  day: UndreamedStreamDay,
  event: LegacyProseEvent,
  matcher: Matcher,
  full: boolean,
): StreamMatch | null {
  const lines = splitBodyLines(event.text)
  const firstLineIndex = lines.findIndex((line) => matcher(line))
  if (firstLineIndex === -1) return null

  const match: StreamMatch = {
    source: 'stream',
    streamPath: day.path,
    date: day.date,
    topic: '[legacy prose from pre-shard migration]',
    excerpt: excerptForLine(lines, firstLineIndex),
  }
  if (full) match.fullBody = event.text
  return match
}

function splitBodyLines(body: string): string[] {
  const lines = body.split('\n')
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

function fallbackExcerpt(shard: TopicShard, matcher: Matcher): string {
  if (matcher(shard.frontmatter.heading)) return shard.frontmatter.heading
  if (matcher(shard.slug)) return shard.slug
  const matchedTag = shard.frontmatter.tags?.find((tag) => matcher(tag))
  return matchedTag ?? shard.frontmatter.heading
}

function fallbackReferenceExcerpt(reference: Reference, matcher: Matcher): string {
  if (matcher(reference.frontmatter.title)) return reference.frontmatter.title
  if (matcher(reference.slug)) return reference.slug
  const matchedTag = reference.frontmatter.tags.find((tag) => matcher(tag))
  return matchedTag ?? reference.frontmatter.title
}

type ReferenceDateFilter = { since?: Date; before?: Date }

function parseReferenceDateFilter(
  since: string | undefined,
  before: string | undefined,
): ReferenceDateFilter | { error: string } {
  const sinceDate = since === undefined ? undefined : parseDateParam('since', since)
  if (typeof sinceDate === 'string') return { error: sinceDate }
  const beforeDate = before === undefined ? undefined : parseDateParam('before', before)
  if (typeof beforeDate === 'string') return { error: beforeDate }
  return { since: sinceDate, before: beforeDate }
}

function parseDateParam(name: string, value: string): Date | string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return `invalid ${name}: expected ISO 8601 datetime string`
  return date
}

function referenceCandidateAllowed(reference: Reference, filter: ReferenceDateFilter): boolean {
  if (reference.frontmatter.demoted) return false
  return referenceDateAllowed(reference.frontmatter.created, filter)
}

function referenceDateAllowed(createdAt: string, filter: ReferenceDateFilter): boolean {
  const created = new Date(createdAt)
  if (filter.since !== undefined && created < filter.since) return false
  if (filter.before !== undefined && created >= filter.before) return false
  return true
}

async function bumpReturnedReferences(references: Reference[], matches: MemorySearchMatch[]): Promise<void> {
  const returnedSlugs = new Set(matches.filter((match) => match.source === 'reference').map((match) => match.slug))
  if (returnedSlugs.size === 0) return
  await Promise.all(
    references
      .filter((reference) => returnedSlugs.has(reference.slug))
      .map((reference) =>
        writeFile(
          reference.path,
          renderReference(
            {
              ...reference.frontmatter,
              lastAccessed: new Date().toISOString(),
              accessCount: reference.frontmatter.accessCount + 1,
            },
            reference.body,
          ),
          'utf8',
        ),
      ),
  )
}

function excerptForLine(lines: string[], matchIndex: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_CONTEXT_LINES)
  const end = Math.min(lines.length, matchIndex + EXCERPT_CONTEXT_LINES + 1)
  return lines.slice(start, end).join('\n')
}

const EMPTY_RESULT_GUIDANCE =
  'No matching memory. This is the authoritative result — memory_search already covers topic shards, references, and undreamed stream events. Do not fall back to grep/find/bash or manually reading memory/topics, memory/references, memory/streams, or sessions; accept that no relevant memory exists and proceed.'

// The empty-set note rides in the LLM-facing `text` ONLY. `details` stays the
// pure struct: `keywordLane` reads `searchAll` directly (never this layer) and
// the structured tests assert on `details`, so both must see no `note`.
function resultToToolResult(result: MemorySearchResult, fallbackReason?: string) {
  const isEmpty = 'matches' in result && result.matches.length === 0
  const text = JSON.stringify({
    ...result,
    ...(isEmpty ? { note: EMPTY_RESULT_GUIDANCE } : {}),
    ...(fallbackReason === undefined ? {} : { notice: 'Semantic index unavailable; lexical results are shown.' }),
  })
  return {
    content: [{ type: 'text' as const, text }],
    details: result,
  }
}
