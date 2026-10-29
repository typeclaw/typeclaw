import { z } from 'zod'

import type { WrapSystemToolOptions } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'

const origins = ['tui', 'channel', 'cron', 'subagent', 'system'] as const

export const evalConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    origins: z.array(z.enum(origins)).default([...origins]),
  })
  .strict()
  .default({ enabled: false, origins: [...origins] })

export function evalEnabledForSession(options: {
  readonly settings: z.infer<typeof evalConfigSchema>
  readonly origin: SessionOrigin | undefined
  readonly tools: readonly string[]
  readonly bashPolicy?: WrapSystemToolOptions['bashPolicy']
}): boolean {
  // Raw JavaScript is arbitrary code, just like unrestricted bash. The command
  // fence is NOT a filesystem policy and cannot be enforced on JavaScript.
  // Use the wrapper's actual policy source, never a list of subagent names.
  return (
    options.settings.enabled &&
    options.origin !== undefined &&
    options.settings.origins.includes(options.origin.kind) &&
    options.tools.includes('bash') &&
    options.bashPolicy === undefined
  )
}
