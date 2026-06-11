import type { LinePushMessageEvent } from 'agent-messenger/line'

import type { InboundAttachment } from '@/channels/types'

// Splits an inbound LINE event into (text, attachments[]). Text is what the
// agent sees in its prompt; attachments[] carries the in-turn id + kind the
// router uses to resolve `channel_fetch_attachment` / `look_at` by id.
//
// LINE differs from KakaoTalk in one load-bearing way: the upstream SDK
// (`agent-messenger/line`) currently forwards only `content_type` on the push
// event, NOT `contentMetadata`. So unlike the KakaoTalk splitter, this one has
// no sticker id / file name / media URL to surface — every attachment is
// REF-FREE (empty `ref`, no fetchable handle). The placeholder is therefore
// coarse on purpose (`[LINE sticker]`, `[LINE image]`). When the SDK starts
// forwarding metadata (agent-messenger#214), enrich this file only; the
// adapter / classifier contract does not change.
//
// Keeping the ref out of the prompt text is the same invariant the KakaoTalk
// splitter documents: there is exactly ONE way to fetch an attachment — by its
// in-turn id — so a hallucinated/malformed ref can never reach a tool.

export type SplitInboundLine = {
  text: string
  attachments: InboundAttachment[]
}

// LINE thrift ContentType. The SDK stringifies `msg.raw.contentType`, which the
// thrift layer usually renders as the symbolic name, but the wire enum is
// numeric (see @evex/linejs-types ContentType). Normalize defends against both
// forms so a numeric leak ("7") still maps to STICKER rather than falling
// through to the unknown bucket.
const NUMERIC_CONTENT_TYPE: Record<string, string> = {
  '0': 'NONE',
  '1': 'IMAGE',
  '2': 'VIDEO',
  '3': 'AUDIO',
  '7': 'STICKER',
  '13': 'CONTACT',
  '14': 'FILE',
  '15': 'LOCATION',
}

// Non-text content types that map cleanly onto the fixed InboundAttachment.kind
// union. Types with no clean mapping (CONTACT, LOCATION, and anything unknown)
// route as placeholder-only text — an attachment with an empty ref and an
// invented kind would offer the agent an unusable handle, so we don't make one.
const CONTENT_TYPE_TO_KIND: Record<string, InboundAttachment['kind']> = {
  STICKER: 'sticker',
  IMAGE: 'photo',
  VIDEO: 'video',
  AUDIO: 'audio',
  FILE: 'file',
}

const PLACEHOLDER_ONLY_LABEL: Record<string, string> = {
  CONTACT: 'contact',
  LOCATION: 'location',
}

// Letter-Sealing (E2EE) messages this session cannot decrypt arrive as
// `text: null, content_type: NONE` with a `decryption_error` set — wire-
// identical to a genuinely empty message. Without surfacing them the agent
// silently drops real user messages as empty_text and looks dead. Map the
// codes to a stable, agent-readable phrase instead of forwarding the SDK's
// verbose/localized message verbatim.
const DECRYPTION_ERROR_PLACEHOLDER: Record<string, string> = {
  missing_e2ee_key: '[LINE message could not be decrypted: missing E2EE key]',
  decrypt_failed: '[LINE message could not be decrypted]',
}

export function lineDecryptionPlaceholder(code: string): string {
  return DECRYPTION_ERROR_PLACEHOLDER[code] ?? '[LINE message could not be decrypted]'
}

export function normalizeLineContentType(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return 'NONE'
  const trimmed = raw.trim()
  if (trimmed === '') return 'NONE'
  const numeric = NUMERIC_CONTENT_TYPE[trimmed]
  if (numeric !== undefined) return numeric
  const upper = trimmed.toUpperCase()
  // LINE text is `NONE` on the wire; treat the `TEXT` spelling as the same so
  // a genuine text message never falls into the placeholder path.
  return upper === 'TEXT' ? 'NONE' : upper
}

export function splitInboundLine(event: LinePushMessageEvent, startId = 1): SplitInboundLine {
  if (event.decryption_error !== undefined) {
    return { text: lineDecryptionPlaceholder(event.decryption_error.code), attachments: [] }
  }

  const contentType = normalizeLineContentType(event.content_type)

  // NONE is LINE text; a blank NONE message stays an `empty_text` drop in the
  // classifier, so synthesize nothing and pass the raw text through.
  if (contentType === 'NONE') {
    return { text: event.text ?? '', attachments: [] }
  }

  const kind = CONTENT_TYPE_TO_KIND[contentType]
  const rawText = event.text ?? ''

  if (kind !== undefined) {
    const id = startId
    const placeholder = `[LINE ${kind}]`
    const text = rawText === '' ? placeholder : `${rawText}\n${placeholder}`
    return { text, attachments: [{ id, kind, ref: '' }] }
  }

  // Placeholder-only types (contact, location, unknown/future). No attachment
  // entry — there is nothing fetchable and no valid kind to assign.
  const label = PLACEHOLDER_ONLY_LABEL[contentType] ?? `message: ${contentType}`
  const placeholder = `[LINE ${label}]`
  const text = rawText === '' ? placeholder : `${rawText}\n${placeholder}`
  return { text, attachments: [] }
}
