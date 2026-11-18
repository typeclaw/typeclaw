// Runtime-owned operational state is private to TypeClaw, but is not a
// credential. Keep this category separate from canonical-secrets so security
// diagnostics never mislabel incident metadata as secret material.
export const CANONICAL_AGENT_RUNTIME_PRIVATE_FILES = [
  '.typeclaw/incidents.json',
  '.typeclaw/coding-agent-tasks.json',
  '.typeclaw/last-words.json',
  '.typeclaw/last-words.json.tmp',
] as const
