import { accessSync, constants as fsConstants, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { Model } from '@mariozechner/pi-ai'
import { z } from 'zod'

import { channelsSchema } from '@/channels/schema'
import { commitSystemFileSync } from '@/git/system-commit'
import { rolesConfigSchema } from '@/permissions/schema'
import { secretFieldSchema } from '@/secrets/resolve'

import {
  DEFAULT_MODEL_REF,
  KNOWN_PROVIDERS,
  listKnownModelRefs,
  type KnownModelRef,
  type KnownProviderId,
} from './providers'

const CONFIG_FILE = 'typeclaw.json'

const knownModelRefs = listKnownModelRefs() as [KnownModelRef, ...KnownModelRef[]]

// T9 keypad: T=8, Y=9, P=7, E=3
const DEFAULT_PORT = 8973

// Mount names land on disk as `mounts/<name>` inside the agent folder, so they
// share a namespace with regular filenames. Restricting to lowercase
// alphanumerics + `-`/`_` keeps them shell-safe and avoids accidental shadowing
// of files like `mounts/.git` or `mounts/Hello`.
const MOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

export const mountSchema = z.object({
  name: z.string().regex(MOUNT_NAME_PATTERN, 'mount name must be lowercase alphanumeric with - or _'),
  path: z.string().min(1),
  readOnly: z.boolean().default(false),
  description: z.string().optional(),
})

export type Mount = z.infer<typeof mountSchema>

// MCP servers are keyed by the same shell/disk-safe namespace as mounts because
// the name becomes the tool namespace exposed to the agent. The transport is an
// XOR on purpose: stdio servers are child processes (`command` + `args` + env),
// while Streamable HTTP servers are remote endpoints (`url`); accepting both
// would make ownership, lifetime, and credential injection ambiguous at boot.
export const mcpServerSchema = z
  .object({
    name: z
      .string()
      .regex(MOUNT_NAME_PATTERN, 'MCP server name must be lowercase alphanumeric with - or _')
      .refine((name) => !name.includes('__'), {
        message: "MCP server name must not contain '__' (reserved as the tool-namespace separator)",
      }),
    description: z.string().optional(),
    // Default true so omitting the field keeps the server on; set false to keep config but skip connecting.
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.record(z.string(), secretFieldSchema).default({}),
  })
  .refine((server) => (server.command !== undefined) !== (server.url !== undefined), {
    message: 'MCP server must be either stdio (command) or http (url), not both or neither',
  })

export type McpServer = z.infer<typeof mcpServerSchema>

const portNumber = z.number().int().min(1).max(65535)

// `allow` is the discriminator between "forward everything" ('*') and a fixed
// allowlist (number[]). `deny` is only meaningful when allow === '*'; combining
// it with a number[] allow is rejected at parse time so a typo doesn't silently
// drop the deny rule. An empty allowlist (`allow: []`) is the off switch.
export const portForwardSchema = z
  .object({
    allow: z.union([z.literal('*'), z.array(portNumber)]),
    deny: z.array(portNumber).optional(),
  })
  .refine((v) => !(Array.isArray(v.allow) && v.deny !== undefined && v.deny.length > 0), {
    message: 'portForward.deny is only meaningful when allow is "*"; remove deny or set allow to "*"',
    path: ['deny'],
  })
  .default({ allow: '*' })

export type PortForward = z.infer<typeof portForwardSchema>

const dockerfileLineSchema = z.string().refine((line) => !/[\r\n]/.test(line), {
  message: 'dockerfile.append entries must be single Dockerfile lines; split multiline instructions into array entries',
})

// A feature toggle is either a boolean (install latest / don't install) or a
// version string that becomes an apt pin (`pkg=<version>`). The string form
// rejects whitespace and `=` so the `pkg=<version>` invocation we pass to
// apt-get cannot be smuggled into a separate package or option flag.
const dockerfileFeatureSchema = z.union([
  z.boolean(),
  z
    .string()
    .min(1)
    .refine((v) => !/[\s=]/.test(v), {
      message: 'dockerfile feature version strings must not contain whitespace or "="',
    }),
])

// `default(() => ({}))` paired with field-level defaults is the idiom that
// makes both `docker.file: {}` and an omitted `docker.file` key resolve to the
// SAME fully-populated object. A plain `.default({})` would short-circuit the
// inner field defaults when the key is omitted, leaving downstream code with
// `{ append: undefined, tmux: undefined, ... }` and a `lines.length` crash.
const dockerfileObjectSchema = z.object({
  ffmpeg: dockerfileFeatureSchema.default(false),
  gh: dockerfileFeatureSchema.default(true),
  python: z.boolean().default(true),
  tmux: dockerfileFeatureSchema.default(true),
  // `fonts-noto-cjk` is a ~56MB metapackage that makes Chromium render
  // Korean/Japanese/Chinese glyphs correctly in screenshots, `page.pdf()`,
  // and any other raster output the agent-browser plugin produces. Default
  // `true` because the alternative — silent tofu boxes (□□□) in CJK
  // screenshots — is a confusing failure mode that an agent cannot self-
  // diagnose from a screenshot it took itself. Opt-out with `cjkFonts:
  // false` to save the ~56MB on agents that never touch CJK content.
  // Boolean-only (no version pin) because the package is a metapackage
  // tracking the upstream Noto release and version pinning offers no
  // practical value.
  cjkFonts: z.boolean().default(true),
  // Opt into the cloudflared layer for `cloudflare-quick` tunnels. Default
  // `true` so `tunnel add` / `channel add github` with the default Cloudflare
  // Quick provider works on the next `start` without a separate Dockerfile
  // edit. Opt-out with `cloudflared: false` to skip the ~35MB binary on
  // agents that don't use tunnels.
  cloudflared: z.boolean().default(true),
  // Install xvfb so the entrypoint shim can spawn an Xvfb virtual X
  // server and export DISPLAY, giving headed Chrome (agent-browser
  // --headed, Playwright headful) a real X11 display to connect to.
  // Default `true` because modern bot detection (Akamai/Cloudflare Bot
  // Manager) fingerprints `--headless` and `--headless=new` regardless
  // of UA spoof, and headed-via-Xvfb is the cheapest path to a passing
  // fingerprint from a container. Opt-out with `xvfb: false` to save
  // ~5MB image + ~10MB RAM/idle on agents that never touch a browser.
  // The shim self-heals — when Xvfb isn't on PATH it execs the agent
  // directly, no other Dockerfile or shim change needed. Boolean-only
  // because the package has no API-stable versioning that matters
  // here; xvfb tracks the upstream X server release.
  xvfb: z.boolean().default(true),
  // `claudeCode` is boolean-only (not an apt feature toggle): the upstream
  // installer is `curl | bash` and manages versions via env vars at install
  // time, not via version pins like apt. Default `false`; the bundled
  // `typeclaw-claude-code` skill prompts the user to opt in.
  claudeCode: z.boolean().default(false),
  // `codexCli` is boolean-only (not an apt feature toggle): the upstream
  // installer is the npm package `@openai/codex` which we install globally
  // via `bun install -g`. Default `false`; the bundled `typeclaw-codex-cli`
  // skill prompts the user to opt in. Mirrors the `claudeCode` toggle for
  // OpenAI's Codex CLI (https://github.com/openai/codex) — same shape, same
  // restart-required semantics, separate hook scripts (Codex uses
  // hooks.json with a different event matcher than Claude Code).
  codexCli: z.boolean().default(false),
  append: z.array(dockerfileLineSchema).default([]),
})

export const dockerfileSchema = dockerfileObjectSchema.default(() => dockerfileObjectSchema.parse({}))

export type DockerfileConfig = z.infer<typeof dockerfileSchema>
export type DockerfileFeatureToggle = z.infer<typeof dockerfileFeatureSchema>

// The `docker` namespace nests Docker-related blocks under one top-level key
// so future extensions (e.g. `docker.compose`, `docker.buildArgs`) have a home
// without polluting the root. Today the only inhabitant is `docker.file`,
// which holds the same shape that used to live at top-level `dockerfile`.
// One-time migration (see `migrateLegacyConfigShape`) rewrites the old
// top-level key into the new path on first load.
export const dockerSchema = z
  .object({
    file: dockerfileSchema,
  })
  .default(() => ({ file: dockerfileObjectSchema.parse({}) }))

export type DockerConfig = z.infer<typeof dockerSchema>

const gitignoreLineSchema = z.string().refine((line) => !/[\r\n]/.test(line), {
  message: 'git.ignore.append entries must be single gitignore lines; split multiline patterns into array entries',
})

const gitignoreObjectSchema = z.object({
  append: z.array(gitignoreLineSchema).default([]),
})

export const gitignoreSchema = gitignoreObjectSchema.default(() => gitignoreObjectSchema.parse({}))

export type GitignoreConfig = z.infer<typeof gitignoreSchema>

// Same rationale as `dockerSchema`: a `git` namespace today carries `git.ignore`
// and leaves room for future siblings (e.g. `git.attributes`). The one-time
// migration also handles the rename of legacy top-level `gitignore`.
export const gitSchema = z
  .object({
    ignore: gitignoreSchema,
  })
  .default(() => ({ ignore: gitignoreObjectSchema.parse({}) }))

export type GitConfig = z.infer<typeof gitSchema>

const IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/

const ipv4CidrSchema = z.string().refine(
  (value) => {
    const match = IPV4_CIDR_PATTERN.exec(value)
    if (!match) return false
    const octets = [match[1], match[2], match[3], match[4]].map(Number)
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    if (match[5] !== undefined) {
      const prefix = Number(match[5])
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
    }
    return true
  },
  {
    message: 'network.allow entries must be IPv4 addresses or CIDR ranges (e.g. "10.0.0.0/16", "10.0.0.2")',
  },
)

// `blockInternal` is the kill-switch for the container-stage egress filter
// installed by Dockerfile entrypoint shim: when true, the container is granted
// CAP_NET_ADMIN at boot just long enough to install iptables OUTPUT rules
// that DROP traffic to RFC1918, link-local (incl. cloud metadata), CGNAT,
// multicast/reserved, IPv6 ULA/link-local/multicast. The capability is then
// dropped from the bounding set via setpriv before the agent process exec's,
// so no child (python, curl, bun-spawned anything) can mutate or recover it.
//
// Default is `true`: the threat model that motivated this feature — prompt
// injection asking the agent to fetch RFC1918 hosts (e.g. a LAN router admin
// page) or the cloud-IMDS endpoint — applies to every agent equally, so the
// safe default is "on" and
// the explicit opt-out is for users who need their agent to reach LAN hosts
// (NAS, internal services, sibling dev machines). PR #145 shipped this with
// default `false` to preserve existing-folder behavior on upgrade; this
// follow-up (the one PR #145 promised in its description) makes the default
// match the intent. `typeclaw init` also writes `true` explicitly so the
// field is discoverable in fresh `typeclaw.json` files. Loopback traffic
// (`-o lo`) is always allowed by the shim, so `bun run dev` and local APIs
// on `localhost` / `127.0.0.1` are unaffected.
//
// `autoAllowResolvers` (default `true`) makes the shim narrowly carve out
// the container's DNS resolvers — every `nameserver` line in
// `/etc/resolv.conf` gets a `udp/tcp --dport 53` ACCEPT inserted BEFORE the
// REJECT rules. This fixes the canonical EC2/GCE/Azure footgun: cloud VPC
// resolvers live inside RFC1918 (e.g. AWS VPC DNS at `10.0.0.2`), so
// `blockInternal: true` would otherwise kill every DNS lookup the agent
// makes. The carve-out is scoped to port 53 only — a compromised agent
// cannot reach the resolver host on any other port. On a laptop where
// `/etc/resolv.conf` points at a public resolver (1.1.1.1, 8.8.8.8), the
// generated ACCEPT rules are no-ops because public IPs are not in the
// block list to begin with. Opt-out (`false`) is for users who explicitly
// configure DNS via `.env` (e.g. `DOCKER_DNS=1.1.1.1`) and want a fully
// closed filter.
//
// `allow` is the power-user escape hatch: an explicit list of IPv4 CIDRs
// or bare IPv4 addresses that punch through the block list wholesale (all
// ports, all protocols). Use case: VPC-private services the agent must
// reach by IP — internal APIs, RDS endpoints, VPC interface endpoints for
// S3/Bedrock. Each entry inserts an unscoped `iptables -A OUTPUT -d <cidr>
// -j ACCEPT` before the REJECT rules. IPv4 only: the carve-out is for
// destinations the operator names explicitly, and every cloud VPC we
// support is IPv4-routable. Validation at parse time rejects non-CIDR
// strings, IPv6 forms, and out-of-range octets so a typo in
// `typeclaw.json` surfaces immediately instead of at container boot.
export const networkSchema = z
  .object({
    blockInternal: z.boolean().default(true),
    autoAllowResolvers: z.boolean().default(true),
    allow: z.array(ipv4CidrSchema).default([]),
  })
  .default({ blockInternal: true, autoAllowResolvers: true, allow: [] })

export type NetworkConfig = z.infer<typeof networkSchema>

// Reverse-proxy tunnels expose a container-private port to the public internet
// via a managed subprocess (cloudflared) or a user-supplied external URL.
// See AGENTS.md `## Tunnels`. Keeping the enum scoped to what's implemented
// means validateConfig() rejects unsupported providers at `typeclaw start`
// time, before the container is torn down and rebuilt. `restart-required`
// because the tunnel manager reads this list once at boot.
const tunnelForSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), name: z.string().trim().min(1) }),
  z.object({ kind: z.literal('manual') }),
])

