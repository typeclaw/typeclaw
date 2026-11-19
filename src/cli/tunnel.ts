import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { select, text, password, isCancel, cancel, log } from '@clack/prompts'
import { defineCommand } from 'citty'

import { loadConfigSync, parseConfigJson, validateConfig } from '@/config'
import { tryRecordConfigCommitSync } from '@/config/config-commits'
import { withConfigFileLockSync } from '@/config/config-file-lock'
import { CONTAINER_PORT, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir, hasEnvKey, isInitialized, withEnvKey } from '@/init'
import {
  credentialStagingDir,
  publishConfigWithCredential,
  type PublishSeams,
  writeConfigInPlace,
} from '@/init/staged-write'
import type { ClientMessage, ServerMessage, TunnelLogsServerMessage, TunnelSnapshot } from '@/shared'
import type { TunnelConfig, TunnelFor, TunnelProvider } from '@/tunnels'

import { c, errorLine } from './ui'

type AddArgs = {
  name?: string
  provider?: string
  forChannel?: string
  forManual?: boolean
  upstreamPort?: string
  externalUrl?: string
  hostname?: string
  tokenEnv?: string
}

type SetArgs = {
  name?: string
  provider?: string
  upstreamPort?: string
  externalUrl?: string
  hostname?: string
  tokenEnv?: string
}

type RemoveArgs = { name: string }

type LiveArgs = { url?: string; timeout?: string }

type LogsArgs = LiveArgs & { name: string; follow?: boolean }

type LiveResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export type TextValidator = (value: string) => string | undefined

export type TunnelSetField = 'provider' | 'externalUrl' | 'hostname' | 'tokenEnv' | 'upstreamPort'

export type TunnelPrompts = {
  selectProvider: () => Promise<TunnelProvider | symbol>
  selectOwner: () => Promise<'channel' | 'manual' | symbol>
  // Only `runTunnelSetFlow` uses this; `runTunnelAddFlow` callers can omit it.
  selectSetField?: (
    choices: readonly { value: TunnelSetField; label: string; hint?: string }[],
  ) => Promise<TunnelSetField | symbol>
  // Only `runTunnelSetFlow` uses this when the positional `name` is omitted
  // and more than one tunnel is configured. Optional so existing callers
  // (especially `runTunnelAddFlow` tests) don't have to stub it.
  selectExistingTunnel?: (
    choices: readonly { value: string; label: string; hint?: string }[],
  ) => Promise<string | symbol>
  text: (message: string, validate?: TextValidator) => Promise<string | symbol>
  // Only fires when the user picks `cloudflare-named` AND the resolved
  // `tokenEnv` is missing from the agent's `.env`. Optional so existing
  // callers/tests don't have to stub it; flows that need it but don't get
  // one fall back to skipping the token write (the user can still set
  // `.env` by hand). Same compat pattern as `selectSetField`.
  password?: (message: string, validate?: TextValidator) => Promise<string | symbol>
}

const DEFAULT_TUNNEL_TOKEN_ENV = 'CLOUDFLARE_TUNNEL_TOKEN'

const DEFAULT_TIMEOUT_MS = 15_000

const defaultPrompts: TunnelPrompts = {
  selectProvider: () =>
    select<TunnelProvider>({
      message: 'Tunnel provider',
      options: [
        { value: 'cloudflare-quick', label: 'Cloudflare Quick Tunnel', hint: 'no signup, URL rotates on restart' },
        {
          value: 'cloudflare-named',
          label: 'Cloudflare Named Tunnel',
          hint: 'stable URL, needs Cloudflare account + domain',
        },
        { value: 'external', label: 'External URL', hint: 'bring your own reverse proxy' },
      ],
    }),
  selectOwner: () =>
    select<'channel' | 'manual'>({
      message: 'Tunnel owner',
      options: [
        { value: 'channel', label: 'Channel' },
        { value: 'manual', label: 'Manual upstream' },
      ],
    }),
  selectSetField: (choices) =>
    select<TunnelSetField>({
      message: 'Which field do you want to change?',
      options: choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        ...(choice.hint !== undefined ? { hint: choice.hint } : {}),
      })),
    }),
  selectExistingTunnel: (choices) =>
    select<string>({
      message: 'Pick a tunnel to edit',
      options: choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        ...(choice.hint !== undefined ? { hint: choice.hint } : {}),
      })),
    }),
  text: (message, validate) =>
    text({ message, ...(validate !== undefined ? { validate: (v) => validate(v ?? '') } : {}) }),
  password: (message, validate) =>
    password({ message, ...(validate !== undefined ? { validate: (v) => validate(v ?? '') } : {}) }),
}

