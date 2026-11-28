import {
  checkSpotlightExclusion,
  ensureSpotlightExclusion,
  type SpotlightDeps,
  type SpotlightExclusionOutcome,
  spotlightWarning,
} from '@/spotlight'

import type { CheckResult, DoctorCheck } from './types'

const MANUAL_FIX = 'Add the agent folder under System Settings > Spotlight > Search Privacy.'

export function spotlightExclusion(deps: SpotlightDeps = {}): DoctorCheck {
  return {
    name: 'agent-folder.spotlight-excluded',
    category: 'agent-folder',
    description: 'agent folder is excluded from macOS Spotlight indexing',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      return toCheckResult(ctx.cwd, await checkSpotlightExclusion(ctx.cwd, deps), deps)
    },
  }
}

function toCheckResult(cwd: string, outcome: SpotlightExclusionOutcome, deps: SpotlightDeps): CheckResult {
  switch (outcome.kind) {
    case 'skipped':
      return {
        status: 'skipped',
        message:
          outcome.reason === 'not-macos' ? 'not running on macOS' : 'Spotlight never indexes this folder location',
      }
    case 'excluded':
      return { status: 'ok', message: 'agent folder is in the Spotlight Privacy list' }
    case 'not-excluded':
      return {
        status: 'warning',
        message: 'Spotlight indexes the agent folder',
        details: [
          "Every write to the agent's session, channel, and todo logs is re-indexed; the index can fill the disk.",
        ],
        fix: {
          description: 'Add the agent folder to the Spotlight Privacy list.',
          autoFix: async () => {
            const result = await ensureSpotlightExclusion(cwd, deps)
            if (result.kind !== 'excluded') throw new Error(spotlightWarning(cwd, result) ?? MANUAL_FIX)
            return { summary: 'added the agent folder to the Spotlight Privacy list', changedPaths: [] }
          },
        },
      }
    case 'unavailable':
    case 'failed':
      return {
        status: 'warning',
        message: 'could not read the Spotlight Privacy list',
        details: [outcome.detail],
        fix: { description: MANUAL_FIX },
      }
  }
}
