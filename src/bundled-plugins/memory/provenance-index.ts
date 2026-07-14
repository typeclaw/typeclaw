import type { AdapterId } from '@/channels/schema'

import { formatCitation, splitCitationRefsBySection } from './citations'
import { loadAllShards, type TopicShard } from './load-shards'
import { isSafeProvenanceCoordinate, sanitizeProvenanceName } from './provenance-sanitize'
import type { FragmentEvent, FragmentProvenance } from './stream-events'
import { readAllStreamDays, type StreamDay } from './stream-io'

const MAX_COORDINATES = 20_000
const MAX_ALIASES = 12
const DEFAULT_BUILD_TIMEOUT_MS = 250

export type ProvenanceChild = {
  citation: string
  resolved: boolean
  dreamed?: boolean
  who?: string
  when?: string
  where?: FragmentProvenance
}

export type MemoryScope = {
  workspace?: string
  chat?: string
  thread?: string
}

type AliasRecord = { names: string[]; parentChat?: string; parentChatNames: string[]; parentChecked?: boolean }
type RegistryEntry = { kind: 'workspace' | 'chat'; key: string }
type ProvenanceRegistry = {
  workspaces: Record<string, string[]>
  chats: Record<string, AliasRecord>
  entryCount: number
  recency: Map<string, RegistryEntry>
}
type RegistryRecency = { recencyKey: string; entry: RegistryEntry }
type NewestFirstLearningBatch = {
  protectedEntries: Set<string>
  recencyGroups: RegistryRecency[][]
  aliases: Map<string, { values: string[]; original: string[]; seen: Set<string>; observed: string[] }>
}

export type ProvenanceIndexOptions = {
  timeoutMs?: number
  now?: () => number
}

export type HistoricalProvenanceResolution = { where: FragmentProvenance; parentChecked: boolean }
export type HistoricalProvenanceResolver = (where: FragmentProvenance) => Promise<HistoricalProvenanceResolution>

export type HistoricalProvenanceEnrichmentResult = {
  scanned: number
  attempted: number
  resolved: number
  failed: number
  timedOut: number
  changed: boolean
}

export type HistoricalProvenanceEnrichmentOptions = {
  maxOrigins?: number
  timeoutMs?: number
  perOriginTimeoutMs?: number
}

const runtimeRegistries = new Map<string, ProvenanceRegistry>()

export class ProvenanceIndex {
  readonly #childrenByTopic: Map<string, ProvenanceChild[]>
  readonly #undreamed: ProvenanceChild[]
  readonly #undreamedByCitation: Map<string, ProvenanceChild>
  readonly #registry: ProvenanceRegistry
  readonly #activeCitations: Set<string>
  readonly #supersededCitations: Set<string>

  constructor(
    childrenByTopic: Map<string, ProvenanceChild[]>,
    undreamed: ProvenanceChild[],
    registry: ProvenanceRegistry,
    activeCitations: Set<string>,
    supersededCitations: Set<string>,
  ) {
    this.#childrenByTopic = childrenByTopic
    this.#undreamed = undreamed
    this.#undreamedByCitation = new Map(undreamed.map((child) => [child.citation, child]))
    this.#registry = registry
    this.#activeCitations = activeCitations
    this.#supersededCitations = supersededCitations
  }

