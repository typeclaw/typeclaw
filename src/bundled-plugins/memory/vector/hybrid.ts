import { createHash } from 'node:crypto'

import { loadAllShards, type TopicShard } from '../load-shards'
import { buildParentLinks } from '../parent-link'
import {
  buildProvenanceIndexFrom,
  type MemoryScope,
  type ProvenanceChild,
  type ProvenanceIndex,
} from '../provenance-index'
import { loadAllReferences, type Reference } from '../references/load-references'
import {
  buildMatcher,
  distinctTokens,
  hasNonAscii,
  searchAll,
  searchAllRanked,
  type MemorySearchMatch,
  type StreamMatch,
} from '../search-tool'
import type { FragmentProvenance, StreamEvent } from '../stream-events'
import { filterUndreamedEvents, readAllStreamDays, type UndreamedStreamDay } from '../stream-io'
import { embed, EMBEDDING_MODEL_ID, type EmbedType } from './embedder'
import type { Passage } from './passages'
import { clearsBaseline, gateRelevance, MARGIN, streamAdmissionBaseline } from './relevance-gate'
import { crossScriptMarginScale, dominantScript, type ScriptClass } from './script'
import { scoreRows, VectorStore, type ScoredVectorRow, type VectorRow } from './store'
import { chunkEmbeddableText } from './truncation'

export { collectPassages, findMissingPassages, type Passage } from './passages'

const RRF_K = 60

// A long prompt is embedded as multiple ≤512-token chunks (not truncated to one
// vector), so a memory relevant to ANY part of the prompt — including its tail —
// can still be retrieved. The cap bounds the per-turn cosine scans: each chunk is
// a full O(rows) brute-force pass over the store, so an unbounded chunk count
// would scale per-turn retrieval cost with prompt length. At the cap, the LAST
// chunks are kept rather than the first: TypeClaw cron/agent prompts front-load
// fixed framing prose and place the actual payload last, so dropping the head is
// the lesser loss than re-introducing the tail-truncation this fix removes.
const MAX_QUERY_CHUNKS = 10

function queryEmbeddingChunks(query: string): string[] {
  const chunks = chunkEmbeddableText(query)
  return chunks.length <= MAX_QUERY_CHUNKS ? chunks : chunks.slice(chunks.length - MAX_QUERY_CHUNKS)
}

export type HybridSearchResult = {
  source: 'topic' | 'stream' | 'reference'
  key: string
  heading: string
  excerpt: string
  rrfScore: number
  who?: string
  when?: string
  where?: FragmentProvenance
  provenance?: ProvenanceChild[]
}

export type EmbedFn = (texts: string[], type: EmbedType) => Promise<Float32Array[]>
export type HybridSearchOptions = { scope?: MemoryScope }