// `tokenEnv` is the NAME of an env var, not the token itself. Restrict to the
// shell-portable identifier shape (uppercase + digits + underscore, leading
// non-digit) so a value typed here can't break `--env-file` parsing or shell
// expansion inside the container. Matches the convention every other env var
// in the codebase already follows (TYPECLAW_*, OPENAI_*, etc.).
const tokenEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, {
  message: 'tokenEnv must be an env var name like CLOUDFLARE_TUNNEL_TOKEN (uppercase, digits, underscore)',
})

const tunnelEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, {
        message: 'tunnel name must match /^[a-z0-9][a-z0-9-_]*$/ (lowercase, digits, dashes, underscores)',
      }),
    provider: z.enum(['external', 'cloudflare-quick', 'cloudflare-named']),
    for: tunnelForSchema,
    externalUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), { message: 'externalUrl must use https://' })
      .optional(),
    upstreamPort: z.number().int().min(1).max(65535).optional(),
    hostname: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), { message: 'hostname must use https://' })
      .optional(),
    tokenEnv: tokenEnvNameSchema.optional(),
  })
  .refine((v) => v.provider !== 'external' || (v.externalUrl !== undefined && v.externalUrl.trim() !== ''), {
    message: "tunnels[].externalUrl is required when provider is 'external'",
  })
  .refine((v) => v.provider !== 'cloudflare-named' || (v.hostname !== undefined && v.hostname.trim() !== ''), {
    message: "tunnels[].hostname is required when provider is 'cloudflare-named'",
  })
  .refine((v) => v.provider !== 'cloudflare-named' || (v.tokenEnv !== undefined && v.tokenEnv.trim() !== ''), {
    message: "tunnels[].tokenEnv is required when provider is 'cloudflare-named'",
  })
  // cloudflared learns the upstream from the Cloudflare dashboard's Public
  // Hostname mapping, not from typeclaw. An `upstreamPort` here would be
  // silently ignored; reject at parse time so the contradiction surfaces in
  // the config file rather than as a debugging surprise.
  .refine((v) => v.provider !== 'cloudflare-named' || v.upstreamPort === undefined, {
    message:
      "tunnels[].upstreamPort must not be set when provider is 'cloudflare-named' (cloudflared reads the upstream from the Cloudflare dashboard)",
  })
  .refine((v) => v.for.kind !== 'manual' || v.provider === 'cloudflare-named' || v.upstreamPort !== undefined, {
    message: "tunnels[].upstreamPort is required when for.kind is 'manual'",
  })

