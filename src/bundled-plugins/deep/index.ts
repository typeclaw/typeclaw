import { definePlugin } from '@/plugin'

import { createDeepSubagent } from './deep'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      deep: createDeepSubagent(),
    },
  }),
})
