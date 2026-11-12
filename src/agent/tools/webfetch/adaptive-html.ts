import { walkHtmlLexically } from './html-lexical'
import type { ReadabilityDetailedResult } from './strategies/readability'
import { applyReadabilityIsolated } from './strategies/readability-process'
import type { HtmlExtractionAttempt } from './types'

export type AdaptiveHtmlResult =
  | { kind: 'success'; output: string; attempts: HtmlExtractionAttempt[] }
  | { kind: 'error'; message: string; attempts: HtmlExtractionAttempt[] }

type AdaptiveHtmlDependencies = {
  applyReadabilityDetailed: (html: string, url: string, signal?: AbortSignal) => Promise<ReadabilityDetailedResult>
}

export const MAX_ADAPTIVE_HTML_SCAN_BYTES = 5 * 1024 * 1024
export const MAX_ADAPTIVE_HTML_TAG_COUNT = 20_000
export const MAX_ADAPTIVE_HTML_NESTING_DEPTH = 256
export const MAX_ADAPTIVE_HTML_ATTRIBUTES_PER_TAG = 1_024
export const MAX_ADAPTIVE_HTML_START_TAG_CHARS = 64 * 1024

const MAX_JSON_LD_SCAN_BYTES = 1_000_000
const MAX_JSON_LD_BLOCKS = 32
const MAX_JSON_LD_BLOCK_BYTES = 256_000
const MAX_JSON_LD_VALUE_CHARS = 200_000
const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting'])
const EMPTY_READABILITY_OUTPUT = 'Readability extracted no content from this page.'
const COMPLEXITY_LIMIT_REASON = 'adaptive HTML complexity limit exceeded'
const MALFORMED_HTML_REASON = 'adaptive HTML structure could not be validated'
// A bounded character floor accepts substantial script-free fallback while keeping short chrome fail-closed.
const SUBSTANTIAL_VISIBLE_TEXT_CHARACTERS = 512
const ENCODER = new TextEncoder()

