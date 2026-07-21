import { z } from 'zod'

const MIB = 1024 * 1024
const CHANNEL_UPLOAD_MAX_COUNT = 32
const SHARED_MEMORY_HARD_MAX_BYTES = 256 * MIB
export const PROCESS_RESOURCE_MAX_WAITERS = 32

export const DEFAULT_MODEL_TOOL_LIMITS = {
  readSnapshotMaxBytes: 64 * MIB,
  lookAtImageMaxBytes: 20 * MIB,
  lookAtTotalMaxBytes: 20 * MIB,
  lookAtMaxImages: 16,
  webFetchTransportMaxBytes: 5 * MIB,
  channelAttachmentMaxBytes: 100 * MIB,
} as const

export const MODEL_TOOL_LIMIT_HARD_MAX = {
  readSnapshotMaxBytes: 256 * MIB,
  lookAtImageMaxBytes: 64 * MIB,
  lookAtTotalMaxBytes: 64 * MIB,
  lookAtMaxImages: 64,
  webFetchTransportMaxBytes: 5 * MIB,
  channelAttachmentMaxBytes: 100 * MIB,
} as const

const limitsObjectSchema = z
  .object({
    readSnapshotMaxBytes: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.readSnapshotMaxBytes)
      .default(DEFAULT_MODEL_TOOL_LIMITS.readSnapshotMaxBytes),
    lookAtImageMaxBytes: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.lookAtImageMaxBytes)
      .default(DEFAULT_MODEL_TOOL_LIMITS.lookAtImageMaxBytes),
    lookAtTotalMaxBytes: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.lookAtTotalMaxBytes)
      .default(DEFAULT_MODEL_TOOL_LIMITS.lookAtTotalMaxBytes),
    lookAtMaxImages: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.lookAtMaxImages)
      .default(DEFAULT_MODEL_TOOL_LIMITS.lookAtMaxImages),
    webFetchTransportMaxBytes: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.webFetchTransportMaxBytes)
      .default(DEFAULT_MODEL_TOOL_LIMITS.webFetchTransportMaxBytes),
    channelAttachmentMaxBytes: z
      .number()
      .int()
      .positive()
      .max(MODEL_TOOL_LIMIT_HARD_MAX.channelAttachmentMaxBytes)
      .default(DEFAULT_MODEL_TOOL_LIMITS.channelAttachmentMaxBytes),
  })
  .superRefine((limits, ctx) => {
    if (limits.lookAtTotalMaxBytes < limits.lookAtImageMaxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['lookAtTotalMaxBytes'],
        message: 'look_at aggregate byte limit must be at least the per-image byte limit',
      })
    }
  })

export const modelToolLimitsSchema = limitsObjectSchema.default(() => limitsObjectSchema.parse({}))

export const modelToolsSchema = z
  .object({
    limits: modelToolLimitsSchema,
  })
  .default(() => ({ limits: limitsObjectSchema.parse({}) }))

export type ModelToolLimits = z.infer<typeof modelToolLimitsSchema>
export type ModelToolsConfig = z.infer<typeof modelToolsSchema>

export type ProcessResourceBudgetLimits = {
  maxMemoryBytes: number
  maxPinnedBytes: number
  maxPinnedCount: number
  maxWaiters: number
}

export function deriveProcessResourceBudgetLimits(limits: ModelToolLimits): ProcessResourceBudgetLimits {
  return {
    maxMemoryBytes: SHARED_MEMORY_HARD_MAX_BYTES,
    maxPinnedBytes: Math.max(limits.readSnapshotMaxBytes, limits.lookAtTotalMaxBytes, limits.channelAttachmentMaxBytes),
    maxPinnedCount: Math.max(limits.lookAtMaxImages, CHANNEL_UPLOAD_MAX_COUNT),
    maxWaiters: PROCESS_RESOURCE_MAX_WAITERS,
  }
}