const tunnelsArraySchema = z
  .array(tunnelEntrySchema)
  .default([])
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name
      const prev = seen.get(name)
      if (prev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `tunnels[${i}].name duplicates tunnels[${prev}].name ('${name}')`,
        })
      } else {
        seen.set(name, i)
      }
    }
  })

// `models` maps a profile name to one or more curated model refs. The
// `default` profile is mandatory; every other profile is optional and falls
// back to `default` at resolution time (see `resolveProfile`).
//
// Each value is either a single `KnownModelRef` or a non-empty array of refs
// forming a fallback chain: when a turn against the first ref fails (hard
// throw or a soft provider error), the runtime disposes the failed session
// and replays the same prompt against the next ref. Schema accepts both
// shapes for ergonomics; the parsed value is always normalised to a
// non-empty array so downstream consumers read a uniform `KnownModelRef[]`.
//
// Profile names are open strings; the runtime recognizes a handful of
// well-known names by convention (`default`, `fast`, `deep`, `vision`) but
// any string is valid. Unknown profile names resolve to `default` with a
// one-time warning at session construction.
//
// The pre-multi-model schema had a single `model: KnownModelRef` at the top
// level. `migrateLegacyConfigShape` rewrites that to `models: { default: ... }`
// on first load (and writes the result back to disk + commits via
// `persistMigratedConfig`), so every downstream consumer sees the new shape.
const modelRefOrChainSchema = z
  .union([
    z.enum(knownModelRefs),
    z
      .array(z.enum(knownModelRefs))
      .min(1)
      // Reject exact duplicates in a chain — retrying the same ref after the
      // same class of failure is almost certainly a config typo, and silently
      // deduping would mask user intent. Different models from the same
      // provider (e.g. `["openai/gpt-5.4-nano", "openai/gpt-5.4-mini"]`) are
      // still valid because they hit distinct upstream endpoints.
      .refine((arr) => new Set(arr).size === arr.length, {
        message: 'models chain must not contain duplicate refs',
      }),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]))
