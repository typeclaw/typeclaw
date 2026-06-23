import {
  ADAPTER_IDS,
  type AdapterId,
  type ChannelAdapterConfig,
  type ChannelInstanceEntry,
  type ChannelsConfig,
} from './schema'

export type ChannelInstanceConfig = {
  adapter: AdapterId
  instanceId: string
  account?: string
  config: ChannelAdapterConfig
}

// Lifecycle keys are manager-local adapter instances (`adapter:instanceId`).
// They are distinct from router route keys (`adapter:workspace`), which address
// conversations after an adapter has connected and discovered its workspace.
export const instanceKeyId = (adapter: AdapterId, instanceId: string): string => `${adapter}:${instanceId}`

export function normalizeChannels(cfg: ChannelsConfig): ChannelInstanceConfig[] {
  return ADAPTER_IDS.flatMap((adapter) => {
    const config = cfg[adapter]
    if (config === undefined) return []
    if (isUserModeAdapter(adapter) && hasInstances(config)) return normalizeInstanceEntries(adapter, config.instances)
    return [{ adapter, instanceId: 'default', config: config as ChannelAdapterConfig }]
  })
}

const USER_MODE_ADAPTERS = new Set<AdapterId>(['discord', 'line', 'kakaotalk', 'slack', 'webex'])

function isUserModeAdapter(adapter: AdapterId): boolean {
  return USER_MODE_ADAPTERS.has(adapter)
}

// An adapter can run multiple instances only when each instance registers its
// router callbacks under an account-unique route key, so two instances never
// share a registry slot. Only Slack qualifies today: it registers under the
// real per-account team id. Discord and Webex register under the shared
// `adapter:*` catch-all (one client serves many guilds/rooms, and two accounts
// can even see the same guild), and KakaoTalk and LINE register under shared
// conversation-bucket keys (`@kakao-dm`, `@line-group`, ...) — for all four a
// second instance would overwrite the first's config/self-identity and mix
// outbound clients. They stay single-instance until routing carries instance
// identity rather than only the route key.
const MULTI_INSTANCE_ADAPTERS = new Set<AdapterId>(['slack'])

export function isMultiInstanceAdapter(adapter: AdapterId): boolean {
  return MULTI_INSTANCE_ADAPTERS.has(adapter)
}

function hasInstances(config: unknown): config is { instances: ChannelInstanceEntry[] } {
  return typeof config === 'object' && config !== null && 'instances' in config
}

function normalizeInstanceEntries(
  adapter: AdapterId,
  entries: readonly ChannelInstanceEntry[],
): ChannelInstanceConfig[] {
  if (entries.length > 1 && !isMultiInstanceAdapter(adapter)) {
    throw new Error(
      `Channel adapter "${adapter}" does not support multiple instances; it registers under shared route keys, so a second instance would overwrite the first. Use a single instance, or run a separate agent.`,
    )
  }
  const seenIds = new Set<string>()
  const seenAccounts = new Set<string>()
  // An omitted `account` resolves to the block's currentAccount at connect
  // time, which is indistinguishable from an explicit account naming that same
  // id. With more than one instance we cannot prove two entries target distinct
  // workspaces unless every entry names its account, so require it; a lone
  // instance may still omit it and bind to currentAccount.
  const requireAccount = entries.length > 1
  return entries.map((entry) => {
    if (seenIds.has(entry.id)) throw new Error(`Duplicate channel instance id for ${adapter}: ${entry.id}`)
    seenIds.add(entry.id)
    if (requireAccount && entry.account === undefined) {
      throw new Error(
        `Channel instance "${entry.id}" for ${adapter} must specify "account": with more than one instance every entry needs an explicit account (an omitted account falls back to the single current account and cannot back multiple instances)`,
      )
    }
    if (entry.account !== undefined) {
      if (seenAccounts.has(entry.account)) {
        throw new Error(`Duplicate channel account for ${adapter}: ${entry.account}`)
      }
      seenAccounts.add(entry.account)
    }
    const { id, account, ...config } = entry
    return {
      adapter,
      instanceId: id,
      ...(account !== undefined ? { account } : {}),
      config,
    }
  })
}
