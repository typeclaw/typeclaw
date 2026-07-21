import {
  discardAttachmentResponse,
  readAttachmentErrorSnippet,
  readAttachmentResponse,
} from '@/channels/fetch-attachment'

const MAX_SLACK_REDIRECTS = 5
const SLACK_DOWNLOAD_HOSTS = ['slack.com', 'slack-edge.com', 'slack-files.com'] as const
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type SlackDownloadMetadata = {
  name?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

export type SlackAttachmentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function downloadSlackAttachment(options: {
  metadata: SlackDownloadMetadata
  token: string
  cookie?: string
  maxBytes: number
  signal?: AbortSignal
  fetchImpl?: SlackAttachmentFetch
}): Promise<{ buffer: Buffer; url: URL }> {
  const rawUrl = options.metadata.url_private_download ?? options.metadata.url_private
  if (rawUrl === undefined || rawUrl === '') throw new Error('Slack file metadata has no private download URL')
  const fetchImpl = options.fetchImpl ?? fetch
  let url = parseTrustedSlackUrl(rawUrl)

  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.cookie === undefined ? {} : { Cookie: `d=${options.cookie}` }),
      },
      redirect: 'manual',
      signal: options.signal,
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardAttachmentResponse(response)
      if (redirects >= MAX_SLACK_REDIRECTS) throw new Error('Slack attachment redirect limit exceeded')
      const location = response.headers.get('location')
      if (location === null) throw new Error('Slack attachment redirect omitted Location')
      url = parseTrustedSlackUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) {
      const snippet = await readAttachmentErrorSnippet(response)
      throw new Error(`Slack attachment download failed (${response.status})${snippet === '' ? '' : `: ${snippet}`}`)
    }
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? ''
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      await discardAttachmentResponse(response)
      throw new Error('Slack attachment download returned an HTML login response')
    }
    return { buffer: await readAttachmentResponse(response, options.maxBytes), url }
  }
}

function parseTrustedSlackUrl(raw: string): URL {
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    !SLACK_DOWNLOAD_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  ) {
    throw new Error(`refusing untrusted Slack attachment URL host: ${url.hostname}`)
  }
  return url
}