export const modelsSchema = z
  .record(z.string().min(1), modelRefOrChainSchema)
  .refine((m) => 'default' in m, { message: 'models.default is required' })

// Zod's `z.record(..., refine)` doesn't refine the inferred type. The
// `default` key is schema-enforced, so we narrow it here to spare every
// consumer the `T | undefined` assertion noise.
export type Models = Record<string, KnownModelRef[]> & { default: KnownModelRef[] }

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    // `default(() => ...)` ensures every parsed config has at least
    // `models.default`. Direct `.default({ default: ... })` would short-circuit
    // the refinement, so we lean on the lazy thunk form. The default value is
    // shaped to match the post-transform output (always `KnownModelRef[]`),
    // not the user-facing input shape.
    models: modelsSchema.default(() => ({ default: [DEFAULT_MODEL_REF] })) as unknown as z.ZodType<Models>,
    // Defaults to `[]` so the field can be omitted from `typeclaw.json` (no
    // host paths exposed) without failing the whole config load. `typeclaw
    // init` omits this field so users don't see noise for the empty case.
    mounts: z.array(mountSchema).default([]),
    mcpServers: z.array(mcpServerSchema).default([]),
    plugins: z.array(z.string().min(1)).default([]),
    // Additional names the agent answers to in channel engagement, on top
    // of `basename(agentDir)` which is always implicit. Each entry is a
    // plain string matched case-insensitively as a substring of the
    // inbound text. Empty/whitespace-only entries are rejected at parse
    // time. Defaults to `[]`. Hatching appends the agent's chosen name
    // here, so a freshly-hatched bot already has its identity wired up.
    alias: z.array(z.string().trim().min(1)).default([]),
    channels: channelsSchema,
    portForward: portForwardSchema,
    network: networkSchema,
    docker: dockerSchema,
    git: gitSchema,
    roles: rolesConfigSchema.optional(),
    tunnels: tunnelsArraySchema,
  })
  .catchall(z.unknown())

export type Config = z.infer<typeof configSchema>

export function resolveModel(ref: KnownModelRef): Model<'openai-completions'> | Model<'openai-responses'> {
  // Model IDs can contain '/', so split only on the first separator.
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash) as KnownProviderId
  const modelId = ref.slice(slash + 1)
  return KNOWN_PROVIDERS[providerId].models[modelId as never]
}

// Resolves a profile name (e.g. `fast`, `deep`, `vision`) to its fallback
// chain. Unknown profiles fall back to `default` so callers can pass through
// arbitrary subagent-declared or user-overridden strings without crashing.
// `refs` is non-empty (the schema guarantees `default` exists and every value
// is at least one ref). `ref` is the head of the chain — the model the
// session is created with first. Callers that don't implement fallback can
// keep reading `ref`; fallback-aware callers iterate `refs`.
export type ResolvedProfile = {
  ref: KnownModelRef
  refs: KnownModelRef[]
  profile: string
  fellBackToDefault: boolean
}

export function resolveProfile(models: Models, name: string | undefined): ResolvedProfile {
  const requested = name ?? 'default'
  const refs = models[requested]
  if (refs !== undefined) {
    return { ref: refs[0]!, refs, profile: requested, fellBackToDefault: false }
  }
  const fallback = models.default
  return { ref: fallback[0]!, refs: fallback, profile: 'default', fellBackToDefault: true }
}

// Resolves a mount's `path` field to an absolute host path, mirroring shell
// expansion rules: `~`/`~/...` → home dir, relative → resolved against `cwd`,
// absolute → unchanged. Single source of truth so validation and Docker arg
// building agree on the resolved path.
export function expandMountPath(input: string, cwd: string): string {
  if (input === '~' || input.startsWith('~/')) {
    return join(homedir(), input.slice(1))
  }
  return isAbsolute(input) ? input : resolve(cwd, input)
}

// Loaded eagerly from process.cwd()/typeclaw.json at module-import time so
// citty arg defaults (e.g. config.port in src/cli/*.ts) see real values, not
// hardcoded fallbacks. Missing file → schema defaults; malformed file → ALSO
// schema defaults plus a stderr warning.
//
// Why soft-fail and not throw: every CLI command — including diagnostic ones
// (`typeclaw status`, `typeclaw doctor`, `typeclaw logs`, `typeclaw stop`,
// `typeclaw usage`, `typeclaw tui`) — pays this eager-load cost through its
// import graph, regardless of whether the command actually reads config. A
// hard throw here turns every read-only diagnostic into a crash exactly when
// the user needs the diagnostic to figure out what's wrong with their config.
// `validateConfig` (called by `start`/`restart`/`reload`/host-side mutations)
// is the strict gate for destructive paths; that's where malformed-config
// errors should surface, not at module-import time.
//
// `config` is a module-import-time snapshot. Container-stage code that must
// observe `typeclaw run` reloads should call `getConfig()` instead, which
// returns the current swapped-in value. Host-stage CLI processes are
// short-lived, so they keep using `config` directly.
export const config: Config = loadConfigSyncOrDefaults(process.cwd())

export function loadConfigSyncOrDefaults(cwd: string, options: { warn?: (message: string) => void } = {}): Config {
  try {
    return loadConfigSync(cwd)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const warn = options.warn ?? ((message: string) => process.stderr.write(message))
    warn(
      `warning: ${detail}\n` +
        `warning: continuing with default config so diagnostic commands still work; ` +
        `run \`typeclaw doctor\` or fix ${CONFIG_FILE} before \`typeclaw start\`/\`restart\`/\`reload\`.\n`,
    )
    return configSchema.parse({})
  }
}

let current: Config = config

export function getConfig(): Config {
  return current
}

// Test-only: restore the live pointer to the module-import-time snapshot. Lets
// reload-aware tests run without leaking a swapped pointer into other test
// files that still mutate the eager `config` export directly.
export function __resetConfigForTesting(): void {
  current = config
}

export type ConfigChange = {
  path: string
  before: unknown
  after: unknown
}