export async function hybridSearch(
  query: string,
  store: VectorStore,
  agentDir: string,
  topK: number,
  embedFn: EmbedFn = embed,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult[]> {
  if (topK <= 0) return []

  const queryChunks = queryEmbeddingChunks(query)
  const [shards, allStreamDays, references, queryEmbeddings] = await Promise.all([
    loadAllShards(agentDir),
    readAllStreamDays(agentDir),
    loadAllReferences(agentDir),
    embedFn(queryChunks, 'query'),
  ])
  const allUndreamedDays: UndreamedStreamDay[] = allStreamDays.flatMap((day) => {
    const events = filterUndreamedEvents(day.events, day.dreamedIds)
    return events.length === 0 ? [] : [{ date: day.date, path: day.path, name: day.name, events }]
  })
  const provenanceIndex = await buildProvenanceIndexFrom(agentDir, shards, allStreamDays)
  const scope = options.scope ?? {}
  const scoped = hasScope(scope)
  const eligibleCitations = new Set(provenanceIndex.undreamedChildren(scope).map((child) => child.citation))
  const streamDays = allUndreamedDays.flatMap((day) => {
    const events = day.events.filter((event) => {
      if (!scoped) return true
      if (event.type !== 'fragment') return false
      return eligibleCitations.has(`streams/${day.date}#${event.id}`)
    })
    return events.length === 0 ? [] : [{ ...day, events }]
  })
  const eligibleShards = shards.filter(
    (shard) => shard.frontmatter.kind !== 'environmental-incident' && provenanceIndex.topicEligible(shard.slug, scope),
  )
  const eligibleReferences = scoped ? [] : references

  const { supersededFragmentIds } = buildParentLinks(shards)
  const { parentSlugsByFragmentId } = buildParentLinks(eligibleShards)
  if (scoped) {
    const eligibleFragmentIds = new Set(
      eligibleShards.flatMap((shard) =>
        provenanceIndex.childrenForTopic(shard.slug, scope).flatMap((child) => fragmentIdFromKey(child.citation) ?? []),
      ),
    )
    for (const fragmentId of parentSlugsByFragmentId.keys()) {
      if (!eligibleFragmentIds.has(fragmentId)) parentSlugsByFragmentId.delete(fragmentId)
    }
  }
  const index = buildContentIndex(
    eligibleShards,
    streamDays,
    eligibleReferences,
    supersededFragmentIds,
    provenanceIndex,
    scope,
  )
  const vectorRows =
    queryEmbeddings.length === 0
      ? []
      : gatedVectorLane(queryEmbeddings, queryChunks, store, topK, index, parentSlugsByFragmentId)
  const keywordMatches = keywordLane(
    query,
    eligibleShards,
    streamDays,
    eligibleReferences,
    topK * 2,
    provenanceIndex,
    scope,
  )

  return fuseLanes(vectorRows, keywordMatches, index, parentSlugsByFragmentId).slice(0, topK)
}

// Only topics define the topic gate and the stream admission band. Reference
// chunks can form an elevated, flat cluster even on a content-free query;
// pooling that cluster with topics would let it admit unrelated topic neighbours.
//
//   - Topic rows: the gate keeps the knee above the band, or empties the topic
//     partition entirely when no topic clears it.
//   - Stream rows: admitted one-by-one only when they clear the SAME band by
//     the shared margin. A genuine fresh fragment (well above the band) survives
//     the freshness window; an irrelevant in-band neighbour is dropped, so a
//     no-match query can't leak closest-neighbours-regardless through streams.
//   - Reference rows: must clear both the topic band and the reference chunk
//     band by the strict margin. A uniformly elevated reference cluster is not
//     evidence of a match, even when it stands above the topic band. Unlike
//     gateRelevance, this admission check has no small-reference-set exemption.
//
// Topic suppression uses the floor-gated verdict (gateRelevance): below the
// floor topics pass ungated, since a tiny index can't form a reliable band and
// a false negative is cheaper than suppressing the only memory. With fewer
// than two topics there is no topic admission baseline: streams remain closed,
// while references use their own floor-gated verdict so a tiny reference-only
// index is not hidden. Keyword hits remain independent of every vector verdict.
function gatedVectorLane(
  queryEmbeddings: Float32Array[],
  queryChunks: string[],
  store: VectorStore,
  topK: number,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): VectorRow[] {
  const allScored = maxScoreAcrossChunks(queryEmbeddings, store)
  const scored = allScored.scored.filter(({ row }) => vectorRowIsAuthorized(row, index, parentSlugsByFragmentId))
  const { winnerChunkByRowId } = allScored
  const bandDefiningRows = scored.filter(({ row }) => row.source === 'topic')
  const referenceRows = scored.filter(({ row }) => row.source === 'reference')
  const streamRows = scored.filter(({ row }) => row.source === 'stream')

  // The cross-script verdict is judged against the HEAD of the scored band — the
  // high-scoring rows that actually define the contrast the gate measures — not
  // the whole corpus. Deriving it from every shard would let one unrelated same-
  // script heading anywhere in the index cancel the loosening, so a real cross-
  // script winner whose contrast sits between the loosened and strict margins
  // would still be suppressed. Headings (via `index`) carry the language; slugs
  // are ASCII-kebab even for non-Latin topics.
  //
  // The query-side script comes from the CHUNK that won each head row, not the
  // full prompt: a boilerplate-front prompt (most TypeClaw cron prompts) has a
  // dominant script set by framing prose, not by the payload that actually
  // matched. Using the winning chunk's script keeps the loosening aligned with
  // the text that produced the contrast.
  const queryScript = dominantQueryScript(bandDefiningRows, winnerChunkByRowId, queryChunks)
  const topicMargin = MARGIN * crossScriptMarginScale(queryScript, headBandScripts(bandDefiningRows, index))
  const bandScores = bandDefiningRows.map(({ score }) => score)
  const keptBandDefiningRows = bandDefiningRows.slice(0, gateRelevance(bandScores, topK * 2, topicMargin))

  // Stream admission stays on the STRICT MARGIN regardless of the topic verdict.
  // The cross-script loosening is calibrated for the topic band the query is
  // judged against; a stream row's own language is not part of that band, so
  // applying the loosened margin here would admit an irrelevant in-band stream
  // neighbour on a cross-script query — exactly the closest-neighbour leak the
  // strict stream guard exists to block.
  const streamBaseline = streamAdmissionBaseline(bandScores)
  const keptStreams = streamRows.filter(({ score }) => clearsBaseline(score, streamBaseline)).slice(0, topK * 2)

  const referenceScores = referenceRows.map(({ score }) => score)
  const referenceBaseline = streamAdmissionBaseline(referenceScores)
  const keptReferences =
    streamBaseline === null
      ? referenceRows.slice(0, gateRelevance(referenceScores, topK * 2))
      : referenceRows
          .filter(({ score }) => clearsBaseline(score, Math.max(streamBaseline, referenceBaseline ?? streamBaseline)))
          .slice(0, topK * 2)

  return [...keptBandDefiningRows, ...keptStreams, ...keptReferences]
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row)
}

