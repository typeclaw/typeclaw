import { definePlugin } from '@/plugin'

import {
  checkManagedConfigGuard,
  checkMemoryTopicsDeleteGuard,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
  checkUncommittedChangesAdvice,
} from './policy'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'tool.before': async (event, ctx) => {
        const managedConfigResult = await checkManagedConfigGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
        })
        if (managedConfigResult) return managedConfigResult
        const skillResult = await checkSkillAuthoringGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
        })
        if (skillResult) return skillResult
        const memoryTopicsDeleteResult = checkMemoryTopicsDeleteGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
          origin: event.origin,
        })
        if (memoryTopicsDeleteResult) return memoryTopicsDeleteResult
        return checkNonWorkspaceWriteGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
          origin: event.origin,
        })
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