export type ConfigReloadDiff = {
  applied: ConfigChange[]
  restartRequired: ConfigChange[]
  ignored: ConfigChange[]
}

// Reloads typeclaw.json from disk and atomically swaps the live config pointer
// on success. Throws (and leaves `current` untouched) when the file is
// malformed or schema-invalid — callers translate that into a `Reloadable`
// failure result.
export function reloadConfig(cwd: string): ConfigReloadDiff {
  const next = loadConfigSync(cwd)
  const diff = diffConfig(current, next)
  current = next
  return diff
}

// Field classification. The fence is intentional: only fields that are read
// fresh on each session/subagent/cron-reload land in `applied`. Boot-only
// fields (port, mounts, container/server bind) are reported as
// `restartRequired` so the user knows the reload landed but the change won't
// take effect until restart.
export type FieldEffect = 'applied' | 'restart-required' | 'ignored'

export const FIELD_EFFECTS: Record<string, FieldEffect> = {
  $schema: 'ignored',
  models: 'applied',
  port: 'restart-required',
  mounts: 'restart-required',
  mcpServers: 'restart-required',
  plugins: 'restart-required',
  alias: 'applied',
  channels: 'applied',
  portForward: 'restart-required',
  network: 'restart-required',
  tunnels: 'restart-required',
  'docker.file': 'restart-required',
  'git.ignore': 'restart-required',
  // Split: `match` lists are reload-safe (typeclaw role claim, hand-edits
  // adding/removing match rules apply without a container restart);
  // `permissions` lists are restart-required (changing what a role can DO
  // is a bigger deal than changing WHO fills it, and several consumers —
  // plugin contexts, the security plugin guards — capture the permissions
  // contract at boot). The diff machinery in diffConfig() understands
  // `roles.match` and `roles.permissions` as virtual paths and compares
  // the corresponding projections of the whole `roles` block.
  'roles.match': 'applied',
  'roles.permissions': 'restart-required',
}

// Stable JSON for value comparison. Fields are small JSON-shaped objects, so
// JSON.stringify with sorted keys is sufficient and avoids a deep-equal dep.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

function diffConfig(before: Config, after: Config): ConfigReloadDiff {
  const diff: ConfigReloadDiff = { applied: [], restartRequired: [], ignored: [] }
  const keys = new Set<string>(Object.keys(FIELD_EFFECTS))

  for (const path of keys) {
    const b = readPath(before, path)
    const a = readPath(after, path)
    if (stableStringify(b) === stableStringify(a)) continue

    const change: ConfigChange = { path, before: b, after: a }
    const effect = FIELD_EFFECTS[path] ?? 'applied'
    if (effect === 'applied') diff.applied.push(change)
    else if (effect === 'restart-required') diff.restartRequired.push(change)
    else diff.ignored.push(change)
  }

  return diff
}

function readPath(obj: unknown, path: string): unknown {
  if (path === 'roles.match') return projectRoles(obj, 'match')
  if (path === 'roles.permissions') return projectRoles(obj, 'permissions')
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function projectRoles(obj: unknown, field: 'match' | 'permissions'): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined
  const roles = (obj as Record<string, unknown>).roles
  if (typeof roles !== 'object' || roles === null) return undefined
  const projection: Record<string, unknown> = {}
  for (const [roleName, roleVal] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof roleVal !== 'object' || roleVal === null) continue
    const val = (roleVal as Record<string, unknown>)[field]
    if (val !== undefined) projection[roleName] = val
  }
  return projection
}

// Plugin configs live at the top level of typeclaw.json keyed by plugin name
// (e.g. "standup-log": { ... }). They are preserved by configSchema.catchall(z.unknown())
// because the schema does not predeclare these keys. This helper returns the
// raw map of unknown values keyed by plugin name; the plugin loader re-validates
// each block against its plugin's `configSchema`.
export function extractPluginConfigs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const known = new Set([
    '$schema',
    'port',
    'models',
    'mounts',
    'plugins',
    'alias',
    'channels',
    'portForward',
    'network',
    'docker',
    'git',
    'roles',
    'permissions',
  ])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) result[key] = value
  }
  return result
}

export function loadPluginConfigsSync(cwd: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return {}
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  const migrated = migrateLegacyConfigShape(json)
  if (migrated.changed) {
    persistMigratedConfig(cwd, migrated.json, migrated.applied)
  }
  return extractPluginConfigs(migrated.json)
}

export function loadConfigSync(cwd: string): Config {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return configSchema.parse({})
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${detail}`)
  }

  const migrated = migrateLegacyConfigShape(json)
  if (migrated.changed) {
    persistMigratedConfig(cwd, migrated.json, migrated.applied)
  }

  const result = configSchema.safeParse(migrated.json)
  if (!result.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${formatZodError(result.error)}`)
  }
  return result.data
}

// One-shot rename of legacy top-level `dockerfile` / `gitignore` keys into the
// nested `docker.file` / `git.ignore` shape introduced for namespace
// extensibility (`docker.compose`, `git.attributes`, etc. land here later
// without a second migration). Called from every entry point that reads
// `typeclaw.json` so the rest of the pipeline only ever sees the new shape.
//
// Precedence when both legacy and new keys coexist: the new shape wins and
// the legacy key is dropped silently. Two ways this happens in practice:
//   1. User hand-edited the new shape after auto-migration but forgot to
//      delete the legacy key.
//   2. Two `typeclaw start` invocations raced on a stale checkout.
// Either way, the new shape is the source of truth — losing the legacy
// duplicate is the right call because it would otherwise be shadowed at
// parse time anyway (`configSchema` has no `dockerfile`/`gitignore` keys).
//
// The returned `applied` array names each migration step that fired, so
// callers in `typeclaw start` can build a meaningful git commit message
// instead of a generic "migrate legacy shape" subject. `changed` is the
// boolean equivalent of `applied.length > 0` and is preserved for back-compat
// with the many call sites that only care whether ANY rewrite happened.
export type MigrationStep =
  | { kind: 'dockerfile-to-docker-file' }
  | { kind: 'gitignore-to-git-ignore' }
  | { kind: 'channels-allow-to-roles-member-match'; rules: string[]; dropped: string[] }
  | { kind: 'strip-permissions-gate-channel-respond' }
  | { kind: 'model-to-models'; ref: string }
  | { kind: 'drop-stale-model'; ref: string }

