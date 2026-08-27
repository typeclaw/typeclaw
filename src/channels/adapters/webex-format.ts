import type { WebexMessage } from 'agent-messenger/webex'

import type { InboundAttachment } from '@/channels/types'

// Webex's E2E (internal conversation) path renders agent markdown as an HTML
// `content` field that some clients display verbatim, so messages sent with
// `markdown: true` leak literal `<br/>` and `&apos;`. typeclaw sends plain text
// outbound; inbound we still read the HTML `html` field as a fallback, so this
// undoes that HTML. Protocol HTML (not natural language) -> ASCII literal set.

// Normalize ONLY the HTML `html` fallback: `text`/`markdown` are author-clean and
// must stay raw, or literal `&`/`<` the user typed would be corrupted.
export function resolveWebexBodyText(msg: Pick<WebexMessage, 'text' | 'markdown' | 'html'>): string {
  if (msg.text !== undefined && msg.text !== '') return msg.text
  if (msg.markdown !== undefined && msg.markdown !== '') return msg.markdown
  if (msg.html !== undefined && msg.html !== '') return normalizeWebexHtmlFallbackText(msg.html)
  return ''
}

// Shared by both Webex classifiers and both Webex history mappers so a file
// carries the same `#N` in every surface the agent can read. History used to
// emit a single un-numbered `[Webex attachment]` regardless of file count,
// which registered refs the agent could never name in
// look_at_channel_attachment.
export function splitWebexFiles(text: string, files: readonly string[] | undefined): SplitWebexFiles {
  const attachments = (files ?? []).map(describeWebexFile)
  if (attachments.length === 0) return { text, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  return { text: text === '' ? summary : `${text}\n${summary}`, attachments }
}

type SplitWebexFiles = { text: string; attachments: InboundAttachment[] }

function describeWebexFile(ref: string, index: number): InboundAttachment {
  return { id: index + 1, kind: 'file', ref, filename: filenameFromUrl(ref) ?? `webex-file-${index + 1}` }
}

function filenameFromUrl(ref: string): string | null {
  try {
    const url = new URL(ref)
    const name = url.pathname.split('/').filter(Boolean).pop()
    return name === undefined || name === '' ? null : name
  } catch {
    return null
  }
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Webex attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}

export function normalizeWebexHtmlFallbackText(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?[^>]+>/g, '')
  return decodeHtmlEntities(withBreaks)
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10))
    switch (lower) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default:
        return match
    }
  })
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  return String.fromCodePoint(value)
}
