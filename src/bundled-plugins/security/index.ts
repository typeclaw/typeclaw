import { definePlugin } from '@/plugin'

import { checkAgentBrowserSsrfGuard } from './policies/agent-browser-ssrf'
import { checkGitExfilGuard } from './policies/git-exfil'
import { checkOutboundSecretGuard } from './policies/outbound-secret-scan'
import { applyPromptInjectionDefense } from './policies/prompt-injection'
import { clearSessionTaints } from './policies/remote-taint-state'
import { checkSecretExfilBashGuard } from './policies/secret-exfil-bash'
import { checkSecretExfilReadGuard } from './policies/secret-exfil-read'
import { checkSessionSearchSecretsGuard } from './policies/session-search-secrets'
import { checkSsrfGuard } from './policies/ssrf'
import { checkSystemPromptLeakGuard } from './policies/system-prompt-leak'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'session.prompt': async (event) => {
        applyPromptInjectionDefense(event)
      },
      'tool.before': async (event) => {
        const checks = [
          checkSecretExfilBashGuard({ tool: event.tool, args: event.args }),
          checkGitExfilGuard({ tool: event.tool, args: event.args, sessionId: event.sessionId }),
          checkSecretExfilReadGuard({ tool: event.tool, args: event.args }),
          checkSsrfGuard({ tool: event.tool, args: event.args }),
          checkAgentBrowserSsrfGuard({ tool: event.tool, args: event.args }),
          checkSessionSearchSecretsGuard({ tool: event.tool, args: event.args }),
          checkSystemPromptLeakGuard({ tool: event.tool, args: event.args }),
          checkOutboundSecretGuard({ tool: event.tool, args: event.args }),
        ]
        for (const result of checks) {
          if (result) return result
        }
        return undefined
      },
      'session.end': async (event) => {
        clearSessionTaints(event.sessionId)
      },
    },
  }),
})
