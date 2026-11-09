// Browser engines and extensions that `typeclaw.json#browser` can enable.
//
// An engine is a driver the model runs from bash (a CLI or a library). Every
// engine except the legacy agent-browser default attaches to the one
// TypeClaw-managed Chrome over CDP, so tabs and logins persist across bash
// calls and every engine sees the same extensions. An extension is loaded into
// that managed Chrome once, so every engine benefits from it.

export const BROWSER_ENGINE_IDS = ['agent-browser', 'omowright', 'browser-use'] as const
export type BrowserEngineId = (typeof BROWSER_ENGINE_IDS)[number]

export const BROWSER_EXTENSION_IDS = ['browserskill'] as const
export type BrowserExtensionId = (typeof BROWSER_EXTENSION_IDS)[number]

export type BrowserEngineInstall =
  // Already in every image: agent-browser installs the Chrome every engine shares.
  | { kind: 'image' }
  | { kind: 'bun-global'; spec: string }
  | { kind: 'uv-tool'; package: string; version: string; python: string }

export type BrowserEngineSpec = {
  id: BrowserEngineId
  install: BrowserEngineInstall
  // Env for sandboxed bash when the managed browser is running, keyed off its
  // CDP URL. Also carries phone-home opt-outs.
  env: (cdpUrl: string) => Record<string, string>
}

export type BrowserExtensionSpec = {
  id: BrowserExtensionId
  version: string
  zip: { url: string; sha256: string }
  cli: { name: string; urlByArch: Record<'amd64' | 'arm64', { url: string; sha256: string }> }
}

export const BROWSER_ROOT = '/usr/local/lib/typeclaw-browser'

// Installed by the base image for agent-browser; the launcher adds --no-sandbox
// because Chrome's own sandbox cannot run inside bwrap.
export const CHROME_LAUNCHER = '/usr/local/lib/typeclaw-agent-browser/chrome'

export const BSK_BIN = `${BROWSER_ROOT}/bsk/bsk`
export const BSK_SHIM = `${BROWSER_ROOT}/bsk/shim.mjs`
// BrowserSkill's extension dials its daemon here, inside the browser sandbox.
export const BSK_DAEMON_PORT = 52800

export const OMOWRIGHT_MODULE = `${BROWSER_ROOT}/omowright/index.js`

const OMOWRIGHT_COMMIT = '7d98044a9ade8c54a4b9fd5a14e2befee2d48144'
const BROWSER_USE_VERSION = '0.13.11'
const BSK_VERSION = '0.3.3'
const BSK_RELEASES = 'https://github.com/Tencent/BrowserSkill/releases/download'

export const BROWSER_ENGINES: Record<BrowserEngineId, BrowserEngineSpec> = {
  'agent-browser': {
    id: 'agent-browser',
    install: { kind: 'image' },
    env: (cdpUrl) => ({ AGENT_BROWSER_CDP: cdpUrl }),
  },
  omowright: {
    id: 'omowright',
    install: { kind: 'bun-global', spec: `github:code-yeongyu/omowright#${OMOWRIGHT_COMMIT}` },
    env: (cdpUrl) => ({ OMOWRIGHT_CDP_URL: cdpUrl }),
  },
  'browser-use': {
    id: 'browser-use',
    install: { kind: 'uv-tool', package: 'browser-use', version: BROWSER_USE_VERSION, python: '3.12' },
    env: (cdpUrl) => ({ BU_CDP_WS: cdpUrl, ANONYMIZED_TELEMETRY: 'false' }),
  },
}

export const BROWSER_EXTENSIONS: Record<BrowserExtensionId, BrowserExtensionSpec> = {
  browserskill: {
    id: 'browserskill',
    version: BSK_VERSION,
    zip: {
      url: `${BSK_RELEASES}/ext-v${BSK_VERSION}/browser-skill-extension-v${BSK_VERSION}-chrome.zip`,
      sha256: '10ef76e68f352893fa22dd4cce2f1b96cb90ed957b815d656e13180d07d3c6ea',
    },
    cli: {
      name: 'bsk',
      urlByArch: {
        amd64: {
          url: `${BSK_RELEASES}/cli-v${BSK_VERSION}/bsk-v${BSK_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
          sha256: '141b73489bec99d768cf18042919f0e054c9f614e6ecdfd754028d2b606e9106',
        },
        arm64: {
          url: `${BSK_RELEASES}/cli-v${BSK_VERSION}/bsk-v${BSK_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
          sha256: '747e4c416da46650c7d8127a47dd8f08e813e0f69366c4db1af226d0b63a575d',
        },
      },
    },
  },
}

export type BrowserConfig = {
  engines: readonly BrowserEngineId[]
  extensions: readonly BrowserExtensionId[]
}

// The managed Chrome exists only for engines that attach over CDP or for
// extensions. The default `["agent-browser"]` keeps today's per-session
// agent-browser browser, so existing agents see no change.
export function needsManagedBrowser(config: BrowserConfig): boolean {
  return config.extensions.length > 0 || config.engines.some((id) => id !== 'agent-browser')
}

export function extensionDir(id: BrowserExtensionId): string {
  return `${BROWSER_ROOT}/extensions/${id}`
}
