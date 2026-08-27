import { definePlugin } from '@/plugin'

import { checkMemoryTopicsDeleteGuard, checkUncommittedChangesAdvice } from './policy'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'tool.before': async (event, ctx) => {
        const memoryTopicsDeleteResult = checkMemoryTopicsDeleteGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
          origin: event.origin,
        })
        if (memoryTopicsDeleteResult) return memoryTopicsDeleteResult
        return undefined
      },
      'tool.after': async (event, ctx) => {
        await checkUncommittedChangesAdvice({
          tool: event.tool,
          agentDir: ctx.agentDir,
          result: event.result,
        })
      },
    },
  }),
})