export type MigrationResult = { json: unknown; changed: boolean; applied: MigrationStep[] }

export function migrateLegacyConfigShape(json: unknown): MigrationResult {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { json, changed: false, applied: [] }
  }

  const obj = json as Record<string, unknown>
  const hasLegacyDockerfile = 'dockerfile' in obj
  const hasLegacyGitignore = 'gitignore' in obj
  const channelsAllowMigration = collectChannelsAllowMigration(obj)
  const hasLegacyGateChannelRespond = isPlainObject(obj.permissions) && 'gateChannelRespond' in obj.permissions
  // The pre-multi-model schema had a top-level `model: KnownModelRef` and no
  // `models` key. Detecting the legacy shape requires both: `model` present
  // AND `models` absent. If both coexist (user hand-edited after auto-migrate
  // but didn't delete the legacy key), `models` wins and `model` is dropped
  // silently — same precedence rule as the dockerfile/gitignore migrations.
  const hasLegacyModel = 'model' in obj && !('models' in obj) && typeof obj.model === 'string'
  const hasStaleModelAlongsideModels = 'model' in obj && 'models' in obj
  if (
    !hasLegacyDockerfile &&
    !hasLegacyGitignore &&
    !channelsAllowMigration.found &&
    !hasLegacyGateChannelRespond &&
    !hasLegacyModel &&
    !hasStaleModelAlongsideModels
  ) {
    return { json, changed: false, applied: [] }
  }

  const applied: MigrationStep[] = []
  const next: Record<string, unknown> = { ...obj }
  if (hasLegacyDockerfile) {
    const legacy = next.dockerfile
    delete next.dockerfile
    if (!('docker' in next)) {
      next.docker = { file: legacy }
    } else if (isPlainObject(next.docker) && !('file' in next.docker)) {
      next.docker = { ...next.docker, file: legacy }
    }
    applied.push({ kind: 'dockerfile-to-docker-file' })
  }
  if (hasLegacyGitignore) {
    const legacy = next.gitignore
    delete next.gitignore
    if (!('git' in next)) {
      next.git = { ignore: legacy }
    } else if (isPlainObject(next.git) && !('ignore' in next.git)) {
      next.git = { ...next.git, ignore: legacy }
    }
    applied.push({ kind: 'gitignore-to-git-ignore' })
  }
  if (channelsAllowMigration.found) {
    applyChannelsAllowMigration(next, channelsAllowMigration)
    applied.push({
      kind: 'channels-allow-to-roles-member-match',
      rules: channelsAllowMigration.rules,
      dropped: channelsAllowMigration.warnings,
    })
  }
  if (hasLegacyGateChannelRespond) {
    const perms = { ...(next.permissions as Record<string, unknown>) }
    delete perms.gateChannelRespond
    if (Object.keys(perms).length === 0) {
      delete next.permissions
    } else {
      next.permissions = perms
    }
    applied.push({ kind: 'strip-permissions-gate-channel-respond' })
  }
  if (hasLegacyModel) {
    const ref = next.model as string
    delete next.model
    next.models = { default: ref }
    applied.push({ kind: 'model-to-models', ref })
  } else if (hasStaleModelAlongsideModels) {
    // `models` wins (per the same precedence rule as dockerfile/gitignore), but
    // the drop is still a tracked migration step so the disk rewrite gets a
    // commit instead of silently dirtying the worktree. Without this, the
    // file would be rewritten by persistMigratedConfig and no commit would
    // fire (buildConfigMigrationCommitMessage returns null for empty applied
    // lists), contradicting the invariant in persistMigratedConfig's comment.
    const ref = typeof next.model === 'string' ? next.model : ''
    delete next.model
    applied.push({ kind: 'drop-stale-model', ref })
  }
  return { json: next, changed: true, applied }
}

// Builds a meaningful one-line git commit subject for a typeclaw.json
// migration. Single-step migrations get a specific subject; multi-step ones
// fall back to a stable summary subject with the count. The body (after the
// blank line) enumerates each step so `git log -p typeclaw.json` is an
// auditable trail of what legacy shapes the agent has graduated from.
//
// Returns null when no steps were applied — callers should not commit in
// that case. Keeping the null branch here (vs an empty string) makes the
// "nothing happened" case impossible to misuse at the call site.
export function buildConfigMigrationCommitMessage(applied: readonly MigrationStep[]): string | null {
  const first = applied[0]
  if (first === undefined) return null

  const subject =
    applied.length === 1
      ? `typeclaw.json: ${shortStepLabel(first)}`
      : `typeclaw.json: migrate legacy shape (${applied.length} steps)`

  const bodyLines: string[] = applied.map((step) => `- ${describeStep(step)}`)

  // Surface dropped rules in the commit body so a user inspecting `git log -p`
  // sees exactly which legacy entries had to be hand-re-added (the lossy
  // `channel:<id>` case). Without this, the silent-drop is invisible after
  // the fact.
  for (const step of applied) {
    if (step.kind === 'channels-allow-to-roles-member-match' && step.dropped.length > 0) {
      for (const warning of step.dropped) {
        bodyLines.push(`  warning: ${warning}`)
      }
    }
  }

  return `${subject}\n\n${bodyLines.join('\n')}\n`
}

function shortStepLabel(step: MigrationStep): string {
  switch (step.kind) {
    case 'dockerfile-to-docker-file':
      return 'lift dockerfile → docker.file'
    case 'gitignore-to-git-ignore':
      return 'lift gitignore → git.ignore'
    case 'channels-allow-to-roles-member-match':
      return 'lift channels.<adapter>.allow[] → roles.member.match[]'
    case 'strip-permissions-gate-channel-respond':
      return 'drop permissions.gateChannelRespond'
    case 'model-to-models':
      return 'lift model → models.default'
    case 'drop-stale-model':
      return 'drop stale legacy model alongside models'
  }
}