  childrenForTopic(slug: string, scope: MemoryScope = {}): ProvenanceChild[] {
    return (this.#childrenByTopic.get(slug) ?? []).filter((child) => childMatchesScope(child, scope, this.#registry))
  }

  undreamedChildren(scope: MemoryScope = {}): ProvenanceChild[] {
    return this.#undreamed.filter((child) => childMatchesScope(child, scope, this.#registry))
  }

  topicEligible(slug: string, scope: MemoryScope): boolean {
    if (!hasScope(scope)) return true
    return this.childrenForTopic(slug, scope).some((child) => child.resolved)
  }

  lexicalTextForTopic(slug: string, scope: MemoryScope = {}): string {
    return this.childrenForTopic(slug, scope)
      .flatMap((child) => lexicalParts(child, this.#registry))
      .join('\n')
  }

  lexicalTextForUndreamed(citation: string, scope: MemoryScope = {}): string {
    const child = this.undreamedChild(citation, scope)
    return child === undefined ? '' : lexicalParts(child, this.#registry).join('\n')
  }

  undreamedChild(citation: string, scope: MemoryScope = {}): ProvenanceChild | undefined {
    const child = this.#undreamedByCitation.get(citation)
    return child !== undefined && childMatchesScope(child, scope, this.#registry) ? child : undefined
  }

  isActivelyCited(citation: string): boolean {
    return this.#activeCitations.has(citation)
  }

  isSuperseded(citation: string): boolean {
    return this.#supersededCitations.has(citation) && !this.#activeCitations.has(citation)
  }
}

export async function buildProvenanceIndex(
  agentDir: string,
  options: ProvenanceIndexOptions = {},
): Promise<ProvenanceIndex> {
  const [shards, days] = await Promise.all([loadAllShards(agentDir), readAllStreamDays(agentDir)])
  return await buildProvenanceIndexFrom(agentDir, shards, days, options)
}

export async function buildProvenanceIndexFrom(
  agentDir: string,
  shards: TopicShard[],
  days: StreamDay[],
  options: ProvenanceIndexOptions = {},
): Promise<ProvenanceIndex> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS)
  const fragments = new Map<string, { event: FragmentEvent; date: string; dreamed: boolean }>()
  const coordinates: FragmentProvenance[] = []

  for (const day of days) {
    for (const event of day.events) {
      if (event.type !== 'fragment') continue
      const citation = formatCitation(day.date, event.id)
      fragments.set(citation, { event, date: day.date, dreamed: day.dreamedIds.has(event.id) })
    }
  }

  for (let dayIndex = days.length - 1; dayIndex >= 0 && coordinates.length < MAX_COORDINATES; dayIndex--) {
    const events = days[dayIndex]!.events
    for (let eventIndex = events.length - 1; eventIndex >= 0 && coordinates.length < MAX_COORDINATES; eventIndex--) {
      const event = events[eventIndex]!
      if (event.type === 'fragment' && event.where !== undefined) coordinates.push(event.where)
    }
  }

  const registry = registryFor(agentDir)
  const learningBatch = createNewestFirstLearningBatch()
  for (let index = 0; index < coordinates.length; index++) {
    if (now() > deadline) break
    learnWhere(registry, coordinates[index]!, learningBatch)
  }
  finalizeNewestFirstLearningBatch(registry, learningBatch)

  const childrenByTopic = new Map<string, ProvenanceChild[]>()
  const activelyCited = new Set<string>()
  const supersededCitations = new Set<string>()
  for (const shard of shards) {
    const { active, superseded } = splitCitationRefsBySection(shard.body)
    for (const citation of superseded) supersededCitations.add(formatCitation(citation.date, citation.fragmentId))
    const children = active
      .map((citation): ProvenanceChild => {
        const canonical = formatCitation(citation.date, citation.fragmentId)
        activelyCited.add(canonical)
        const source = fragments.get(canonical)
        if (source === undefined) return { citation: canonical, resolved: false }
        return childFromFragment(canonical, source.event, source.dreamed, registry)
      })
      .sort(compareChildren)
    childrenByTopic.set(shard.slug, children)
  }

  const undreamed = [...fragments]
    .filter(([, source]) => !source.dreamed)
    .map(([citation, source]) => childFromFragment(citation, source.event, false, registry))
    .sort(compareChildren)

  return new ProvenanceIndex(childrenByTopic, undreamed, registry, activelyCited, supersededCitations)
}

export async function enrichHistoricalProvenance(
  agentDir: string,
  resolve: HistoricalProvenanceResolver,
  options: HistoricalProvenanceEnrichmentOptions = {},
): Promise<HistoricalProvenanceEnrichmentResult> {
  const maxOrigins = options.maxOrigins ?? 100
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const perOriginTimeoutMs = options.perOriginTimeoutMs ?? 1_500
  const days = await readAllStreamDays(agentDir)
  const registry = registryFor(agentDir)
  const candidates = new Map<string, FragmentProvenance>()

  for (let dayIndex = days.length - 1; dayIndex >= 0; dayIndex--) {
    const events = days[dayIndex]!.events
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex--) {
      const event = events[eventIndex]!
      if (event.type !== 'fragment' || (event.where?.adapter !== 'discord' && event.where?.adapter !== 'discord-bot'))
        continue
      const where = event.where
      if (where.workspace === '@dm') continue
      if (!needsResolverEnrichment(where, registry)) continue
      if (candidates.size >= maxOrigins) break
      candidates.set(chatKey(where), where)
    }
    if (candidates.size >= maxOrigins) break
  }

  let attempted = 0
  let resolved = 0
  let failed = 0
  let timedOut = 0
  const resolutions: HistoricalProvenanceResolution[] = []
  for (const where of candidates.values()) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      timedOut += 1
      break
    }
    attempted += 1
    const outcome = await settleWithin(resolve(where), Math.min(perOriginTimeoutMs, remainingMs))
    if (outcome.kind === 'timeout') {
      timedOut += 1
      continue
    }
    if (outcome.kind === 'error' || !sameCoordinates(where, outcome.value.where)) {
      failed += 1
      continue
    }
    const resolution = sanitizeResolution(outcome.value)
    if (!resolutionAddsData(where, resolution, registry)) {
      failed += 1
      continue
    }
    resolutions.push(resolution)
    resolved += 1
  }

