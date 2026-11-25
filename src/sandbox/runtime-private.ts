// Runtime-owned operational state is private to TypeClaw, but is not a
// credential. Keep this category separate from canonical-secrets so security
// diagnostics never mislabel incident metadata as secret material.
export const CANONICAL_AGENT_RUNTIME_PRIVATE_FILES = [
  '.typeclaw/incidents.json',
  '.typeclaw/coding-agent-tasks.json',
  '.typeclaw/watches.json',
] as const

// Directories whose files are replaced by rename while the runtime runs. A file
// mask needs a stable target, so these are masked as a whole. Mirrors
// LAST_WORDS_RELATIVE_DIR in src/last-words/file.ts; kept as a literal so the
// sandbox does not load that module.
export const CANONICAL_AGENT_RUNTIME_PRIVATE_DIRS = ['.typeclaw/last-words'] as const