function vectorRowIsAuthorized(
  row: VectorRow,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): boolean {
  if (row.source === 'reference') return index.has(laneKey('reference', referenceSlugFromKey(row.key)))
  if (row.source === 'topic') return index.has(laneKey('topic', row.key))
  if (index.has(laneKey('stream', row.key))) return true
  const fragmentId = fragmentIdFromKey(row.key)
  return fragmentId !== null && (parentSlugsByFragmentId.get(fragmentId)?.size ?? 0) > 0
}

// The scripts of the HEAD band-defining rows (the gate examines the top of the
// score-sorted band to set the knee, so the head is what the query is actually
// contrasted against). `bandDefiningRows` is score-sorted descending, so the
// first HEAD_BAND_SCRIPT_SAMPLE rows ARE the head. Headings come from the content
// index; a row whose content was pruned contributes no script.
const HEAD_BAND_SCRIPT_SAMPLE = 10

function headBandScripts(
  bandDefiningRows: ScoredVectorRow[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
): ScriptClass[] {
  const scripts = new Set<ScriptClass>()
  for (const { row } of bandDefiningRows.slice(0, HEAD_BAND_SCRIPT_SAMPLE)) {
    const content = index.get(`${row.source}:${row.key}`)
    if (content !== undefined) scripts.add(dominantScript(content.heading))
  }
  return [...scripts]
}

// Scores every store row against ALL query-chunk embeddings and keeps each row's
// MAX similarity (a row relevant to ANY chunk should rank high; mean would dilute
// it against unrelated chunks, sum would reward prompt length). Returns the merged
// `{ row, score }[]` in the same shape `store.queryScored` produced for a single
// query, plus the chunk index that produced each row's winning score — so the
// cross-script margin can be judged against the chunk that actually matched.
function maxScoreAcrossChunks(
  queryEmbeddings: Float32Array[],
  store: VectorStore,
): { scored: ScoredVectorRow[]; winnerChunkByRowId: Map<string, number> } {
  // Decode the compatible corpus ONCE and score every chunk against it, instead
  // of re-reading and re-decoding the whole table per chunk (queryScored did a
  // full SELECT + BLOB decode on each call). Same MAX-across-chunks result, but
  // the O(rows) decode runs once per turn instead of once per chunk.
  const dims = queryEmbeddings[0]?.length
  if (dims === undefined) return { scored: [], winnerChunkByRowId: new Map() }
  const rows = store.loadRows(EMBEDDING_MODEL_ID, dims)

  const best = new Map<string, { scored: ScoredVectorRow; chunkIndex: number }>()
  queryEmbeddings.forEach((embedding, chunkIndex) => {
    for (const scoredRow of scoreRows(rows, embedding)) {
      const existing = best.get(scoredRow.row.id)
      if (existing === undefined || scoredRow.score > existing.scored.score) {
        best.set(scoredRow.row.id, { scored: scoredRow, chunkIndex })
      }
    }
  })
  const scored = [...best.values()].map(({ scored: s }) => s).sort((a, b) => b.score - a.score)
  const winnerChunkByRowId = new Map([...best].map(([id, { chunkIndex }]) => [id, chunkIndex]))
  return { scored, winnerChunkByRowId }
}

// The single query script the cross-script margin is judged with, taken from the
// chunk that won the TOP-scoring band row. The gate's contrast is top1 minus the
// non-head median (`gateRelevance`), so the top row alone defines whether the
// margin loosens — a majority vote across the head would let a crowd of ambient
// same-script noise rows (each won by a framing chunk) override the cross-script
// payload chunk that actually won the real top match, keeping the margin strict
// and suppressing a genuine cross-script hit sitting in the compressed band.
function dominantQueryScript(
  bandDefiningRows: ScoredVectorRow[],
  winnerChunkByRowId: Map<string, number>,
  queryChunks: string[],
): ScriptClass {
  const topRow = bandDefiningRows[0]
  if (topRow === undefined) return 'other'
  const chunkIndex = winnerChunkByRowId.get(topRow.row.id)
  const chunk = chunkIndex === undefined ? undefined : queryChunks[chunkIndex]
  return chunk === undefined ? 'other' : dominantScript(chunk)
}

// Phrase-first, then token-OR fallback (mirrors `memory_search`). `hybridSearch`'s
// query is always the whole user prompt, which never appears verbatim in a shard,
// so a phrase-only lane returns nothing every real turn and RRF degenerates to the
// vector lane alone. The `searchAllRanked` fallback also gives RRF a
// matched-token-count rank (truncated after ranking) instead of alphabetical order.
function keywordLane(
  query: string,
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  references: Reference[],
  maxResults: number,
  provenanceIndex: ProvenanceIndex,
  scope: MemoryScope,
): MemorySearchMatch[] {
  const matcher = buildMatcher(query, false)
  if (typeof matcher === 'string') return []
  const topicDocuments = new Map(
    shards.map((shard) => [
      shard.slug,
      `${shard.slug}\n${shard.frontmatter.heading}\n${shard.body}\n${provenanceIndex.lexicalTextForTopic(shard.slug, scope)}`,
    ]),
  )
  const topicProvenance = new Map(
    shards.map((shard) => [shard.slug, provenanceIndex.childrenForTopic(shard.slug, scope)]),
  )
  const streamDocuments = new Map<string, string>()
  for (const day of streamDays) {
    for (const event of day.events) {
      if (event.type !== 'fragment') continue
      const citation = `streams/${day.date}#${event.id}`
      streamDocuments.set(
        citation,
        `${event.topic}\n${event.body}\n${provenanceIndex.lexicalTextForUndreamed(citation, scope)}`,
      )
    }
  }
  const phrase = searchAll(shards, streamDays, matcher, {
    full: false,
    maxResults,
    references,
    topicDocuments,
    topicProvenance,
    streamDocuments,
  })
  const phraseMatches = 'matches' in phrase ? phrase.matches : []
  if (phraseMatches.length > 0) return phraseMatches

  const tokens = distinctHybridContentTokens(query)
  if (tokens.length === 0) return []
  if (tokens.length === 1 && tokens[0] === query.trim().toLowerCase()) return []
  const ranked = searchAllRanked(shards, streamDays, tokens, {
    full: false,
    maxResults,
    references,
    tokenMatchMode: 'ascii-boundary',
    topicDocuments,
    topicProvenance,
    streamDocuments,
  })
  return 'matches' in ranked ? ranked.matches : []
}

// Stopwords are judged ONLY against a token's ASCII-alpha core (below), so this
// set is intentionally English-only — non-ASCII tokens never reach it.
const HYBRID_PROMPT_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'i',
  'me',
  'my',
  'mine',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'we',
  'us',
  'our',
  'ours',
  'they',
  'them',
  'their',
  'theirs',
  'this',
  'that',
  'these',
  'those',
  'here',
  'there',
  'what',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'how',
  'which',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'having',
  'can',
  'could',
  'should',
  'would',
  'will',
  'may',
  'might',
  'must',
  'about',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'onto',
  'to',
  'with',
  'without',
  'over',
  'under',
  'after',
  'before',
  'between',
  'up',
  'down',
  'out',
  'off',
  'say',
  'said',
  'thing',
  'things',
  'stuff',
])

