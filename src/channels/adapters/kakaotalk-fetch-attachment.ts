import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  readAttachmentErrorSnippet,
  readAttachmentResponse,
} from '@/channels/fetch-attachment'
import type { FetchAttachmentCallback } from '@/channels/types'

import type { KakaotalkAdapterLogger } from './kakaotalk'

// KakaoCDN hosts that the LOCO push payload mints pre-signed URLs against.
// Photos hit `talk.kakaocdn.net` (verified empirically; the `credential`,
// `expires`, and `signature` query params ARE the auth — no session
// cookie, no Authorization header, no client-cert needed). File / video /
// audio types reach the agent as `dn-l-talk.kakaocdn.net` or its peers in
// the same domain, but in every case we've observed the hostname stays
// under `*.kakaocdn.net`. We keep the allowlist strict (suffix match on
// `.kakaocdn.net` only) so the agent cannot use this callback as a
// generic credentialed fetch — the duck-type intent mirrors Discord and
// Telegram, both of which lock their fetchAttachment to platform CDN
// hosts for the same reason.
const KAKAO_CDN_HOST_SUFFIX = '.kakaocdn.net'

export function createFetchAttachmentCallback(deps: {
  logger: KakaotalkAdapterLogger
  fetchImpl?: typeof fetch
}): FetchAttachmentCallback {
  const { logger } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES, signal }) => {
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return { ok: false, error: `invalid KakaoTalk attachment URL: ${ref}` }
    }
    if (url.protocol !== 'https:') {
      return { ok: false, error: `KakaoTalk attachment URL must be https: ${url.protocol}` }
    }
    if (!isKakaoCdnHost(url.hostname)) {
      return { ok: false, error: `not a KakaoTalk CDN URL: ${url.hostname}` }
    }
    try {
      const res = await fetchImpl(url.toString(), { signal })
      if (!res.ok) {
        const body = await readAttachmentErrorSnippet(res)
        // 403 from kakaocdn almost always means the pre-signed URL expired
        // (the `expires=` query param has a fixed TTL — empirically ~3
        // days from the push event). Surfacing that distinction lets the
        // agent give the user actionable feedback ("the photo link
        // expired — ask them to send it again") instead of a bare HTTP
        // code that looks like a transient failure.
        const hint = res.status === 403 ? ' (likely an expired pre-signed URL; ask the sender to re-share)' : ''
        const message = `kakaotalk cdn fetch ${res.status} ${res.statusText}${hint}${body ? `: ${body.slice(0, 200)}` : ''}`
        logger.error(`[kakaotalk] fetchAttachment failed for ${url.toString()}: ${message}`)
        return { ok: false, error: message }
      }
      const buffer = await readAttachmentResponse(res, maxBytes)
      const inferredFilename = filename ?? deriveFilename(url) ?? 'attachment'
      const contentType = res.headers.get('content-type') ?? undefined
      logger.info(
        `[kakaotalk] downloaded url=${url.toString()} name=${inferredFilename} size=${buffer.length}${contentType ? ` type=${contentType}` : ''}`,
      )
      return {
        ok: true,
        buffer,
        filename: inferredFilename,
        ...(contentType !== undefined ? { mimetype: contentType } : {}),
        size: buffer.length,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[kakaotalk] fetchAttachment failed for ${url.toString()}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

function isKakaoCdnHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  // Exact match on the apex is allowed too; suffix match alone would
  // accept "evilkakaocdn.net" without a leading dot. The bare-apex case
  // is unusual for KakaoCDN traffic (real URLs are always subdomains)
  // but keeping it permitted is harmless and matches the literal "any
  // host under kakaocdn.net" intent.
  return lower === 'kakaocdn.net' || lower.endsWith(KAKAO_CDN_HOST_SUFFIX)
}

function deriveFilename(url: URL): string | null {
  // KakaoCDN paths look like `/dna/<segments>/i_<id>.png?credential=...`.
  // The basename of `pathname` (ignoring the query string) is the most
  // informative file label available to us.
  const basename = url.pathname.split('/').pop()
  if (basename === undefined || basename === '') return null
  return basename
}
