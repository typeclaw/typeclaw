import { join } from 'node:path'

import { getConfig } from '@/config'
import { definePlugin } from '@/plugin'
import { isTypevaultMarkerFile } from '@/typevault/envelope-store'

import { createBrowserSubagent } from './browser-agent'

export default definePlugin({
  plugin: async (ctx) => {
    const config = getConfig()
    const typevault = config.typevault.enabled && isTypevaultMarkerFile(join(ctx.agentDir, 'secrets.json'))
    return {
      subagents: {
        browser: createBrowserSubagent(config.browser, { typevault }),
      },
    }
  },
})
