import { definePlugin } from '@/plugin'

import { checkBunHygieneGuard } from './policy'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'tool.before': (event) => checkBunHygieneGuard({ tool: event.tool, args: event.args }),
    },
  }),
})
