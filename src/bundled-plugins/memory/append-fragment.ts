import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ToolContext } from '@/plugin'

import { fragmentContentHash } from './fragment-parser'
import { sanitizeProvenanceName } from './provenance-sanitize'
import { detectSecrets } from './secret-detector'
import { newEventId, timestampFromId, type FragmentEvent, type FragmentProvenance } from './stream-events'
import { appendEvents, readEvents, type FragmentsAppendedContext } from './stream-io'

export type FragmentsAppendedHook = (fragments: FragmentEvent[], context: FragmentsAppendedContext) => Promise<void>
export type ReferenceSlugResolver = (agentDir: string) => Promise<Iterable<string>>

type FragmentInput = {
  readonly topic: string
  readonly body: string
  readonly source: string
  readonly entry: string
  readonly references?: string[] | undefined
  readonly who?: string | undefined
  readonly kind?: 'explicit'
}

type AppendFragmentOptions = {
  readonly path: string
  readonly where?: FragmentProvenance | undefined
  readonly watermarkEntry?: string | undefined
  readonly onFragmentsAppended?: FragmentsAppendedHook | undefined
  readonly referenceSlugResolver?: ReferenceSlugResolver | undefined
  // Runs only after credential and duplicate checks, before the fragment write.
  readonly storeReference?: () => Promise<string>
}

export async function appendFragment(input: FragmentInput, ctx: ToolContext, options: AppendFragmentOptions) {
  const { topic, body, source, entry, references, who } = input
  const { path, where, onFragmentsAppended, referenceSlugResolver } = options
  assertNoSecrets([topic, body, who])

  const hash = fragmentContentHash({ topic, body })
  const events = await readEvents(path)
  const duplicate = events
    .filter((event) => event.type === 'fragment')
    .find((event) => fragmentContentHash(event) === hash)
  if (duplicate !== undefined) {
    throw new Error(
      `Refusing to append: fragment "${duplicate.topic}" already exists in ${path} with byte-equivalent content. ` +
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
  const storedReference = await options.storeReference?.()
  const validReferences = await resolveValidReferences(
    storedReference === undefined ? references : [...(references ?? []), storedReference],
    referenceSlugResolver,
    ctx,
  )
  if (validReferences.length > 0) fragment.references = validReferences
  const safeWho = sanitizeProvenanceName(who)
  if (safeWho !== undefined) fragment.who = safeWho
  if (where !== undefined) fragment.where = where
  if (input.kind !== undefined) fragment.kind = input.kind
  const watermark = {
    type: 'watermark' as const,
    id: watermarkId,
    ts: timestampFromId(watermarkId),
    source,
    entry: options.watermarkEntry ?? entry,
  }

  await mkdir(dirname(path), { recursive: true })
  await appendEvents(
    path,
    options.watermarkEntry === undefined ? [fragment] : [fragment, watermark],
    onFragmentsAppended,
    onFragmentsAppended
      ? (err) => {
          ctx.logger?.warn(
            `[memory] post-append vector hook failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      : undefined,
  )
  return { fragment, watermark }
}

// Normalize every citation; when wired to the reference subsystem, retain only
// slugs backed by a stored artifact, never a label invented by the model.
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
