import { z } from 'zod'

import { defineTool } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { appendFragment, type FragmentsAppendedHook } from './append-fragment'
import { provenanceFromOrigin } from './append-tool'
import { streamFilePath } from './paths'
import { listReferenceSlugs } from './references/load-references'
import { storeReference, type ReferenceStoredHook } from './references/store-reference-tool'

export function createMemoryRememberTool(
  options: {
    readonly onFragmentsAppended?: FragmentsAppendedHook
    readonly onReferenceStored?: ReferenceStoredHook
  } = {},
) {
  return defineTool({
    description:
      'Remember a durable fact, decision, preference, or correction now. Use when asked to remember something or when durable knowledge is established, not for routine chatter. Supply a short topic and self-contained body in the evidence language; who optionally names the person it is attributable to. Set verbatim to also retain the exact body as a linked reference. The runtime stamps provenance and writes one daily-stream fragment; dreaming consolidates it later.',
    parameters: z.object({
      topic: z.string().min(1),
      body: z.string().min(1),
      who: z.string().min(1).optional(),
      verbatim: z.boolean().optional(),
    }),
    // All arguments are content/control values, never caller-selected paths.
    fileOperands: { nonFile: ['topic', 'body', 'who', 'verbatim'] },
    async execute({ topic, body, who, verbatim }, ctx) {
      const path = streamFilePath(ctx.agentDir, formatLocalDate())
      const { fragment } = await appendFragment(
        {
          topic,
          body,
          who,
          source: ctx.sessionId,
          // An empty anchor is honest for direct calls without a transcript.
          entry: ctx.entryId ?? '',
          kind: 'explicit',
        },
        ctx,
        {
          path,
          where: provenanceFromOrigin(ctx.origin),
          onFragmentsAppended: options.onFragmentsAppended,
          referenceSlugResolver: listReferenceSlugs,
          ...(verbatim
            ? {
                storeReference: async () => {
                  // Indexing is best-effort once the reference is persisted, like
                  // the fragment hook: a failure must not orphan the stored file
                  // or drop the explicit fragment that cites it.
                  const { onReferenceStored } = options
                  const result = await storeReference(
                    { title: topic, body, origin: 'episode' },
                    ctx.agentDir,
                    onReferenceStored === undefined
                      ? undefined
                      : async (reference) => {
                          try {
                            await onReferenceStored(reference)
                          } catch (err) {
                            ctx.logger.warn(
                              `[memory] post-store reference index hook failed: ${err instanceof Error ? err.message : String(err)}`,
                            )
                          }
                        },
                  )
                  return result.details.slug
                },
              }
            : {}),
        },
      )
      return {
        content: [{ type: 'text' as const, text: `Remembered "${topic}".` }],
        details: { path, fragmentId: fragment.id, references: fragment.references ?? [] },
      }
    },
  })
}