export async function extractAdaptiveHtml(
  html: string,
  url: string,
  dependencies: AdaptiveHtmlDependencies = { applyReadabilityDetailed: applyReadabilityIsolated },
  signal?: AbortSignal,
): Promise<AdaptiveHtmlResult> {
  const attempts: HtmlExtractionAttempt[] = []

  const complexity = validateAdaptiveHtmlComplexity(html)
  if (!complexity.valid) {
    attempts.push({ route: 'readability', outcome: 'error', reason: complexity.reason })
  } else {
    try {
      const readability = await dependencies.applyReadabilityDetailed(html, url, signal)
      const verdict = classifyReadability(readability)
      if (verdict.useful) {
        attempts.push({ route: 'readability', outcome: 'success', reason: verdict.reason })
        return { kind: 'success', output: readability.output, attempts }
      }
      attempts.push({ route: 'readability', outcome: 'unusable', reason: verdict.reason })
    } catch {
      attempts.push({ route: 'readability', outcome: 'error', reason: 'Readability extraction failed' })
    }
  }

  try {
    const output = extractJsonLdArticle(html)
    if (output !== null) {
      attempts.push({ route: 'json_ld', outcome: 'success', reason: 'extracted schema.org article content' })
      return { kind: 'success', output, attempts }
    }
    attempts.push({ route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' })
  } catch {
    attempts.push({ route: 'json_ld', outcome: 'error', reason: 'schema.org extraction failed' })
  }

  const extractorFailed = attempts.some(({ outcome }) => outcome === 'error')
  return {
    kind: 'error',
    message: extractorFailed
      ? 'An HTML extractor failed, and no public article content was recovered. Browser retrieval may be needed.'
      : 'Fetched HTML did not contain public article content. The page may require client-side rendering or access controls; browser retrieval may be needed.',
    attempts,
  }
}

export type AdaptiveHtmlComplexityResult = { valid: true } | { valid: false; reason: string }

export function validateAdaptiveHtmlComplexity(html: string): AdaptiveHtmlComplexityResult {
  if (byteLength(html) > MAX_ADAPTIVE_HTML_SCAN_BYTES) return complexityFailure()
  const result = walkHtmlLexically(html, {
    maxTags: MAX_ADAPTIVE_HTML_TAG_COUNT,
    maxDepth: MAX_ADAPTIVE_HTML_NESTING_DEPTH,
    maxAttributesPerTag: MAX_ADAPTIVE_HTML_ATTRIBUTES_PER_TAG,
    maxStartTagChars: MAX_ADAPTIVE_HTML_START_TAG_CHARS,
  })
  if (result.valid) return result
  return result.failure === 'limit' ? complexityFailure() : { valid: false, reason: MALFORMED_HTML_REASON }
}

export function scanJsonLdScripts(html: string): string[] {
  if (byteLength(html) > MAX_ADAPTIVE_HTML_SCAN_BYTES) return []
  const payloadCharacterLimit = sliceByBytes(html, MAX_JSON_LD_SCAN_BYTES).length
  const blocks: string[] = []
  let embeddedStylesheetSeen = false
  let inspected = 0
  const result = walkHtmlLexically(html, {
    maxTags: MAX_ADAPTIVE_HTML_TAG_COUNT,
    maxDepth: MAX_ADAPTIVE_HTML_NESTING_DEPTH,
    maxAttributesPerTag: MAX_ADAPTIVE_HTML_ATTRIBUTES_PER_TAG,
    maxStartTagChars: MAX_ADAPTIVE_HTML_START_TAG_CHARS,
    onStartTag: ({ name }) => {
      if (name === 'style') embeddedStylesheetSeen = true
    },
    onRawElement: (element) => {
      if (element.name === 'style') return
      if (
        element.name !== 'script' ||
        element.metadataSuppressed ||
        element.typeAttribute !== 'application/ld+json' ||
        element.bodyEnd > payloadCharacterLimit ||
        inspected >= MAX_JSON_LD_BLOCKS
      ) {
        return
      }
      inspected++
      const source = html.slice(element.bodyStart, element.bodyEnd).trim()
      if (source && byteLength(source) <= MAX_JSON_LD_BLOCK_BYTES) blocks.push(source)
    },
  })
  return result.valid && !embeddedStylesheetSeen ? blocks : []
}

function classifyReadability(result: ReadabilityDetailedResult): { useful: boolean; reason: string } {
  if (result.output === EMPTY_READABILITY_OUTPUT)
    return { useful: false, reason: 'Readability found no visible content' }

  const hasClearContent =
    result.parsedArticle &&
    (result.hasSemanticContentContainer || result.hasArticleContainer || result.proseElementCount > 0)
  if (hasClearContent) {
    return { useful: true, reason: 'Readability identified article content' }
  }

  if (result.visibleTextCharacterCount >= SUBSTANTIAL_VISIBLE_TEXT_CHARACTERS) {
    return { useful: true, reason: 'generic body fallback contained substantial visible content' }
  }

  const scriptRenderedShell =
    !result.hasSemanticContentContainer &&
    result.scriptCount >= 2 &&
    (result.structuredContentElementCount > 0 || result.scriptCount >= 3)

  if (scriptRenderedShell) {
    return { useful: false, reason: 'generic body fallback looked like a script-rendered shell' }
  }

  if (result.parsedArticle && result.structuredContentElementCount > 0) {
    return { useful: true, reason: 'Readability identified article content' }
  }

  if (result.parsedArticle) {
    return { useful: false, reason: 'Readability identified only unstructured page chrome' }
  }

  return { useful: false, reason: 'generic body fallback contained only short visible content' }
}

function complexityFailure(): AdaptiveHtmlComplexityResult {
  return { valid: false, reason: COMPLEXITY_LIMIT_REASON }
}

function extractJsonLdArticle(html: string): string | null {
  for (const source of scanJsonLdScripts(html)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      continue
    }
    for (const candidate of articleCandidates(parsed)) {
      const headline = plainText(candidate.headline)
      const body = plainText(candidate.articleBody) || plainText(candidate.description)
      if (!body) continue
      return headline ? `# ${escapeMarkdownHeading(headline)}\n\n${body}` : body
    }
  }
  return null
}

function articleCandidates(value: unknown, depth = 0, inheritedContext?: unknown): Array<Record<string, unknown>> {
  if (depth > 4) return []
  if (Array.isArray(value)) return value.flatMap((item) => articleCandidates(item, depth + 1, inheritedContext))
  if (!isRecord(value)) return []

  const context = Object.hasOwn(value, '@context') ? value['@context'] : inheritedContext
  const candidates = isArticleType(value['@type'], context) ? [value] : []
  const graph = value['@graph']
  if (graph !== undefined) candidates.push(...articleCandidates(graph, depth + 1, context))
  return candidates
}

function isArticleType(value: unknown, context: unknown): boolean {
  const values = Array.isArray(value) ? value : [value]
  return values.some((item) => {
    if (typeof item !== 'string') return false
    const absoluteSchemaType = schemaOrgName(item)
    if (absoluteSchemaType !== null) return ARTICLE_TYPES.has(absoluteSchemaType)
    if (context === undefined) return ARTICLE_TYPES.has(item)
    const resolved = resolveContextType(item, context)
    return resolved !== null && ARTICLE_TYPES.has(resolved)
  })
}

function schemaOrgName(value: string): string | null {
  const match = /^https?:\/\/schema\.org\/(?:[^/#]+[/#])?([^/#]+)$/iu.exec(value)
  return match?.[1] ?? null
}

function resolveContextType(type: string, context: unknown, depth = 0): string | null {
  return resolveContextDefinition(type, context, depth).value
}

function resolveContextDefinition(
  type: string,
  context: unknown,
  depth: number,
): { defined: boolean; value: string | null } {
  if (depth > 4) return { defined: false, value: null }
  if (context === null) return { defined: true, value: null }
  if (typeof context === 'string') {
    return { defined: true, value: isSchemaOrgBase(context) && ARTICLE_TYPES.has(type) ? type : null }
  }
  if (Array.isArray(context)) {
    for (let index = context.length - 1; index >= 0; index--) {
      const resolution = resolveContextDefinition(type, context[index], depth + 1)
      if (resolution.defined) return resolution
    }
    return { defined: false, value: null }
  }
  if (!isRecord(context)) return { defined: false, value: null }

  const termDefined = Object.hasOwn(context, type)
  const term = context[type]
  const termId = typeof term === 'string' ? term : isRecord(term) ? term['@id'] : undefined
  if (termDefined) {
    const absolute = typeof termId === 'string' ? schemaOrgName(termId) : null
    return { defined: true, value: absolute }
  }

  const separator = type.indexOf(':')
  if (separator > 0) {
    const prefixName = type.slice(0, separator)
    if (!Object.hasOwn(context, prefixName)) return { defined: false, value: null }
    const prefix = context[prefixName]
    const prefixId = typeof prefix === 'string' ? prefix : isRecord(prefix) ? prefix['@id'] : undefined
    return {
      defined: true,
      value: typeof prefixId === 'string' && isSchemaOrgBase(prefixId) ? type.slice(separator + 1) : null,
    }
  }

  if (!Object.hasOwn(context, '@vocab')) return { defined: false, value: null }
  const vocabulary = context['@vocab']
  return {
    defined: true,
    value: typeof vocabulary === 'string' && isSchemaOrgBase(vocabulary) ? type : null,
  }
}

function isSchemaOrgBase(value: string): boolean {
  return /^https?:\/\/schema\.org\/?$/iu.test(value)
}

function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return stripTags(value.slice(0, MAX_JSON_LD_VALUE_CHARS))
    .replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function stripTags(value: string): string {
  const output: string[] = []
  let copiedThrough = 0
  let cursor = 0
  while (cursor < value.length) {
    if (value[cursor] !== '<') {
      cursor++
      continue
    }
    output.push(value.slice(copiedThrough, cursor))
    const candidateStart = cursor
    cursor++
    while (cursor < value.length && value[cursor] !== '>') cursor++
    if (cursor >= value.length) {
      output.push(value.slice(candidateStart))
      copiedThrough = value.length
      break
    }
    output.push(' ')
    cursor++
    copiedThrough = cursor
  }
  if (copiedThrough < value.length) output.push(value.slice(copiedThrough))
  return output.join('')
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+.!|>-])/gu, '\\$1')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function byteLength(value: string): number {
  return ENCODER.encode(value).byteLength
}

function sliceByBytes(value: string, maxBytes: number): string {
  const bytes = ENCODER.encode(value)
  if (bytes.byteLength <= maxBytes) return value
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes))
}