const addSub = defineCommand({
  meta: { name: 'add', description: 'add a public tunnel entry to typeclaw.json' },
  args: {
    name: { type: 'positional', required: false, description: 'tunnel name (omit to prompt interactively)' },
    provider: { type: 'string', description: 'external | cloudflare-quick | cloudflare-named' },
    'for-channel': { type: 'string', description: 'own this tunnel from a channel adapter' },
    'for-manual': { type: 'boolean', description: 'create a manually-owned tunnel' },
    'upstream-port': { type: 'string', description: 'container-local upstream port for manual tunnels' },
    'external-url': { type: 'string', description: 'https URL for provider=external' },
    hostname: { type: 'string', description: 'https URL for provider=cloudflare-named (dashboard Public Hostname)' },
    'token-env': {
      type: 'string',
      description: 'env var name holding the cloudflared token (provider=cloudflare-named)',
    },
  },
  async run({ args }) {
    const result = await runTunnelAddFlow(ensureAgentDir(), {
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.provider !== undefined ? { provider: String(args.provider) } : {}),
      ...(args['for-channel'] !== undefined ? { forChannel: String(args['for-channel']) } : {}),
      ...(args['for-manual'] === true ? { forManual: true } : {}),
      ...(args['upstream-port'] !== undefined ? { upstreamPort: String(args['upstream-port']) } : {}),
      ...(args['external-url'] !== undefined ? { externalUrl: String(args['external-url']) } : {}),
      ...(args.hostname !== undefined ? { hostname: String(args.hostname) } : {}),
      ...(args['token-env'] !== undefined ? { tokenEnv: String(args['token-env']) } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    log.success(`Added tunnel "${result.value.name}" to typeclaw.json.`)
    log.info('Run typeclaw restart to apply.')
  },
})

const listSub = defineCommand({
  meta: { name: 'list', description: 'list live tunnels from the running agent' },
  args: liveArgs(),
  async run({ args }) {
    const result = await fetchTunnelList({ cwd: ensureAgentDir(), ...parseLiveArgs(args as LiveArgs) })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    process.stdout.write(`${formatTunnelList(result.value)}\n`)
  },
})

const statusSub = defineCommand({
  meta: { name: 'status', description: 'show one live tunnel in detail' },
  args: { name: { type: 'positional', required: true, description: 'tunnel name' }, ...liveArgs() },
  async run({ args }) {
    const live = parseLiveArgs(args as LiveArgs)
    const result = await fetchTunnelStatus({ cwd: ensureAgentDir(), name: String(args.name), ...live })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    const logs = await fetchTunnelLogs({ cwd: ensureAgentDir(), name: String(args.name), follow: false, ...live })
    const lines = logs.ok ? logs.value : []
    process.stdout.write(`${formatTunnelStatus(result.value, lines)}\n`)
  },
})

const removeSub = defineCommand({
  meta: { name: 'remove', description: 'remove a manually-owned tunnel from typeclaw.json' },
  args: { name: { type: 'positional', required: true, description: 'tunnel name' } },
  async run({ args }) {
    const result = runTunnelRemoveFlow(ensureAgentDir(), args as RemoveArgs)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    log.success(`Removed tunnel "${args.name}" from typeclaw.json.`)
    log.info('Run typeclaw restart to apply.')
  },
})

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'edit an existing tunnel entry in typeclaw.json (symmetric with `typeclaw channel set`)',
  },
  args: {
    name: { type: 'positional', required: false, description: 'tunnel name (omit to pick interactively)' },
    provider: { type: 'string', description: 'external | cloudflare-quick | cloudflare-named' },
    'upstream-port': { type: 'string', description: 'container-local upstream port (manual non-named tunnels)' },
    'external-url': { type: 'string', description: 'https URL for provider=external' },
    hostname: { type: 'string', description: 'https URL for provider=cloudflare-named (dashboard Public Hostname)' },
    'token-env': {
      type: 'string',
      description: 'env var name holding the cloudflared token (provider=cloudflare-named)',
    },
  },
  async run({ args }) {
    const result = await runTunnelSetFlow(ensureAgentDir(), {
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.provider !== undefined ? { provider: String(args.provider) } : {}),
      ...(args['upstream-port'] !== undefined ? { upstreamPort: String(args['upstream-port']) } : {}),
      ...(args['external-url'] !== undefined ? { externalUrl: String(args['external-url']) } : {}),
      ...(args.hostname !== undefined ? { hostname: String(args.hostname) } : {}),
      ...(args['token-env'] !== undefined ? { tokenEnv: String(args['token-env']) } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    log.success(`Updated tunnel "${result.value.name}" in typeclaw.json.`)
    if (result.value.for.kind === 'channel') {
      // The container-side adapter (see src/channels/adapters/github/index.ts)
      // re-runs webhook registration on every start. A restart is required
      // anyway because `tunnels` is restart-required (FIELD_EFFECTS in
      // src/config/config.ts), so on the next start the adapter picks up the
      // new URL and re-points its managed webhooks at it. No CLI-side
      // eager re-install needed.
      log.info(`Run typeclaw restart to apply (the ${result.value.for.name} adapter will re-register its webhooks).`)
    } else {
      log.info('Run typeclaw restart to apply.')
    }
  },
})

const logsSub = defineCommand({
  meta: { name: 'logs', description: 'print or follow a tunnel log ring' },
  args: {
    name: { type: 'positional', required: true, description: 'tunnel name' },
    follow: { type: 'boolean', alias: 'f', description: 'follow new log lines' },
    ...liveArgs(),
  },
  async run({ args }) {
    const live = parseLiveArgs(args as LiveArgs)
    const result = await streamTunnelLogs(
      {
        cwd: ensureAgentDir(),
        name: String(args.name),
        follow: args.follow === true,
        ...live,
      },
      (line) => {
        process.stdout.write(`${line}\n`)
      },
    )
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
  },
})

export const tunnelCommand = defineCommand({
  meta: { name: 'tunnel', description: 'manage public tunnels for channels and manual upstreams' },
  subCommands: { add: addSub, set: setSub, list: listSub, status: statusSub, remove: removeSub, logs: logsSub },
})

export async function runTunnelAddFlow(
  cwd: string,
  args: AddArgs,
  prompts: TunnelPrompts = defaultPrompts,
): Promise<LiveResult<TunnelConfig>> {
  // Strict gate before any read: a malformed or schema-invalid `typeclaw.json`
  // would otherwise throw out of the subsequent `loadConfigSync` and surface
  // as an uncaught exception instead of the clean exit-1-with-reason that
  // every other LiveResult consumer expects. Same fence PR #288 documented
  // for the `start`/`restart`/`reload` path: destructive paths route through
  // `validateConfig` so the file's invariants are checked once, up front,
  // and the rest of the flow can lean on them.
  const validation = validateConfig(cwd)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const config = loadConfigSync(cwd)
  const existingNames = new Set(config.tunnels.map((entry) => entry.name))
  const name = args.name ?? (await promptText('Tunnel name', prompts, makeTunnelNameValidator(existingNames)))
  const nameError = validateTunnelName(name, existingNames)
  if (nameError !== undefined) return { ok: false, reason: nameError }

  const provider = await resolveProvider(args.provider, prompts)
  const tunnelFor = await resolveFor(args, prompts)
  let upstreamPort: number | undefined
  if (tunnelFor.kind === 'manual' && provider !== 'cloudflare-named') {
    const raw = args.upstreamPort ?? (await promptText('Upstream port', prompts, validateUpstreamPort))
    const portError = validateUpstreamPort(raw)
    if (portError !== undefined) return { ok: false, reason: `upstream port: ${portError}` }
    upstreamPort = Number(raw)
  }
  let externalUrl: string | undefined
  if (provider === 'external') {
    externalUrl = args.externalUrl ?? (await promptText('External HTTPS URL', prompts, validateHttpsUrl))
    const urlError = validateHttpsUrl(externalUrl)
    if (urlError !== undefined) return { ok: false, reason: `external URL: ${urlError}` }
  }
  let hostname: string | undefined
  let tokenEnv: string | undefined
  let tokenValue: string | undefined
  if (provider === 'cloudflare-named') {
    hostname =
      args.hostname ??
      (await promptText(
        'Public hostname configured in the Cloudflare dashboard (https://...)',
        prompts,
        validateHttpsUrl,
      ))
    const hostnameError = validateHttpsUrl(hostname)
    if (hostnameError !== undefined) return { ok: false, reason: `hostname: ${hostnameError}` }
    tokenEnv = args.tokenEnv ?? DEFAULT_TUNNEL_TOKEN_ENV
    const tokenError = validateTokenEnv(tokenEnv)
    if (tokenError !== undefined) return { ok: false, reason: `token-env: ${tokenError}` }
    // Only prompt for the token VALUE in interactive mode. `--provider` on
    // the CLI signals scripted invocation; bombarding a script with a
    // password prompt it can't satisfy would deadlock CI runs.
    if (args.provider === undefined) {
      const tokenPromptResult = await maybePromptTunnelTokenValue(cwd, tokenEnv, prompts)
      if (!tokenPromptResult.ok) return tokenPromptResult
      tokenValue = tokenPromptResult.value
    }
  }

  const tunnel: TunnelConfig = {
    name,
    provider,
    for: tunnelFor,
    ...(externalUrl !== undefined ? { externalUrl } : {}),
    ...(upstreamPort !== undefined ? { upstreamPort } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
  }
  // The prompts above can take a while, so another writer may have changed the
  // tunnels since they were read; append to the tunnels as they are now.
  const added = withConfigFileLockSync(join(cwd, 'typeclaw.json'), (): LiveResult<TunnelConfig> => {
    const current = readTunnelsInLock(cwd)
    if (!current.ok) return current
    if (current.value.some((entry) => entry.name === name)) {
      return {
        ok: false,
        reason: `tunnel "${name}" was added by another typeclaw.json writer while this add was in progress; nothing was written. Rerun \`typeclaw tunnel add\` with a different name.`,
      }
    }
    const raw = readRawConfig(cwd)
    raw.tunnels = [...current.value, tunnel]
    if (provider === 'cloudflare-quick' || provider === 'cloudflare-named') {
      raw.docker = { ...asRecord(raw.docker), file: { ...asRecord(asRecord(raw.docker).file), cloudflared: true } }
    }
    const token = tokenEnv !== undefined && tokenValue !== undefined ? { env: tokenEnv, value: tokenValue } : undefined
    const written = writeConfigAndToken(cwd, raw, token, 'typeclaw tunnel add')
    if (!written.ok) return written
    return { ok: true, value: tunnel }
  })
  if (added.ok) loadConfigSync(cwd)
  return added
}

export function runTunnelRemoveFlow(cwd: string, args: RemoveArgs): LiveResult<{ removed: TunnelConfig }> {
  // Same strict gate as `runTunnelAddFlow`. See the comment there for why.
  const validation = validateConfig(cwd)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const removed = withConfigFileLockSync(join(cwd, 'typeclaw.json'), (): LiveResult<{ removed: TunnelConfig }> => {
    const current = readTunnelsInLock(cwd)
    if (!current.ok) return current
    const tunnel = current.value.find((entry) => entry.name === args.name)
    if (tunnel === undefined) return { ok: false, reason: `unknown tunnel: ${args.name}` }
    if (tunnel.for.kind === 'channel') {
      return {
        ok: false,
        reason: `tunnel "${args.name}" is owned by channel "${tunnel.for.name}". Use \`typeclaw tunnel set ${args.name}\` to change its provider/URL, or hand-edit typeclaw.json to remove both the channel block and the tunnel.`,
      }
    }
    const raw = readRawConfig(cwd)
    raw.tunnels = current.value.filter((entry) => entry.name !== args.name)
    writeRawConfig(cwd, raw)
    return { ok: true, value: { removed: tunnel } }
  })
  if (removed.ok) loadConfigSync(cwd)
  return removed
}

export async function runTunnelSetFlow(
  cwd: string,
  args: SetArgs,
  prompts: TunnelPrompts = defaultPrompts,
): Promise<LiveResult<TunnelConfig>> {
  const validation = validateConfig(cwd)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const config = loadConfigSync(cwd)
  if (config.tunnels.length === 0) {
    return { ok: false, reason: 'no tunnels configured. Run `typeclaw tunnel add` first.' }
  }
  const nameResult =
    args.name !== undefined
      ? { ok: true as const, value: args.name }
      : await resolveExistingTunnelName(config.tunnels, prompts)
  if (!nameResult.ok) return nameResult
  const existing = config.tunnels.find((entry) => entry.name === nameResult.value)
  if (existing === undefined) return { ok: false, reason: `unknown tunnel: ${nameResult.value}` }

  const flagFields = collectSetFlagFields(args)
  const interactive = flagFields.length === 0

  let nextProvider = existing.provider
  let nextExternalUrl = existing.externalUrl
  let nextHostname = existing.hostname
  let nextTokenEnv = existing.tokenEnv
  let nextUpstreamPort = existing.upstreamPort

  if (args.provider !== undefined) {
    const resolved = await resolveProvider(args.provider, prompts)
    nextProvider = resolved
  } else if (interactive) {
    const choices = buildSetFieldChoices(existing)
    if (choices.length === 0) {
      return {
        ok: false,
        reason: `tunnel "${existing.name}" has no editable fields for provider "${existing.provider}"`,
      }
    }
    if (prompts.selectSetField === undefined) {
      return { ok: false, reason: 'interactive set requires selectSetField prompt (pass a flag, e.g. --provider)' }
    }
    const field = await prompts.selectSetField(choices)
    if (isCancel(field)) {
      cancel('Aborted.')
      process.exit(0)
    }
    if (field === 'provider') {
      nextProvider = await resolveProvider(undefined, prompts)
    } else {
      const interactivePatch = await collectInteractiveFieldPatch(field, prompts)
      if (!interactivePatch.ok) return interactivePatch
      nextExternalUrl = interactivePatch.value.externalUrl ?? nextExternalUrl
      nextHostname = interactivePatch.value.hostname ?? nextHostname
      nextTokenEnv = interactivePatch.value.tokenEnv ?? nextTokenEnv
      nextUpstreamPort = interactivePatch.value.upstreamPort ?? nextUpstreamPort
    }
  }

  if (args.externalUrl !== undefined) {
    const err = validateHttpsUrl(args.externalUrl)
    if (err !== undefined) return { ok: false, reason: `external URL: ${err}` }
    nextExternalUrl = args.externalUrl
  }
  if (args.hostname !== undefined) {
    const err = validateHttpsUrl(args.hostname)
    if (err !== undefined) return { ok: false, reason: `hostname: ${err}` }
    nextHostname = args.hostname
  }
  if (args.tokenEnv !== undefined) {
    const err = validateTokenEnv(args.tokenEnv)
    if (err !== undefined) return { ok: false, reason: `token-env: ${err}` }
    nextTokenEnv = args.tokenEnv
  }
  if (args.upstreamPort !== undefined) {
    const err = validateUpstreamPort(args.upstreamPort)
    if (err !== undefined) return { ok: false, reason: `upstream port: ${err}` }
    nextUpstreamPort = Number(args.upstreamPort)
  }

  // On a provider switch, drop fields the new provider forbids and require
  // fields the new provider needs. This mirrors the per-provider refinements
  // in tunnelEntrySchema (src/config/config.ts) so the schema-validation
  // round-trip after write doesn't fail on stale fields from the old shape.
  if (nextProvider !== existing.provider) {
    if (nextProvider !== 'external') nextExternalUrl = undefined
    if (nextProvider !== 'cloudflare-named') {
      nextHostname = undefined
      nextTokenEnv = undefined
    }
    if (nextProvider === 'cloudflare-named') nextUpstreamPort = undefined
    if (nextProvider === 'external' && nextExternalUrl === undefined) {
      const raw =
        args.externalUrl ??
        (interactive ? await promptText('External HTTPS URL', prompts, validateHttpsUrl) : undefined)
      if (raw === undefined) return { ok: false, reason: "provider 'external' requires --external-url" }
      const err = validateHttpsUrl(raw)
      if (err !== undefined) return { ok: false, reason: `external URL: ${err}` }
      nextExternalUrl = raw
    }
    if (nextProvider === 'cloudflare-named') {
      if (nextHostname === undefined) {
        const raw =
          args.hostname ??
          (interactive
            ? await promptText(
                'Public hostname configured in the Cloudflare dashboard (https://...)',
                prompts,
                validateHttpsUrl,
              )
            : undefined)
        if (raw === undefined) return { ok: false, reason: "provider 'cloudflare-named' requires --hostname" }
        const err = validateHttpsUrl(raw)
        if (err !== undefined) return { ok: false, reason: `hostname: ${err}` }
        nextHostname = raw
      }
      if (nextTokenEnv === undefined) {
        const raw = args.tokenEnv ?? DEFAULT_TUNNEL_TOKEN_ENV
        const err = validateTokenEnv(raw)
        if (err !== undefined) return { ok: false, reason: `token-env: ${err}` }
        nextTokenEnv = raw
      }
    }
    if (existing.for.kind === 'manual' && nextProvider !== 'cloudflare-named' && nextUpstreamPort === undefined) {
      const raw = interactive ? await promptText('Upstream port', prompts, validateUpstreamPort) : undefined
      if (raw === undefined)
        return { ok: false, reason: 'manual tunnels require --upstream-port (except cloudflare-named)' }
      const err = validateUpstreamPort(raw)
      if (err !== undefined) return { ok: false, reason: `upstream port: ${err}` }
      nextUpstreamPort = Number(raw)
    }
  }

  const next: TunnelConfig = {
    name: existing.name,
    provider: nextProvider,
    for: existing.for,
    ...(nextExternalUrl !== undefined ? { externalUrl: nextExternalUrl } : {}),
    ...(nextUpstreamPort !== undefined ? { upstreamPort: nextUpstreamPort } : {}),
    ...(nextHostname !== undefined ? { hostname: nextHostname } : {}),
    ...(nextTokenEnv !== undefined ? { tokenEnv: nextTokenEnv } : {}),
  }

  let tokenValue: string | undefined
  if (interactive && next.provider === 'cloudflare-named' && next.tokenEnv !== undefined) {
    const tokenPromptResult = await maybePromptTunnelTokenValue(cwd, next.tokenEnv, prompts)
    if (!tokenPromptResult.ok) return tokenPromptResult
    tokenValue = tokenPromptResult.value
  }

  // The prompts above can take a while, so another writer may have changed or
  // removed this tunnel since it was read. Edit it only if it is still exactly
  // the entry the new values were built from.
  const updated = withConfigFileLockSync(join(cwd, 'typeclaw.json'), (): LiveResult<TunnelConfig> => {
    const current = readTunnelsInLock(cwd)
    if (!current.ok) return current
    const fresh = current.value.find((entry) => entry.name === existing.name)
    if (fresh === undefined || !isDeepStrictEqual(fresh, existing)) {
      return {
        ok: false,
        reason: `tunnel "${existing.name}" was ${fresh === undefined ? 'removed' : 'changed'} by another typeclaw.json writer while this edit was in progress; nothing was written. Rerun \`typeclaw tunnel set ${existing.name}\` against the current config.`,
      }
    }
    const raw = readRawConfig(cwd)
    raw.tunnels = current.value.map((entry) => (entry.name === existing.name ? next : entry))
    if (nextProvider === 'cloudflare-quick' || nextProvider === 'cloudflare-named') {
      raw.docker = { ...asRecord(raw.docker), file: { ...asRecord(asRecord(raw.docker).file), cloudflared: true } }
    }
    // The strict gate above already validated the on-disk shape; validating the
    // new bytes here catches any schema violation (e.g. a provider/field
    // combination the explicit checks above missed) and surfaces it as a clean
    // LiveResult before anything is written, so typeclaw.json never ends up
    // in an invalid state.
    const check = parseConfigJson(JSON.stringify(raw))
    if (!check.ok) return check
    const token =
      next.tokenEnv !== undefined && tokenValue !== undefined ? { env: next.tokenEnv, value: tokenValue } : undefined
    const written = writeConfigAndToken(cwd, raw, token, `typeclaw tunnel set ${existing.name}`)
    if (!written.ok) return written
    return { ok: true, value: next }
  })
  if (updated.ok) loadConfigSync(cwd)
  return updated
}

function collectSetFlagFields(args: SetArgs): TunnelSetField[] {
  const out: TunnelSetField[] = []
  if (args.provider !== undefined) out.push('provider')
  if (args.externalUrl !== undefined) out.push('externalUrl')
  if (args.hostname !== undefined) out.push('hostname')
  if (args.tokenEnv !== undefined) out.push('tokenEnv')
  if (args.upstreamPort !== undefined) out.push('upstreamPort')
  return out
}

function buildSetFieldChoices(existing: TunnelConfig): { value: TunnelSetField; label: string; hint?: string }[] {
  const choices: { value: TunnelSetField; label: string; hint?: string }[] = [
    { value: 'provider', label: 'Provider', hint: `currently ${existing.provider}` },
  ]
  if (existing.provider === 'external') {
    choices.push({ value: 'externalUrl', label: 'External URL', hint: existing.externalUrl ?? '-' })
  }
  if (existing.provider === 'cloudflare-named') {
    choices.push({ value: 'hostname', label: 'Hostname', hint: existing.hostname ?? '-' })
    choices.push({ value: 'tokenEnv', label: 'Token env var name', hint: existing.tokenEnv ?? '-' })
  }
  if (existing.for.kind === 'manual' && existing.provider !== 'cloudflare-named') {
    choices.push({
      value: 'upstreamPort',
      label: 'Upstream port',
      hint: existing.upstreamPort !== undefined ? String(existing.upstreamPort) : '-',
    })
  }
  return choices
}

async function collectInteractiveFieldPatch(
  field: Exclude<TunnelSetField, 'provider'>,
  prompts: TunnelPrompts,
): Promise<LiveResult<{ externalUrl?: string; hostname?: string; tokenEnv?: string; upstreamPort?: number }>> {
  switch (field) {
    case 'externalUrl': {
      const value = await promptText('External HTTPS URL', prompts, validateHttpsUrl)
      const err = validateHttpsUrl(value)
      if (err !== undefined) return { ok: false, reason: `external URL: ${err}` }
      return { ok: true, value: { externalUrl: value } }
    }
    case 'hostname': {
      const value = await promptText(
        'Public hostname configured in the Cloudflare dashboard (https://...)',
        prompts,
        validateHttpsUrl,
      )
      const err = validateHttpsUrl(value)
      if (err !== undefined) return { ok: false, reason: `hostname: ${err}` }
      return { ok: true, value: { hostname: value } }
    }
    case 'tokenEnv': {
      const value = await promptText('Env var name holding the tunnel token', prompts, validateTokenEnv)
      const err = validateTokenEnv(value)
      if (err !== undefined) return { ok: false, reason: `token-env: ${err}` }
      return { ok: true, value: { tokenEnv: value } }
    }
    case 'upstreamPort': {
      const value = await promptText('Upstream port', prompts, validateUpstreamPort)
      const err = validateUpstreamPort(value)
      if (err !== undefined) return { ok: false, reason: `upstream port: ${err}` }
      return { ok: true, value: { upstreamPort: Number(value) } }
    }
  }
}

export async function fetchTunnelList(opts: {
  cwd: string
  url?: string
  timeoutMs?: number
}): Promise<LiveResult<TunnelSnapshot[]>> {
  return withTuiSocket(opts, async (ws, timeoutMs) => {
    const requestId = `tunnel-list-${crypto.randomUUID()}`
    const msg: ClientMessage = { type: 'tunnel_list_request', requestId }
    ws.send(JSON.stringify(msg))
    const reply = await waitForServerMessage(
      ws,
      timeoutMs,
      (m) => m.type === 'tunnel_list_response' && m.requestId === requestId,
    )
    if (reply.type !== 'tunnel_list_response') throw new Error('unreachable')
    return reply.ok ? { ok: true, value: reply.tunnels } : { ok: false, reason: reply.error }
  })
}

export async function fetchTunnelStatus(opts: {
  cwd: string
  name: string
  url?: string
  timeoutMs?: number
}): Promise<LiveResult<TunnelSnapshot>> {
  return withTuiSocket(opts, async (ws, timeoutMs) => {
    const requestId = `tunnel-status-${crypto.randomUUID()}`
    const msg: ClientMessage = { type: 'tunnel_status_request', requestId, name: opts.name }
    ws.send(JSON.stringify(msg))
    const reply = await waitForServerMessage(
      ws,
      timeoutMs,
      (m) => m.type === 'tunnel_status_response' && m.requestId === requestId,
    )
    if (reply.type !== 'tunnel_status_response') throw new Error('unreachable')
    return reply.ok ? { ok: true, value: reply.tunnel } : { ok: false, reason: reply.error }
  })
}

export async function fetchTunnelLogs(opts: {
  cwd: string
  name: string
  url?: string
  timeoutMs?: number
  follow?: false
}): Promise<LiveResult<string[]>> {
  const lines: string[] = []
  const result = await streamTunnelLogs({ ...opts, follow: false }, (line) => lines.push(line))
  return result.ok ? { ok: true, value: lines } : result
}

export async function streamTunnelLogs(
  opts: { cwd: string; name: string; url?: string; timeoutMs?: number; follow?: boolean },
  onLine: (line: string) => void,
): Promise<LiveResult<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const urlResult = await resolveWsUrl(opts.cwd, opts.url, '/tunnel-logs')
  if (!urlResult.ok) return urlResult
  const ws = new WebSocket(urlResult.value)
  try {
    await waitForOpen(ws, timeoutMs)
    ws.send(JSON.stringify({ type: 'subscribe', name: opts.name, follow: opts.follow === true }))
    return await new Promise<LiveResult<void>>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timed out waiting for tunnel logs' }), timeoutMs)
      const onSigint = () => {
        cleanup()
        ws.close()
        resolve({ ok: true, value: undefined })
      }
      const cleanup = () => {
        clearTimeout(timer)
        process.off('SIGINT', onSigint)
        ws.removeEventListener('message', onMessage)
      }
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as TunnelLogsServerMessage
        if (msg.type === 'snapshot') for (const line of msg.lines) onLine(line)
        else if (msg.type === 'line') onLine(msg.line)
        else if (msg.type === 'error') {
          cleanup()
          ws.close()
          resolve({ ok: false, reason: msg.message })
        } else if (msg.type === 'end') {
          cleanup()
          ws.close()
          resolve({ ok: true, value: undefined })
        }
      }
      process.once('SIGINT', onSigint)
      ws.addEventListener('message', onMessage)
    })
  } catch (err) {
    ws.close()
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function formatTunnelList(tunnels: readonly TunnelSnapshot[]): string {
  if (tunnels.length === 0) return c.dim('No tunnels configured.')
  const rows = tunnels.map((t) => [
    t.name,
    t.provider,
    formatFor(t.for),
    t.url ?? '-',
    t.status,
    formatLast(t.lastUrlAt),
  ])
  const widths = [4, 8, 3, 3, 6, 12].map((min, i) => Math.max(min, ...rows.map((row) => row[i]!.length)))
  const header = ['NAME', 'PROVIDER', 'FOR', 'URL', 'STATUS', 'LAST-ROTATED']
    .map((h, i) => h.padEnd(widths[i]!))
    .join('  ')
  return [c.dim(header), ...rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '))].join('\n')
}

export function formatTunnelStatus(tunnel: TunnelSnapshot, lines: readonly string[]): string {
  const out = [
    `${c.bold(tunnel.name)} ${c.dim(`[${tunnel.provider}]`)}`,
    `  ${c.dim('for        ')} ${formatFor(tunnel.for)}`,
    `  ${c.dim('current URL')} ${tunnel.url ?? '-'}`,
    `  ${c.dim('status     ')} ${tunnel.status}`,
    `  ${c.dim('lastUrlAt  ')} ${formatLast(tunnel.lastUrlAt)}`,
    `  ${c.dim('detail     ')} ${tunnel.detail}`,
  ]
  if (lines.length > 0) out.push('', c.dim('Recent logs:'), ...lines.map((line) => `  ${line}`))
  return out.join('\n')
}

function liveArgs() {
  return {
    url: { type: 'string', description: 'agent websocket url' },
    timeout: {
      type: 'string',
      description: 'milliseconds to wait for the agent to respond',
      default: String(DEFAULT_TIMEOUT_MS),
    },
  } as const
}

function parseLiveArgs(args: LiveArgs): { url?: string; timeoutMs: number } {
  const timeoutMs = Number(args.timeout ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout value: ${args.timeout}`)
  return { ...(args.url !== undefined ? { url: args.url } : {}), timeoutMs }
}

async function resolveExistingTunnelName(
  tunnels: readonly TunnelConfig[],
  prompts: TunnelPrompts,
): Promise<LiveResult<string>> {
  if (tunnels.length === 1) return { ok: true, value: tunnels[0]!.name }
  if (prompts.selectExistingTunnel === undefined) {
    return {
      ok: false,
      reason: 'interactive set requires selectExistingTunnel prompt (pass the tunnel name positionally)',
    }
  }
  const choices = tunnels.map((entry) => ({
    value: entry.name,
    label: entry.name,
    hint: `${entry.provider} · ${entry.for.kind === 'channel' ? `channel:${entry.for.name}` : 'manual'}`,
  }))
  const choice = await prompts.selectExistingTunnel(choices)
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { ok: true, value: choice }
}

// Prompts for the token value; the caller stores it in .env only once its
// typeclaw.json write has won.
async function maybePromptTunnelTokenValue(
  cwd: string,
  tokenEnv: string,
  prompts: TunnelPrompts,
): Promise<LiveResult<string | undefined>> {
  if (hasEnvKey(cwd, tokenEnv)) return { ok: true, value: undefined }
  if (prompts.password === undefined) return { ok: true, value: undefined }
  const value = await prompts.password(`Cloudflare tunnel token (will be written to .env as ${tokenEnv})`, (v) =>
    v.length > 0 ? undefined : 'Token is required',
  )
  if (isCancel(value)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { ok: true, value }
}

async function resolveProvider(input: string | undefined, prompts: TunnelPrompts): Promise<TunnelProvider> {
  if (input === 'external' || input === 'cloudflare-quick' || input === 'cloudflare-named') return input
  if (input !== undefined) throw new Error(`unknown tunnel provider: ${input}`)
  const choice = await prompts.selectProvider()
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

async function resolveFor(args: AddArgs, prompts: TunnelPrompts): Promise<TunnelFor> {
  if (args.forChannel !== undefined && args.forManual === true)
    throw new Error('choose either --for-channel or --for-manual, not both')
  if (args.forChannel !== undefined) return { kind: 'channel', name: args.forChannel }
  if (args.forManual === true) return { kind: 'manual' }
  const choice = await prompts.selectOwner()
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (choice === 'manual') return { kind: 'manual' }
  return {
    kind: 'channel',
    name: await promptText('Channel name', prompts, validateNonEmpty('Channel name is required')),
  }
}

async function promptText(message: string, prompts: TunnelPrompts, validate?: TextValidator): Promise<string> {
  const value = await prompts.text(message, validate)
  if (isCancel(value)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return String(value)
}

function validateNonEmpty(requiredMessage: string): TextValidator {
  return (value) => (value.trim().length > 0 ? undefined : requiredMessage)
}

// Mirrors the regex on `tunnelEntrySchema.name` in src/config/config.ts so
// the interactive prompt rejects shapes the post-write schema validation
// would reject anyway, but with a clear inline error instead of a Zod dump.
const TUNNEL_NAME_REGEX = /^[a-z0-9][a-z0-9-_]*$/

function validateTunnelName(value: string, existing: ReadonlySet<string>): string | undefined {
  if (value.trim().length === 0) return 'Tunnel name is required'
  if (!TUNNEL_NAME_REGEX.test(value)) {
    return 'Tunnel name must match /^[a-z0-9][a-z0-9-_]*$/ (lowercase, digits, dashes, underscores)'
  }
  if (existing.has(value)) return `tunnel "${value}" already exists`
  return undefined
}

function makeTunnelNameValidator(existing: ReadonlySet<string>): TextValidator {
  return (value) => validateTunnelName(value, existing)
}

function validateUpstreamPort(value: string): string | undefined {
  if (value.trim().length === 0) return 'Upstream port is required'
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'Must be an integer between 1 and 65535'
  return undefined
}

function validateHttpsUrl(value: string): string | undefined {
  if (value.trim().length === 0) return 'URL is required'
  if (!value.startsWith('https://')) return 'URL must start with https://'
  try {
    new URL(value)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validateTokenEnv(value: string): string | undefined {
  if (value.trim().length === 0) return 'Env var name is required'
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    return 'Must be an env var name like CLOUDFLARE_TUNNEL_TOKEN (uppercase, digits, underscore)'
  }
  return undefined
}

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

// Called under the config lock once a flow has won its typeclaw.json write.
// The prompted token is stored only if no other command stored that key since
// the prompt; the token and config then land together or not at all
// (`publishConfigWithCredential`). `seams` let tests fail a publish step.
export function writeConfigAndToken(
  cwd: string,
  raw: Record<string, unknown>,
  token: { env: string; value: string } | undefined,
  rerun: string,
  seams: PublishSeams = {},
): LiveResult<void> {
  if (token !== undefined && hasEnvKey(cwd, token.env)) {
    return {
      ok: false,
      reason: `${token.env} was stored in .env by another typeclaw command while this one was in progress; nothing was written. Rerun \`${rerun}\` to use the stored token.`,
    }
  }
  const envPath = join(cwd, '.env')
  const credential =
    token === undefined
      ? undefined
      : {
          path: envPath,
          content: withEnvKey(readFileOrUndefined(envPath)?.toString('utf8') ?? '', token.env, token.value),
          stagingDir: credentialStagingDir(cwd),
        }
  const configBytes = `${JSON.stringify(raw, null, 2)}\n`
  const published = publishConfigWithCredential(join(cwd, 'typeclaw.json'), configBytes, credential, seams)
  if (published.ok) tryRecordConfigCommitSync(join(cwd, 'typeclaw.json'), configBytes)
  return published.ok
    ? { ok: true, value: undefined }
    : { ok: false, reason: `failed to store the tunnel: ${published.reason}` }
}

function readFileOrUndefined(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Tunnels as typeclaw.json holds them now. Parsed without persisting a
// migration, so nothing under the config lock commits to git.
function readTunnelsInLock(cwd: string): LiveResult<TunnelConfig[]> {
  const parsed = parseConfigJson(readFileSync(join(cwd, 'typeclaw.json'), 'utf8'))
  return parsed.ok ? { ok: true, value: parsed.config.tunnels } : parsed
}

function readRawConfig(cwd: string): Record<string, unknown> {
  const file = join(cwd, 'typeclaw.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {}
    throw err
  }
}

function writeRawConfig(cwd: string, config: Record<string, unknown>): void {
  const bytes = `${JSON.stringify(config, null, 2)}\n`
  writeConfigInPlace(join(cwd, 'typeclaw.json'), bytes)
  tryRecordConfigCommitSync(join(cwd, 'typeclaw.json'), bytes)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function withTuiSocket<T>(
  opts: { cwd: string; url?: string; timeoutMs?: number },
  fn: (ws: WebSocket, timeoutMs: number) => Promise<LiveResult<T>>,
): Promise<LiveResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = await resolveWsUrl(opts.cwd, opts.url)
  if (!url.ok) return url
  const ws = new WebSocket(url.value)
  try {
    await waitForOpen(ws, timeoutMs)
    return await fn(ws, timeoutMs)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    ws.close()
  }
}

async function resolveWsUrl(
  cwd: string,
  input?: string,
  pathname = '/',
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveResult<string>> {
  try {
    if (input !== undefined) {
      const url = new URL(input)
      url.pathname = pathname
      return { ok: true, value: url.toString() }
    }
    // In-container short-circuit: when the agent runs `typeclaw tunnel …` from
    // inside its own container (the only way it CAN run it), `docker` is not on
    // $PATH, so the host-side discovery below (resolveHostPort/resolveTuiToken,
    // which both shell out to `docker`) fails and the websocket connect aborts
    // with the opaque `[object ErrorEvent]`. typeclaw's `docker run` sets
    // TYPECLAW_CONTAINER_NAME (always) and TYPECLAW_TUI_TOKEN (when configured),
    // and the agent's WS server listens on CONTAINER_PORT on the container
    // loopback — so we can dial directly without docker. Mirrors the same
    // short-circuit in src/cron/bridge.ts (resolveInContainerUrl).
    const inContainer = resolveInContainerWsUrl(env, pathname)
    if (inContainer !== null) return { ok: true, value: inContainer }
    const url = new URL(`ws://127.0.0.1:${await resolveHostPort({ cwd })}`)
    const token = await resolveTuiToken({ cwd })
    if (token !== null) url.searchParams.set('token', token)
    url.pathname = pathname
    return { ok: true, value: url.toString() }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// Returns null on the host stage (TYPECLAW_CONTAINER_NAME unset), where the
// docker-based discovery in resolveWsUrl is the right path.
export function resolveInContainerWsUrl(env: NodeJS.ProcessEnv, pathname = '/'): string | null {
  if (env.TYPECLAW_CONTAINER_NAME === undefined) return null
  const url = new URL(`ws://127.0.0.1:${CONTAINER_PORT}`)
  const token = env.TYPECLAW_TUI_TOKEN
  if (token !== undefined && token !== '') url.searchParams.set('token', token)
  url.pathname = pathname
  return url.toString()
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting to agent websocket')), timeoutMs)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      (event) => {
        clearTimeout(timer)
        reject(new Error(describeWsErrorEvent(event)))
      },
      { once: true },
    )
  })
}

// A WebSocket 'error' listener fires with an ErrorEvent, NOT an Error. Passing
// it straight to a catch site that does `String(err)` yields the useless
// `[object ErrorEvent]`. Pull the real message out (`.message`, or the nested
// `.error`) so failures read like `Expected 101 status code` / connection
// refused instead.
function describeWsErrorEvent(event: unknown): string {
  if (event instanceof Error) return event.message
  if (typeof event === 'object' && event !== null) {
    const { message, error } = event as { message?: unknown; error?: unknown }
    if (typeof message === 'string' && message !== '') return message
    if (error instanceof Error && error.message !== '') return error.message
  }
  return 'websocket connection failed'
}

function waitForServerMessage(
  ws: WebSocket,
  timeoutMs: number,
  predicate: (msg: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for agent response')), timeoutMs)
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolve(msg)
    }
    ws.addEventListener('message', onMessage)
  })
}

function formatFor(value: TunnelFor): string {
  return value.kind === 'channel' ? `channel:${value.name}` : 'manual'
}

function formatLast(value: number | null): string {
  return value === null ? '-' : new Date(value).toISOString()
}
