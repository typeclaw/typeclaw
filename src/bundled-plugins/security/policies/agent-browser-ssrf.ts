import { ACKNOWLEDGE_GUARDS, type SecurityBlock, isGuardAcknowledged } from '../policy'
import { classifyUrl, type SsrfClassification } from './ssrf'

export const GUARD_AGENT_BROWSER_SSRF = 'agentBrowserSsrf'

// Covers the bare binary, the bunx/npx wrappers documented in the skill's
// `allowed-tools` frontmatter, and an absolute-path call into node_modules.
// The leading boundary keeps `my-agent-browser-script.sh` from matching.
const AGENT_BROWSER_INVOCATION =
  /(^|[\s;|&(`$])(?:(?:bunx|npx)\s+(?:--?[A-Za-z][A-Za-z0-9-]*\s+)*)?(?:[^\s;|&`'"]*\/)?agent-browser([\s;|&)`]|$)/

const URL_TOKEN = /\bhttps?:\/\/[^\s'"`)]+/gi

// agent-browser accepts host:port without a scheme; Chrome prepends http://
// internally. We scan for bare IPv4 and bracketed IPv6 literals and re-feed
// them with an http:// prefix so classifyUrl sees the same shape it does for
// scheme'd URLs. Bare DNS-style hostnames are not matched here — the SSRF
// classifier only blocks literal IPs and reserved suffixes, so a bare token
// like `router` could not be classified anyway.
const BARE_IPV4_TOKEN = /(?<![A-Za-z0-9._-])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![A-Za-z0-9._-])/g
const BARE_IPV6_TOKEN = /\[[0-9A-Fa-f:]+\](?::\d{1,5})?/g

export function checkAgentBrowserSsrfGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined
  if (!AGENT_BROWSER_INVOCATION.test(command)) return undefined
  if (isGuardAcknowledged(args, GUARD_AGENT_BROWSER_SSRF)) return undefined

  const blocked = findFirstBlockedTarget(command)
  if (!blocked) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_AGENT_BROWSER_SSRF}\` blocked an agent-browser command targeting a non-public destination (${blocked.classification.category ?? 'unknown'}): ${blocked.classification.reason ?? 'classified as internal'}.`,
      'A browser inside the container can reach the host LAN, cloud-metadata endpoints, and reserved internal hostnames — letting the agent navigate there exposes routers, IoT/admin panels, and the metadata service to whoever wrote the prompt (including indirect prompt injection through page content).',
      `If the user explicitly asked for this and you trust the destination, retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_AGENT_BROWSER_SSRF}: true\` in the bash arguments.`,
    ].join(' '),
  }
}

type BlockedTarget = { url: string; classification: SsrfClassification }

function findFirstBlockedTarget(command: string): BlockedTarget | undefined {
  for (const url of extractUrlCandidates(command)) {
    const classification = classifyUrl(url)
    if (classification.blocked) return { url, classification }
  }
  return undefined
}

function* extractUrlCandidates(command: string): Generator<string> {
  // No real shell parsing — we just neutralize quote characters so they
  // can't hide a URL from the regex (`'http://192.168.0.1'` would otherwise
  // be a single token ending at the closing quote, which matches anyway,
  // but stripping makes failure-mode reasoning trivial).
  const stripped = command.replace(/['"`]/g, ' ')

  for (const match of stripped.matchAll(URL_TOKEN)) {
    yield match[0]
  }
  for (const match of stripped.matchAll(BARE_IPV4_TOKEN)) {
    yield `http://${match[0]}`
  }
  for (const match of stripped.matchAll(BARE_IPV6_TOKEN)) {
    yield `http://${match[0]}`
  }
}
