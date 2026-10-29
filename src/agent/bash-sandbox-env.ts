import { join } from 'node:path'

import { readEnvFile } from '@/init/env-file'
import { resolveExposableEnvNames } from '@/sandbox/env-exposure'
type BashEnvOverlay = Record<string, string>
const SECRET_BASH_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN'])
// Transport classifier for the TRUSTED hook-injected overlay only (e.g.
// github-cli-auth's per-repo GH_TOKEN). Token/secret-shaped names use `inherit`
// so their value never renders into the bwrap argv; plain names (GH_REPO) go
// via `set`. This is NOT a .env exposure filter — the overlay is populated by
// trusted runtime hooks, not operator .env.
const OVERLAY_SECRET_NAME_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH)$/i
function isOverlaySecretName(name: string): boolean {
  return SECRET_BASH_ENV_NAMES.has(name) || OVERLAY_SECRET_NAME_PATTERN.test(name)
}

export function buildSandboxEnvPolicy(
  overlay: BashEnvOverlay | undefined,
  runtimeEnv: Record<string, string> | undefined,
  exposableEnvNames: readonly string[] = [],
  withhold: readonly string[] = [],
): { inherit?: string[]; set?: Record<string, string>; withhold?: string[] } {
  const requestedWithhold = new Set(withhold)
  const overlayNames = new Set(Object.keys(overlay ?? {}))
  // The overlay is a deliberate command-scoped replacement, while withholding
  // only removes ambient values; an overlay therefore wins for the same name.
  const effectiveWithhold = [...requestedWithhold].filter((name) => !overlayNames.has(name))
  const effectiveWithholdSet = new Set(effectiveWithhold)
  const set = Object.fromEntries(Object.entries(runtimeEnv ?? {}).filter(([key]) => !requestedWithhold.has(key)))
  const inherit: string[] = []
  const inheritSeen = new Set<string>()
  const pushInherit = (key: string): void => {
    if (effectiveWithholdSet.has(key) || Object.hasOwn(set, key) || inheritSeen.has(key)) return
    inheritSeen.add(key)
    inherit.push(key)
  }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (Object.hasOwn(set, key)) continue
    if (isOverlaySecretName(key)) pushInherit(key)
    else set[key] = value
  }
  // Operator-declared .env vars pass through by NAME (inherit), keeping values
  // out of the rendered bwrap argv. Sandbox-integrity names were already dropped
  // in resolveExposableEnvNames — these are the survivors.
  for (const key of exposableEnvNames) pushInherit(key)
  // Pass the entrypoint-exported Xvfb display (start_xvfb: `export DISPLAY=:99`)
  // through --clearenv, else sandboxed `agent-browser --headed` dies with
  // "Missing X server or $DISPLAY". Passing the runtime's OWN value (not a fixed
  // ":99") keeps `docker.file.xvfb=false` advertising no display. Rendered via
  // `set` (a display number is neither a credential nor shell-injectable), and no
  // /tmp/.X11-unix bind is needed: Chrome reaches Xvfb over the netns-scoped
  // abstract X11 socket while bash keeps network:'inherit'.
  const display = process.env['DISPLAY']
  if (
    display !== undefined &&
    display !== '' &&
    !effectiveWithholdSet.has('DISPLAY') &&
    !Object.hasOwn(set, 'DISPLAY') &&
    !inheritSeen.has('DISPLAY')
  ) {
    set['DISPLAY'] = display
  }
  return {
    ...(inherit.length > 0 ? { inherit } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(effectiveWithhold.length > 0 ? { withhold: effectiveWithhold } : {}),
  }
}

export function spreadSandboxEnv(policy: ReturnType<typeof buildSandboxEnvPolicy>): {
  env?: ReturnType<typeof buildSandboxEnvPolicy>
} {
  return Object.keys(policy).length > 0 ? { env: policy } : {}
}

export function resolveExposableBashEnvNames(agentDir: string): { exposable: string[]; withheld: string[] } {
  const declaredEnv = readEnvFile(agentDir)
  const exposable = resolveExposableEnvNames(declaredEnv, process.env)
  const exposableSet = new Set(exposable)
  const withheld = [...declaredEnv]
    .filter(([name, value]) => value.length > 0 && !exposableSet.has(name))
    .map(([name]) => name)
  return { exposable, withheld }
}

export function buildRoleScopedConfigEnv(
  agentDir: string,
  hiddenDirs: string[],
  envOverlay: BashEnvOverlay | undefined,
): BashEnvOverlay | undefined {
  // Low-trust roles have workspace/ masked. Do not let container-global config
  // env vars point CLIs back at that private surface: apps that honor XDG should
  // still run, but their config must land in the sandbox's per-session /tmp.
  // Trusted/owner have only the unconditional credential-dir masks, not the
  // workspace root mask, so their command broker decides whether to set GWS.
  const workspaceHidden = hiddenDirs.includes(join(agentDir, 'workspace'))
  if (!workspaceHidden) return envOverlay

  return {
    ...envOverlay,
    XDG_CONFIG_HOME: '/tmp/.config',
    GWS_CONFIG_HOME: '/tmp/.config/gws',
  }
}