function describeStep(step: MigrationStep): string {
  switch (step.kind) {
    case 'dockerfile-to-docker-file':
      return 'lift top-level dockerfile into docker.file'
    case 'gitignore-to-git-ignore':
      return 'lift top-level gitignore into git.ignore'
    case 'channels-allow-to-roles-member-match': {
      if (step.rules.length === 0) {
        return 'strip channels.<adapter>.allow[] (no translatable rules)'
      }
      return `lift channels.<adapter>.allow[] → roles.member.match[]: ${step.rules.join(', ')}`
    }
    case 'strip-permissions-gate-channel-respond':
      return 'drop permissions.gateChannelRespond (removed key)'
    case 'model-to-models':
      return `lift top-level model into models.default: ${step.ref}`
    case 'drop-stale-model':
      return step.ref !== ''
        ? `drop stale top-level model (${step.ref}) — models block takes precedence`
        : 'drop stale top-level model — models block takes precedence'
  }
}

// Channels.<adapter>.allow[] → roles.member.match[] migration.
//
// Phase 3 removes the per-adapter allow-list and unifies wake-up gating
// through `roles.member.match[]` + the `channel.respond` permission. This
// helper translates legacy `allow` entries into canonical match-rule DSL
// strings and appends them (deduplicated, preserving declaration order)
// to `roles.member.match[]`. The `allow` field is then stripped from each
// adapter block; the block survives — only the field is gone.
//
// `channel:<id>` rules cannot round-trip (the DSL forbids
// wildcard-workspace + specific-chat) and are dropped with a warning. All
// other shapes translate losslessly per the table in match-rule.ts.
type ChannelsAllowMigration = {
  found: boolean
  rules: string[]
  warnings: string[]
}

function collectChannelsAllowMigration(obj: Record<string, unknown>): ChannelsAllowMigration {
  const out: ChannelsAllowMigration = { found: false, rules: [], warnings: [] }
  const channels = obj.channels
  if (!isPlainObject(channels)) return out
  for (const [adapter, value] of Object.entries(channels)) {
    if (!isPlainObject(value)) continue
    if (!('allow' in value)) continue
    out.found = true
    const allow = value.allow
    if (!Array.isArray(allow)) continue
    for (const entry of allow) {
      if (typeof entry !== 'string') continue
      const translated = translateLegacyAllowRule(entry)
      if (translated.kind === 'rule') {
        out.rules.push(translated.value)
      } else {
        out.warnings.push(`channels.${adapter}.allow[]: dropped '${entry}' (${translated.reason})`)
      }
    }
  }
  return out
}

function applyChannelsAllowMigration(next: Record<string, unknown>, migration: ChannelsAllowMigration): void {
  const channels = next.channels
  if (isPlainObject(channels)) {
    const updated: Record<string, unknown> = {}
    for (const [adapter, value] of Object.entries(channels)) {
      if (isPlainObject(value) && 'allow' in value) {
        const { allow: _allow, ...rest } = value
        updated[adapter] = rest
      } else {
        updated[adapter] = value
      }
    }
    next.channels = updated
  }

  if (migration.rules.length === 0) {
    for (const warning of migration.warnings) {
      console.warn(`[config] ${warning}`)
    }
    return
  }

  const roles = isPlainObject(next.roles) ? { ...next.roles } : {}
  const member = isPlainObject(roles.member) ? { ...roles.member } : {}
  const existingMatch = Array.isArray(member.match)
    ? (member.match as unknown[]).filter((m) => typeof m === 'string')
    : []
  const seen = new Set<string>(existingMatch as string[])
  const merged = [...(existingMatch as string[])]
  for (const rule of migration.rules) {
    if (!seen.has(rule)) {
      seen.add(rule)
      merged.push(rule)
    }
  }
  member.match = merged
  roles.member = member
  next.roles = roles

  console.warn(`[config] migrated channels.<adapter>.allow[] -> roles.member.match[]: ${migration.rules.join(', ')}`)
  for (const warning of migration.warnings) {
    console.warn(`[config] ${warning}`)
  }
}

type TranslatedRule = { kind: 'rule'; value: string } | { kind: 'drop'; reason: string }

