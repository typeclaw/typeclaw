import { needsManagedBrowser } from '@/browser/registry'
import { getConfig } from '@/config'
import { definePlugin } from '@/plugin'
import { isTypevaultLive } from '@/typevault/envelope-store'

import { createBrowserSubagent } from './browser-agent'

export default definePlugin({
  plugin: async (ctx) => {
    const config = getConfig()
    const typevault = isTypevaultLive(config.typevault.enabled, ctx.agentDir)
    return {
      subagents: {
        browser: createBrowserSubagent(config.browser, {
          typevault,
          secureFill: needsManagedBrowser(config.browser),
        }),
      },
    }
  },
})
