import { ADAPTER_IDS, type AdapterId, type ChannelAdapterConfig, type ChannelsConfig } from './schema'

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
    return config === undefined ? [] : [{ adapter, instanceId: 'default', config }]
  })
}