// The hybrid lane's query is a whole user prompt, so its tokens include
// function words ('what', 'we', 'the', 'about'). Token-OR matching on those
// alone would make the keyword lane non-empty for a low-information prompt and,
// when the vector lane is gated out, inject arbitrary memory instead of no
// result. The tool path's `distinctTokens` stays untouched — there the query is
// a deliberate agent search, not a sentence. Stopwords are judged ONLY on a
// token's ASCII-alpha core, so non-ASCII tokens ('홍길동'), numerics ('#651'),
// and short content words ('pr', 'ci', 'go') all survive; no length filter,
// which would wrongly drop CJK and short content.
function distinctHybridContentTokens(query: string): string[] {
  return distinctTokens(query).filter((token) => {
    const core = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    if (core.length === 0) return hasNonAscii(token)
    if (!/^[a-z]+$/.test(core)) return true
    return !HYBRID_PROMPT_STOPWORDS.has(core)
  })
}

// Reciprocal Rank Fusion across two rankers (vector + keyword). Each lane is
// collapsed to per-parent scores INDEPENDENTLY (MAX over a parent's children
// within that lane), then the two lanes' per-parent scores are SUMMED. The two
// reductions are different on purpose:
//
//   - WITHIN a lane, a topic's children (the fragments citing it) collapse by
//     MAX — summing would over-rank often-revised topics purely for having more
//     historical citations to match (PARADE: max beats sum for concentrated
//     relevance).
//   - ACROSS lanes, the per-parent contributions SUM — cross-ranker agreement
//     is the entire signal RRF exists to capture. A topic found by BOTH the
//     vector and the keyword lane must outrank one found by a single lane, so
//     its score is 1/(k+rankVector) + 1/(k+rankKeyword). Collapsing both lanes
//     into one map and taking MAX (the previous behavior) discarded that
//     agreement, leaving every result carrying a single lane's reciprocal rank.
function fuseLanes(
  vectorRows: VectorRow[],
  keywordMatches: MemorySearchMatch[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): HybridSearchResult[] {
  const vectorLane = collapseLane(
    vectorRows.map((row, i) => ({ source: row.source, key: row.key, score: 1 / (RRF_K + i + 1) })),
    index,
    parentSlugsByFragmentId,
  )
  const keywordLane = collapseLane(
    keywordMatches.map((match, i) => ({ source: match.source, key: matchKey(match), score: 1 / (RRF_K + i + 1) })),
    index,
    parentSlugsByFragmentId,
  )

  const fused = new Map<string, HybridSearchResult>()
  for (const lane of [vectorLane, keywordLane]) {
    for (const [fusedKey, { content, score }] of lane) {
      const existing = fused.get(fusedKey)
      if (existing !== undefined) existing.rrfScore += score
      else fused.set(fusedKey, { ...content, rrfScore: score })
    }
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.key.localeCompare(b.key))
}

type LaneHit = { source: 'topic' | 'stream' | 'reference'; key: string; score: number }
type LaneEntry = { content: Omit<HybridSearchResult, 'rrfScore'>; score: number }

// Returns one lane's per-parent scores so the caller can SUM across lanes;
// folding straight into a shared map would force a cross-lane MAX instead.
function collapseLane(
  hits: LaneHit[],
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): Map<string, LaneEntry> {
  const lane = new Map<string, LaneEntry>()
  for (const hit of hits) {
    for (const { fusedKey, content } of resolveToParents(hit.source, hit.key, index, parentSlugsByFragmentId)) {
      const existing = lane.get(fusedKey)
      if (existing !== undefined) existing.score = Math.max(existing.score, hit.score)
      else lane.set(fusedKey, { content, score: hit.score })
    }
  }
  return lane
}

// A matched fragment collapses to EVERY topic that cites it (a fragment can back
// more than one belief), so it contributes its score to each parent. An
// undreamed fragment with no citing topic resolves to itself.
function resolveToParents(
  source: 'topic' | 'stream' | 'reference',
  nodeKey: string,
  index: Map<string, Omit<HybridSearchResult, 'rrfScore'>>,
  parentSlugsByFragmentId: Map<string, Set<string>>,
): Array<{ fusedKey: string; content: Omit<HybridSearchResult, 'rrfScore'> }> {
  if (source === 'reference') {
    const slug = referenceSlugFromKey(nodeKey)
    const content = index.get(laneKey('reference', slug))
    return content === undefined ? [] : [{ fusedKey: laneKey('reference', slug), content }]
  }
  if (source === 'stream') {
    const fragmentId = fragmentIdFromKey(nodeKey)
    const parentSlugs = fragmentId === null ? undefined : parentSlugsByFragmentId.get(fragmentId)
    if (parentSlugs !== undefined && parentSlugs.size > 0) {
      const parents: Array<{ fusedKey: string; content: Omit<HybridSearchResult, 'rrfScore'> }> = []
      for (const parentSlug of parentSlugs) {
        const topic = index.get(laneKey('topic', parentSlug))
        if (topic !== undefined) parents.push({ fusedKey: laneKey('topic', parentSlug), content: topic })
      }
      if (parents.length > 0) return parents
    }
  }
  const content = index.get(laneKey(source, nodeKey))
  return content === undefined ? [] : [{ fusedKey: laneKey(source, nodeKey), content }]
}

function referenceSlugFromKey(referenceKey: string): string {
  const hashIndex = referenceKey.indexOf('#')
  return hashIndex === -1 ? referenceKey : referenceKey.slice(0, hashIndex)
}

function fragmentIdFromKey(streamKey: string): string | null {
  const hashIndex = streamKey.indexOf('#')
  if (hashIndex === -1) return null
  const id = streamKey.slice(hashIndex + 1)
  return id.startsWith('legacy-') ? null : id
}

// Superseded fragments are kept out of the content index entirely, so both
// lanes drop them: the keyword lane can match a superseded body, but resolving
// it finds no active parent link and then no `stream` fallback here, so the
// stale fragment never surfaces as a standalone result (mirrors the passage-set
// exclusion that keeps superseded fragments out of the vector lane).
function buildContentIndex(
  shards: TopicShard[],
  streamDays: UndreamedStreamDay[],
  references: Reference[],
  supersededFragmentIds: Set<string>,
  provenanceIndex: ProvenanceIndex,
  scope: MemoryScope,
): Map<string, Omit<HybridSearchResult, 'rrfScore'>> {
  const index = new Map<string, Omit<HybridSearchResult, 'rrfScore'>>()
  const undreamedByCitation = new Map(provenanceIndex.undreamedChildren(scope).map((child) => [child.citation, child]))

  for (const shard of shards) {
    const provenance = provenanceIndex.childrenForTopic(shard.slug, scope)
    index.set(laneKey('topic', shard.slug), {
      source: 'topic',
      key: shard.slug,
      heading: shard.frontmatter.heading,
      excerpt: excerpt(shard.body, shard.frontmatter.heading),
      ...(provenance.length > 0 ? { provenance } : {}),
    })
  }

  for (const day of streamDays) {
    for (const event of day.events) {
      const item = streamIndexItem(day, event, supersededFragmentIds, undreamedByCitation)
      if (item !== null) index.set(laneKey('stream', item.key), item)
    }
  }

  for (const reference of references) {
    if (reference.frontmatter.demoted) continue
    index.set(laneKey('reference', reference.slug), {
      source: 'reference',
      key: reference.slug,
      heading: reference.frontmatter.title,
      excerpt: excerpt(reference.body, reference.frontmatter.title),
    })
  }

  return index
}

function hasScope(scope: MemoryScope): boolean {
  return scope.workspace !== undefined || scope.chat !== undefined || scope.thread !== undefined
}

function streamIndexItem(
  day: UndreamedStreamDay,
  event: StreamEvent,
  supersededFragmentIds: Set<string>,
  undreamedByCitation: Map<string, ProvenanceChild>,
): Omit<HybridSearchResult, 'rrfScore'> | null {
  if (event.type === 'watermark') return null
  if (event.type === 'fragment') {
    if (supersededFragmentIds.has(event.id)) return null
    const item: Omit<HybridSearchResult, 'rrfScore'> = {
      source: 'stream',
      key: `${day.date}#${event.id}`,
      heading: event.topic,
      excerpt: excerpt(event.body, event.topic),
      when: event.ts,
    }
    const child = undreamedByCitation.get(`streams/${day.date}#${event.id}`)
    if (child?.who !== undefined) item.who = child.who
    if (child?.where !== undefined) item.where = child.where
    return item
  }
  return {
    source: 'stream',
    key: `${day.date}#legacy-${hashContent(event.text).slice(0, 12)}`,
    heading: '[legacy prose from pre-shard migration]',
    excerpt: excerpt(event.text, '[legacy prose from pre-shard migration]'),
  }
}

function matchKey(match: MemorySearchMatch): string {
  if (match.source === 'topic') return match.slug
  if (match.source === 'reference') return match.slug
  return streamMatchKey(match)
}

function streamMatchKey(match: StreamMatch): string {
  if (match.eventId !== undefined) return match.eventId.replace(/^streams\//, '')
  return `${match.date}#legacy-${hashContent(match.excerpt).slice(0, 12)}`
}

function laneKey(source: 'topic' | 'stream' | 'reference', key: string): string {
  return `${source}:${key}`
}

function excerpt(body: string, fallback: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return fallback
  return trimmed.split('\n').slice(0, 7).join('\n')
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
