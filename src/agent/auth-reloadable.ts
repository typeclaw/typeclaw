import type { Reloadable, ReloadResult } from '@/reload'

import { invalidateProviderAuthCache } from './auth'

export type CreateProviderAuthReloadableOptions = {
  // Fired after the runtime cache is cleared. The run stage tears down live
  // sessions so replacements capture freshly resolved credentials.
  onProviderAuthChanged?: () => void | Promise<void>
}

export function createProviderAuthReloadable({
  onProviderAuthChanged,
}: CreateProviderAuthReloadableOptions = {}): Reloadable {
  return {
    scope: 'providers',
    description: 'secrets.json provider credentials',
    reload: async (): Promise<ReloadResult> => {
      invalidateProviderAuthCache()
      await onProviderAuthChanged?.()
      return { scope: 'providers', ok: true, summary: 'provider auth cache cleared' }
    },
  }
}
