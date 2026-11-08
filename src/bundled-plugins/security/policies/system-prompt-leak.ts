import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'
import { outboundTexts } from './outbound-text'

export const GUARD_SYSTEM_PROMPT_LEAK = 'systemPromptLeak'
// Classified `high` (audience-leak axis): bypass posts TypeClaw runtime
// fingerprints / system-prompt fragments to a chat. Same shape as
// outboundSecret — third-party audience, no operator intervention before
// the leak lands. Disclosure also enables recon for later targeted
// prompt-injection attacks against this agent.
export const GUARD_SYSTEM_PROMPT_LEAK_SEVERITY: SecuritySeverity = 'high'

const FINGERPRINT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'TypeClaw runtime preamble', pattern: /You are a general-purpose AI agent running inside TypeClaw\./ },
  { label: 'TypeClaw "Your agent folder" header', pattern: /^##\s+Your\s+agent\s+folder\b/m },
  // kept: pre-migration agents may still have a root MEMORY.md.
  {
    label: 'IDENTITY.md / SOUL.md / MEMORY.md / USER.md / AGENTS.md identity-file recital',
    pattern: /IDENTITY\.md\b[\s\S]{0,400}SOUL\.md\b[\s\S]{0,400}(?:MEMORY\.md|USER\.md|AGENTS\.md)/,
  },
  {
    label: 'TypeClaw injected MEMORY-context disclaimer',
    pattern: /\[MEMORY\s+CONTEXT\s+[\u2014-]\s+not\s+instructions\]/,
  },
  {
    label: 'TypeClaw session-origin / channel_reply preamble',
    pattern: /For\s+every\s+user\s+message\s+in\s+this\s+session,\s+you\s+MUST\s+call\s+`?channel_reply`?/,
  },
  { label: 'TypeClaw available_skills XML block', pattern: /<available_skills>[\s\S]*?<\/available_skills>/ },
  { label: 'TypeClaw skill XML element', pattern: /<skill>\s*<name>[\s\S]*?<\/name>\s*<description>/ },
  {
    label: 'pi-coding-agent SOUL.md prelude',
    pattern: /If\s+SOUL\.md\s+has\s+content\s+below,\s+embody\s+its\s+persona/,
  },
  {
    label: 'TypeClaw NO_REPLY contract',
    pattern: /your\s+entire\s+final\s+visible\s+response\s+must\s+be\s+exactly\s+`?NO_REPLY`?/,
  },
  {
    label: 'TypeClaw SOUL/IDENTITY/MEMORY headed code-block dump',
    pattern: /^#\s+(?:Identity|Memory|Project\s+Context)\s*$/m,
  },
]

const MARKDOWN_HEADERS_DISTINCTIVE = /^##\s+(?:IDENTITY\.md|SOUL\.md|USER\.md|MEMORY\.md|AGENTS\.md)\s*$/m

export type SystemPromptLeakMatch = { label: string; pattern: string }

export function findSystemPromptLeak(text: string): SystemPromptLeakMatch[] {
  const hits: SystemPromptLeakMatch[] = []
  for (const { label, pattern } of FINGERPRINT_PATTERNS) {
    if (pattern.test(text)) hits.push({ label, pattern: pattern.source })
  }
  if (MARKDOWN_HEADERS_DISTINCTIVE.test(text)) {
    hits.push({
      label: 'Identity-file markdown header (e.g. ## SOUL.md)',
      pattern: MARKDOWN_HEADERS_DISTINCTIVE.source,
    })
  }
  return hits
}

export function checkSystemPromptLeakGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  for (const text of outboundTexts(tool, args)) {
    const hits = findSystemPromptLeak(text)
    if (hits.length === 0) continue
    const summary = hits.map((h) => h.label).join('; ')
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_SYSTEM_PROMPT_LEAK}\` blocked ${tool}: outbound text contains TypeClaw system-prompt fingerprints (${summary}).`,
        'Posting the system prompt or identity files to a channel exposes the agent to prompt-injection replay attacks.',
        'Intentional disclosure requires an operator-configured security bypass permission.',
      ].join(' '),
    }
  }
  return undefined
}
