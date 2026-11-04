import {
  AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
  LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
} from '@/agent-messenger/config-dir'

// The managed Chrome profile: cookies and logins persist across container restarts.
export const BROWSER_PROFILE_RELATIVE_DIR = '.typeclaw/browser-profile'

// Runtime-owned credential stores: TypeClaw writes and reads these itself, and
// no shipped skill ever invokes a CLI that reads them. Masked at EVERY role.
export const RUNTIME_OWNED_SECRET_DIRS = [
  // Retained permanently for interrupted migrations, operator backups under
  // the old name, and older installs. This is not an active config location,
  // so nothing an operator provisions today lands here.
  LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
  '.typeclaw/home',
  '.typeclaw/logs',
  BROWSER_PROFILE_RELATIVE_DIR,
  // TypeVault (typevault.enabled): the agent's machine key and typevault's
  // private state, and the vault itself, which holds the secrets.json envelope.
  // Mirrors src/typevault/vault.ts; kept as literals so the sandbox does not
  // load the typevault SDK.
  '.typeclaw/typevault',
  '.typevault',
] as const

// SECURITY / classification: operator-provisioned CLI credential stores. TypeClaw
// writes these through its own init/auth flows and points the matching CLI at them
// (`dockerfile.ts` bakes `ENV AGENT_MESSENGER_CONFIG_DIR`), so the agent is MEANT
// to read them — the bundled `agent-*` and gws skills shell out to CLIs that
// resolve exactly these files. Masking them at every role does not withhold a
// secret, it breaks the skill and leaves the CLI reporting its own "not
// authenticated", which a model relays as a fact about the upstream service.
//
// So they take the ordinary private-surface role gate, which is what applied to
// them before they were named here (they live under `workspace/`). Add a path
// here only if a shipped skill needs to read it; anything that must stay hidden
// from every role belongs in `secrets.json`, not in a masked directory.
export const OPERATOR_CLI_CREDENTIAL_DIRS = ['workspace/.config/gws', AGENT_MESSENGER_CONFIG_RELATIVE_DIR] as const

// Union: every directory that is masked for SOME role. Consumers that need the
// full set regardless of gating (write-zone vetoes, hardlink-alias scanning)
// use this; consumers that must respect the gate read the two lists above.
export const CANONICAL_AGENT_SECRET_DIRS = [...OPERATOR_CLI_CREDENTIAL_DIRS, ...RUNTIME_OWNED_SECRET_DIRS] as const

export const CANONICAL_AGENT_SECRET_FILES = ['.env', 'secrets.json', 'auth.json'] as const

// Trusted runtime processes use this ephemeral container HOME. bwrap builds an
// empty root and never binds /home, so model bash cannot see it; non-bash tools
// run in-process and use this fixed path as an unconditional denial root in
// addition to os.homedir() (which resolves here in the container).
export const CONTAINER_RUNTIME_HOME = '/home/agent'

export const CANONICAL_HOME_SECRET_DIRS = [
  '.ssh',
  '.config/gh',
  '.config/gws',
  '.config/agent-messenger',
  '.agent-messenger',
  '.codex',
  '.claude',
] as const

export const CANONICAL_HOME_SECRET_FILES = ['.gitconfig', '.claude.json', '.netrc'] as const