  const before = JSON.stringify(registry)
  for (const resolution of resolutions) applyResolution(registry, resolution)
  const changed = JSON.stringify(registry) !== before
  return { scanned: candidates.size, attempted, resolved, failed, timedOut, changed }
}

function childFromFragment(
  citation: string,
  event: FragmentEvent,
  dreamed: boolean,
  sidecar: ProvenanceRegistry,
): ProvenanceChild {
  const child: ProvenanceChild = { citation, resolved: true, ...(dreamed ? { dreamed: true } : {}), when: event.ts }
  const who = sanitizeProvenanceName(event.who)
  if (who !== undefined) child.who = who
  if (event.where !== undefined) child.where = enrichWhere(event.where, sidecar)
  return child
}

function compareChildren(a: ProvenanceChild, b: ProvenanceChild): number {
  return a.citation.localeCompare(b.citation)
}

function hasScope(scope: MemoryScope): boolean {
  return scope.workspace !== undefined || scope.chat !== undefined || scope.thread !== undefined
}

function childMatchesScope(child: ProvenanceChild, scope: MemoryScope, sidecar: ProvenanceRegistry): boolean {
  if (!hasScope(scope)) return true
  if (!child.resolved || child.where === undefined) return false
  const where = child.where
  if (scope.workspace !== undefined && !matches(scope.workspace, workspaceValues(where, sidecar))) return false
  if (scope.chat !== undefined && !matches(scope.chat, chatValues(where, sidecar))) return false
  if (scope.thread !== undefined && !matches(scope.thread, threadValues(where, sidecar))) return false
  return true
}

function matches(needle: string, values: string[]): boolean {
  const normalized = normalize(needle)
  return values.some((value) => normalize(value) === normalized)
}

