import { z } from 'zod'

// Cap activation memory at one batch per inference lane during large backfills.
export const EMBED_BATCH_SIZE = 64

const embedType = z.enum(['query', 'passage'])
export type EmbedType = z.infer<typeof embedType>

export const embedRequest = z.object({
  id: z.number().int().positive(),
  type: embedType,
  texts: z.array(z.string()),
})
export type EmbedRequest = z.infer<typeof embedRequest>

export const embedReply = z.discriminatedUnion('kind', [
  z.object({
    id: z.number().int().positive(),
    kind: z.literal('result'),
    vectors: z.array(z.instanceof(Float32Array)),
  }),
  z.object({ id: z.number().int().positive(), kind: z.literal('error'), message: z.string() }),
  z.object({ id: z.number().int().positive(), kind: z.literal('progress'), completed: z.number().int().positive() }),
])
export type EmbedReply = z.infer<typeof embedReply>
