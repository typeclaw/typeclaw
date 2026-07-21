import { DEFAULT_MODEL_TOOL_LIMITS } from '@/config'

export type CompactionStrategy = 'readability' | 'jq' | 'selector' | 'grep' | 'snapshot' | 'raw'

export type AntibotWarmupDetails = {
  triggered: boolean
  initialStatus?: number
  initialSetCookieNames?: string[]
  replayStatus?: number
}

export type WebFetchDetails = {
  url: string
  finalUrl: string
  strategy: CompactionStrategy | 'none'
  autoDetected: boolean
  contentType: string
  httpStatus: number
  bytesIn: number
  bytesOut: number
  truncated: boolean
  durationMs: number
  antibotWarmup?: AntibotWarmupDetails
  error?: boolean
  message?: string
}

// Per-strategy output caps. Web pages are huge; aggressive caps keep the model's
// context lean. Lifted from oh-my-openagent PR #434's lesson that the default
// 50k-token cap is too generous for fetched content.
export const OUTPUT_CAPS: Record<CompactionStrategy, number> = {
  raw: 100_000,
  jq: 50_000,
  readability: 200_000,
  selector: 100_000,
  grep: 100_000,
  snapshot: 50_000,
}

export const DEFAULT_WEB_FETCH_TRANSPORT_MAX_BYTES = DEFAULT_MODEL_TOOL_LIMITS.webFetchTransportMaxBytes

export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