function normalize(value: string): string {
  return value.replace(/^#/, '').toLocaleLowerCase()
}

function workspaceValues(where: FragmentProvenance, sidecar: ProvenanceRegistry): string[] {
  return [
    where.workspace,
    ...(where.workspaceName === undefined ? [] : [where.workspaceName]),
    ...workspaceAliases(where, sidecar),
  ]
}

function chatValues(where: FragmentProvenance, sidecar: ProvenanceRegistry): string[] {
  const record = sidecar.chats[chatKey(where)]
  return [
    where.chat,
    ...(where.chatName === undefined ? [] : [where.chatName]),
    ...(where.parentChat === undefined ? [] : [where.parentChat]),
    ...(where.parentChatName === undefined ? [] : [where.parentChatName]),
    ...(record?.names ?? []),
    ...(record?.parentChatNames ?? []),
  ]
}

function threadValues(where: FragmentProvenance, sidecar: ProvenanceRegistry): string[] {
  const isThreadRoom = where.parentChat !== undefined || sidecar.chats[chatKey(where)]?.parentChat !== undefined
  return [
    ...(where.thread === null || where.thread === undefined ? [] : [where.thread]),
    ...(isThreadRoom ? [where.chat] : []),
  ]
}

function lexicalParts(child: ProvenanceChild, sidecar: ProvenanceRegistry): string[] {
  if (!child.resolved) return [child.citation, 'unresolved citation']
  const where = child.where
  return [
    child.citation,
    ...(child.who === undefined ? [] : [child.who]),
    ...(child.when === undefined ? [] : [child.when]),
    ...(where === undefined
      ? []
      : [...workspaceValues(where, sidecar), ...chatValues(where, sidecar), ...threadValues(where, sidecar)]),
  ]
}

function enrichWhere(where: FragmentProvenance, sidecar: ProvenanceRegistry): FragmentProvenance {
  const safeWhere = safeProvenanceNames(where)
  const workspaceNames = workspaceAliases(safeWhere, sidecar)
  const chat = sidecar.chats[chatKey(safeWhere)]
  return {
    ...safeWhere,
    ...(safeWhere.workspaceName === undefined && workspaceNames[0] !== undefined
      ? { workspaceName: workspaceNames[0] }
      : {}),
    ...(safeWhere.chatName === undefined && chat?.names[0] !== undefined ? { chatName: chat.names[0] } : {}),
    ...(safeWhere.parentChat === undefined && chat?.parentChat !== undefined ? { parentChat: chat.parentChat } : {}),
    ...(safeWhere.parentChatName === undefined && chat?.parentChatNames[0] !== undefined
      ? { parentChatName: chat.parentChatNames[0] }
      : {}),
  }
}

function safeProvenanceNames(where: FragmentProvenance): FragmentProvenance {
  const workspaceName = sanitizeProvenanceName(where.workspaceName)
  const chatName = sanitizeProvenanceName(where.chatName)
  const parentChatName = sanitizeProvenanceName(where.parentChatName)
  return {
    adapter: where.adapter,
    workspace: where.workspace,
    chat: where.chat,
    thread: where.thread,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    ...(chatName === undefined ? {} : { chatName }),
    ...(where.parentChat === undefined ? {} : { parentChat: where.parentChat }),
    ...(parentChatName === undefined ? {} : { parentChatName }),
  }
}

function learnWhere(sidecar: ProvenanceRegistry, where: FragmentProvenance, batch?: NewestFirstLearningBatch): boolean {
  if (![where.adapter, where.workspace, where.chat].every(isSafeProvenanceCoordinate)) return false
  const workspaceKey = `${where.adapter}\u0000${where.workspace}`
  const chatCoordinateKey = chatKey(where)
  const workspaceRecencyKey = registryRecencyKey('workspace', workspaceKey)
  const chatRecencyKey = registryRecencyKey('chat', chatCoordinateKey)
  const workspaceName = sanitizeProvenanceName(where.workspaceName)
  const protectedEntries = batch?.protectedEntries ?? new Set<string>()
  const recencyGroup: RegistryRecency[] = []
  if (sidecar.workspaces[workspaceKey] !== undefined) {
    touchLearnedRegistryEntry(
      sidecar,
      workspaceRecencyKey,
      { kind: 'workspace', key: workspaceKey },
      protectedEntries,
      recencyGroup,
      batch !== undefined,
    )
  }
  if (sidecar.chats[chatCoordinateKey] !== undefined) {
    touchLearnedRegistryEntry(
      sidecar,
      chatRecencyKey,
      { kind: 'chat', key: chatCoordinateKey },
      protectedEntries,
      recencyGroup,
      batch !== undefined,
    )
  }
  const newCoordinates =
    Number(workspaceName !== undefined && sidecar.workspaces[workspaceKey] === undefined) +
    Number(sidecar.chats[chatCoordinateKey] === undefined)
  if (!makeRegistryRoom(sidecar, newCoordinates, protectedEntries)) return false
  if (workspaceName !== undefined) {
    if (sidecar.workspaces[workspaceKey] === undefined) {
      sidecar.entryCount += 1
      touchLearnedRegistryEntry(
        sidecar,
        workspaceRecencyKey,
        { kind: 'workspace', key: workspaceKey },
        protectedEntries,
        recencyGroup,
        batch !== undefined,
      )
    }
    addAlias(sidecar.workspaces, workspaceKey, workspaceName, batch)
  }
  const record = sidecar.chats[chatCoordinateKey] ?? { names: [], parentChatNames: [] }
  if (sidecar.chats[chatCoordinateKey] === undefined) {
    sidecar.entryCount += 1
    touchLearnedRegistryEntry(
      sidecar,
      chatRecencyKey,
      { kind: 'chat', key: chatCoordinateKey },
      protectedEntries,
      recencyGroup,
      batch !== undefined,
    )
  }
  const chatName = sanitizeProvenanceName(where.chatName)
  const parentChatName = sanitizeProvenanceName(where.parentChatName)
  if (chatName !== undefined) observeAlias(record.names, chatName, batch, `chat\u0000${chatCoordinateKey}`)
  if (where.parentChat !== undefined && isSafeProvenanceCoordinate(where.parentChat)) {
    record.parentChat = where.parentChat
    record.parentChecked = true
  }
  if (parentChatName !== undefined)
    observeAlias(record.parentChatNames, parentChatName, batch, `parent-chat\u0000${chatCoordinateKey}`)
  sidecar.chats[chatCoordinateKey] = record
  if (batch !== undefined && recencyGroup.length > 0) batch.recencyGroups.push(recencyGroup)
  return true
}

function createNewestFirstLearningBatch(): NewestFirstLearningBatch {
  return { protectedEntries: new Set(), recencyGroups: [], aliases: new Map() }
}

function finalizeNewestFirstLearningBatch(sidecar: ProvenanceRegistry, batch: NewestFirstLearningBatch): void {
  for (const { values, original, seen, observed } of batch.aliases.values()) {
    const resolverOnly = original.filter((value) => !seen.has(value))
    values.splice(0, values.length, ...resolverOnly, ...observed)
    if (values.length > MAX_ALIASES) values.length = MAX_ALIASES
  }
  for (let groupIndex = batch.recencyGroups.length - 1; groupIndex >= 0; groupIndex--) {
    for (const { recencyKey, entry } of batch.recencyGroups[groupIndex]!) {
      touchRegistryEntry(sidecar, recencyKey, entry)
    }
  }
}

function touchLearnedRegistryEntry(
  sidecar: ProvenanceRegistry,
  recencyKey: string,
  entry: RegistryEntry,
  protectedEntries: Set<string>,
  recencyGroup: RegistryRecency[],
  newestFirst: boolean,
): void {
  if (newestFirst && protectedEntries.has(recencyKey)) return
  touchRegistryEntry(sidecar, recencyKey, entry)
  protectedEntries.add(recencyKey)
  if (newestFirst) recencyGroup.push({ recencyKey, entry })
}

function makeRegistryRoom(sidecar: ProvenanceRegistry, newCoordinates: number, protectedEntries: Set<string>): boolean {
  while (sidecar.entryCount + newCoordinates > MAX_COORDINATES) {
    let oldest: [string, RegistryEntry] | undefined
    for (const candidate of sidecar.recency) {
      if (!protectedEntries.has(candidate[0])) {
        oldest = candidate
        break
      }
    }
    if (oldest === undefined) return false
    const [recencyKey, entry] = oldest
    sidecar.recency.delete(recencyKey)
    if (entry.kind === 'workspace') delete sidecar.workspaces[entry.key]
    else delete sidecar.chats[entry.key]
    sidecar.entryCount -= 1
  }
  return true
}

function touchRegistryEntry(sidecar: ProvenanceRegistry, recencyKey: string, entry: RegistryEntry): void {
  sidecar.recency.delete(recencyKey)
  sidecar.recency.set(recencyKey, entry)
}

function registryRecencyKey(kind: RegistryEntry['kind'], key: string): string {
  return `${kind}\u0000${key}`
}

function needsResolverEnrichment(where: FragmentProvenance, sidecar: ProvenanceRegistry): boolean {
  const workspaceNames = workspaceAliases(where, sidecar)
  const chat = sidecar.chats[chatKey(where)]
  return (
    (where.workspaceName === undefined && workspaceNames.length === 0) ||
    (where.chatName === undefined && (chat?.names.length ?? 0) === 0) ||
    (where.parentChat === undefined && chat?.parentChecked !== true)
  )
}

function sameCoordinates(original: FragmentProvenance, resolved: FragmentProvenance): boolean {
  return (
    original.adapter === resolved.adapter &&
    original.workspace === resolved.workspace &&
    original.chat === resolved.chat &&
    (original.thread ?? null) === (resolved.thread ?? null)
  )
}

function resolutionAddsData(
  original: FragmentProvenance,
  resolution: HistoricalProvenanceResolution,
  sidecar: ProvenanceRegistry,
): boolean {
  const resolved = resolution.where
  const workspaceNames = workspaceAliases(original, sidecar)
  const chat = sidecar.chats[chatKey(original)]
  return (
    (resolved.workspaceName !== undefined && !workspaceNames.includes(resolved.workspaceName)) ||
    (resolved.chatName !== undefined && !(chat?.names.includes(resolved.chatName) ?? false)) ||
    (resolved.parentChat !== undefined && resolved.parentChat !== chat?.parentChat) ||
    (resolved.parentChatName !== undefined && !(chat?.parentChatNames.includes(resolved.parentChatName) ?? false)) ||
    (resolution.parentChecked && chat?.parentChecked !== true)
  )
}

function sanitizeResolution(resolution: HistoricalProvenanceResolution): HistoricalProvenanceResolution {
  const where = resolution.where
  const workspaceName = sanitizeProvenanceName(where.workspaceName)
  const chatName = sanitizeProvenanceName(where.chatName)
  const parentChatName = sanitizeProvenanceName(where.parentChatName)
  return {
    where: {
      adapter: where.adapter,
      workspace: where.workspace,
      chat: where.chat,
      thread: where.thread,
      ...(workspaceName === undefined ? {} : { workspaceName }),
      ...(chatName === undefined ? {} : { chatName }),
      ...(where.parentChat !== undefined && isSafeProvenanceCoordinate(where.parentChat)
        ? { parentChat: where.parentChat }
        : {}),
      ...(parentChatName === undefined ? {} : { parentChatName }),
    },
    parentChecked: resolution.parentChecked,
  }
}

function applyResolution(sidecar: ProvenanceRegistry, resolution: HistoricalProvenanceResolution): void {
  if (!learnWhere(sidecar, resolution.where)) return
  if (!resolution.parentChecked) return
  const record = sidecar.chats[chatKey(resolution.where)] ?? { names: [], parentChatNames: [] }
  record.parentChecked = true
  sidecar.chats[chatKey(resolution.where)] = record
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: 'value' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), Math.max(0, timeoutMs))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function workspaceAliases(where: FragmentProvenance, sidecar: ProvenanceRegistry): string[] {
  return sidecar.workspaces[`${where.adapter}\u0000${where.workspace}`] ?? []
}