function translateLegacyAllowRule(rule: string): TranslatedRule {
  // Already canonical / cross-platform.
  if (rule === '*') return { kind: 'rule', value: '*' }
  if (rule.startsWith('kakao:')) return { kind: 'rule', value: rule }

  // Discord: guild → discord, dm → discord:dm.
  if (rule === 'guild:*') return { kind: 'rule', value: 'discord:*' }
  if (rule.startsWith('guild:')) return { kind: 'rule', value: `discord:${rule.slice('guild:'.length)}` }
  if (rule === 'dm:*') return { kind: 'rule', value: 'discord:dm/*' }
  if (rule.startsWith('dm:')) return { kind: 'rule', value: `discord:dm/${rule.slice('dm:'.length)}` }

  // Slack: team → slack, im → slack:dm.
  if (rule === 'team:*') return { kind: 'rule', value: 'slack:*' }
  if (rule.startsWith('team:')) return { kind: 'rule', value: `slack:${rule.slice('team:'.length)}` }
  if (rule === 'im:*') return { kind: 'rule', value: 'slack:dm/*' }
  if (rule.startsWith('im:')) return { kind: 'rule', value: `slack:dm/${rule.slice('im:'.length)}` }

  // Telegram: tg → telegram.
  if (rule === 'tg:*') return { kind: 'rule', value: 'telegram:*' }
  if (rule.startsWith('tg:')) return { kind: 'rule', value: `telegram:${rule.slice('tg:'.length)}` }

  // `channel:<id>` had no workspace; canonical DSL rejects wildcard
  // workspace + specific chat. Drop with a warning so the operator knows
  // to re-add the rule explicitly with a workspace coordinate.
  if (rule.startsWith('channel:')) {
    return {
      kind: 'drop',
      reason:
        'channel:<id> rules require an explicit workspace under the new DSL; re-add as discord:<guild>/<id> or slack:<team>/<id>',
    }
  }

  return { kind: 'drop', reason: `unrecognized legacy allow shape '${rule}'` }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function persistMigratedConfig(cwd: string, json: unknown, applied: readonly MigrationStep[]): void {
  try {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(json, null, 2)}\n`)
  } catch {
    // Best-effort write-back: the migration is also applied in-memory on every
    // load, so a read-only filesystem (e.g. snapshotted CI checkout) just
    // means the rewrite retries next start. Surfacing the error would brick
    // load paths the user didn't ask to mutate. Bail before the commit step
    // too — without the write there's nothing to commit.
    return
  }

  // Pair the disk rewrite with a git commit so the agent folder is never
  // silently dirty after a legacy-shape migration. typeclaw.json is in
  // git's "tracked" category (unlike Dockerfile, which is regenerated on
  // every start and intentionally gitignored), so an uncommitted rewrite
  // gets mixed into unrelated commits the moment any other tool touches
  // the repo. commitSystemFileSync no-ops on non-git folders, missing
  // Bun, and clean files, so canonical-shape reads pay zero cost.
  //
  // Called from every entry point that reads typeclaw.json (host CLI,
  // hostd daemon, container runtime) so the commit follows the rewrite
  // wherever it happens — not only from `typeclaw start`. The earlier
  // design that committed only in start() missed the long-running hostd
  // daemon, doctor, tui, reload, and compose paths.
  const message = buildConfigMigrationCommitMessage(applied)
  if (message !== null) {
    commitSystemFileSync(cwd, CONFIG_FILE, message)
  }
}

export type ValidateConfigResult = { ok: true } | { ok: false; reason: string }

// Missing file → ok (matches `loadMounts` in src/container/up.ts; `isInitialized`
// is the dedicated check for "not initialized"). Present but invalid → fail, so
// `restart` doesn't stop the container before discovering the config is broken.
//
// Mount accessibility is checked here (after schema parse succeeds) so every
// caller — `typeclaw start`, `restart`, `reload`, hostd's restart RPC — fails
// fast with a clear, mount-named error instead of letting Docker surface a
// confusing path-sharing error (or, on some Linux setups, silently bind-mount
// an empty auto-created directory). First-failure reporting matches the
// schema-error path's shape; users fix one and re-run.
export type ValidateConfigOptions = {
  // Skip the mount-path accessibility check. Host-side callers leave this
  // false (the default) so missing mount directories surface as a precise
  // pre-`docker run` error. Container-side callers (the reload registry)
  // set it true because mount paths in typeclaw.json are host paths and
  // don't resolve inside the container's filesystem.
  skipMounts?: boolean
}

export function validateConfig(cwd: string, options: ValidateConfigOptions = {}): ValidateConfigResult {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return { ok: true }
  }

  const parsed = parseConfigJson(raw, { migrate: true, persistTarget: cwd })
  if (!parsed.ok) return parsed

  if (!options.skipMounts) {
    for (const mount of parsed.config.mounts) {
      const check = validateMount(mount, cwd)
      if (!check.ok) return check
    }
  }

  return { ok: true }
}

export type ParseConfigJsonResult = { ok: true; config: Config } | { ok: false; reason: string }

export type ParseConfigJsonOptions = {
  // Run `migrateLegacyConfigShape` before schema validation. Defaults to true
  // so callers don't reject content the agent could have written through
  // legacy keys; pass false to validate the exact bytes (used in tests).
  migrate?: boolean
  // When set, persist + commit the migrated shape to this agent dir if the
  // migration ran. Only `validateConfig` uses this; the guard's in-memory
  // validation never persists (the bytes aren't yet on disk).
  persistTarget?: string
}

// Pure validator for an in-memory `typeclaw.json` string. Used by the
// managed-config guard to reject `write`/`edit` calls that would land an
// invalid file on disk. Does NOT check mount accessibility — that is the
// runtime concern handled by `validateConfig` at `typeclaw start` time, and
// the file the agent is producing may legitimately reference a mount path
// that only exists on the host outside the container.
export function parseConfigJson(raw: string, options: ParseConfigJsonOptions = {}): ParseConfigJsonResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${detail}` }
  }

  const shouldMigrate = options.migrate ?? true
  const migrated = shouldMigrate
    ? migrateLegacyConfigShape(json)
    : { json, changed: false, applied: [] as MigrationStep[] }
  if (migrated.changed && options.persistTarget !== undefined) {
    persistMigratedConfig(options.persistTarget, migrated.json, migrated.applied)
  }

  const result = configSchema.safeParse(migrated.json)
  if (!result.success) {
    return { ok: false, reason: `${CONFIG_FILE} is invalid: ${formatZodError(result.error)}` }
  }
  return { ok: true, config: result.data }
}

// Verifies a mount's host path: exists, is a directory, is readable, and is
// writable when not declared `readOnly`. Symlinks are followed (statSync's
// default) so a broken symlink reads as "does not exist". Permission checks
// are skipped when running as root (uid 0) — euidaccess returns success
// regardless, so the test would be vacuous and inconsistent with non-root.
export function validateMount(mount: Mount, cwd: string): ValidateConfigResult {
  const resolved = expandMountPath(mount.path, cwd)
  const label = `mount "${mount.name}"`

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, reason: `${label}: path ${resolved} does not exist` }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${label}: cannot stat ${resolved}: ${detail}` }
  }

  if (!stats.isDirectory()) {
    return { ok: false, reason: `${label}: path ${resolved} is not a directory` }
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (isRoot) return { ok: true }

  try {
    accessSync(resolved, fsConstants.R_OK)
  } catch {
    return { ok: false, reason: `${label}: path ${resolved} is not readable` }
  }

  if (!mount.readOnly) {
    try {
      accessSync(resolved, fsConstants.W_OK)
    } catch {
      return {
        ok: false,
        reason: `${label}: path ${resolved} is not writable (declare readOnly: true if read-only access is intended)`,
      }
    }
  }

  return { ok: true }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
