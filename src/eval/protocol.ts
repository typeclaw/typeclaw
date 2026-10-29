import { z } from 'zod'

import { EVAL_LIMITS } from './wire'
export { EVAL_LIMITS, FRAME_PREFIX, EvalError, encodeFrame, FrameLines, CellOutput } from './wire'

const id = z.string().min(1).max(128)
export const kernelFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('output'), cellId: id, text: z.string() }),
  z.strictObject({
    type: z.literal('tool-call'),
    cellId: id,
    id,
    name: z.string().min(1).max(128),
    args: z.record(z.string(), z.json()),
  }),
  z.strictObject({ type: z.literal('done'), cellId: id, error: z.string().optional() }),
])

export type KernelFrame = z.infer<typeof kernelFrameSchema>
export const hostFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('run'), cellId: id, code: z.string().max(EVAL_LIMITS.codeBytes) }),
  z.strictObject({ type: z.literal('tool-result'), id, value: z.unknown() }),
  z.strictObject({ type: z.literal('tool-error'), id, error: z.string() }),
])
export type HostFrame = z.infer<typeof hostFrameSchema>