function chatKey(where: FragmentProvenance): string {
  return `${where.adapter}\u0000${where.workspace}\u0000${where.chat}`
}

function addAlias(
  target: Record<string, string[]>,
  key: string,
  value: string,
  batch?: NewestFirstLearningBatch,
): void {
  const values = target[key] ?? []
  observeAlias(values, value, batch, `workspace\u0000${key}`)
  target[key] = values
}

function observeAlias(
  values: string[],
  value: string,
  batch: NewestFirstLearningBatch | undefined,
  aliasKey: string,
): void {
  if (batch === undefined) {
    const existingIndex = values.indexOf(value)
    if (existingIndex >= 0) values.splice(existingIndex, 1)
    values.unshift(value)
    if (values.length > MAX_ALIASES) values.pop()
    return
  }

  const state = batch.aliases.get(aliasKey) ?? {
    values,
    original: [...values],
    seen: new Set<string>(),
    observed: [],
  }
  if (state.seen.has(value)) return
  state.seen.add(value)
  state.observed.push(value)
  batch.aliases.set(aliasKey, state)
}

function registryFor(agentDir: string): ProvenanceRegistry {
  let registry = runtimeRegistries.get(agentDir)
  if (registry === undefined) {
    registry = { workspaces: {}, chats: {}, entryCount: 0, recency: new Map() }
    runtimeRegistries.set(agentDir, registry)
  }
  return registry
}
