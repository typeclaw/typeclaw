import type { PermissionService } from '@/permissions'
import type { Reloadable, ReloadResult } from '@/reload'

import { getConfig, type ConfigReloadDiff, reloadConfig, validateConfig } from './config'

export type CreateConfigReloadableOptions = {
  cwd: string
  // Optional hook fired after a successful reload so the live permission
  // service can rebuild its resolved role table from the new roles config.
  // This is what makes `roles.<name>.match` edits (typeclaw role claim,
  // hand-edits) take effect without a container restart. `roles.<name>.permissions`
  // changes still require a restart — see FIELD_EFFECTS in config.ts.
  permissions?: PermissionService
  // Fired after replaceRoles when a `roles.<name>.match` edit is applied. The
  // run stage wires this to the channel router so live sessions are recreated
  // and pick up the new role in their (otherwise frozen) system prompt.
  onRolesChanged?: () => void | Promise<void>
  // Skip the mount-path accessibility check inside validateConfig. Mount paths
  // in typeclaw.json are host paths — they don't resolve inside the container,
  // so the check would always fail on any agent that declares mounts. `mounts`
  // is `restart-required` anyway, so reload never applies mount changes. Set
  // this when wiring the reloadable from a container-stage context.
  skipMountValidation?: boolean
  // Fired when a reload changes `git.user`; the run stage re-applies the runtime
  // git identity env so runtime commits follow it, including its removal.
  onGitUserChanged?: () => void
}

export function createConfigReloadable({
  cwd,
  permissions,
  onRolesChanged,
  skipMountValidation = false,
  onGitUserChanged,
}: CreateConfigReloadableOptions): Reloadable {
  return {
    scope: 'config',
    description: 'typeclaw.json runtime config',
    reload: async () => doReload(cwd, permissions, onRolesChanged, skipMountValidation, onGitUserChanged),
  }
}

async function doReload(
  cwd: string,
  permissions: PermissionService | undefined,
  onRolesChanged: (() => void | Promise<void>) | undefined,
  skipMountValidation: boolean,
  onGitUserChanged: (() => void) | undefined,
): Promise<ReloadResult> {
  // Mount accessibility belongs to the validation surface, not loadConfigSync —
  // validateConfig is the single gate that every host-side caller goes through.
  // Run it before swapping the live config pointer so a mount that vanished
  // between starts surfaces as a reload failure (`mounts` is restart-required
  // anyway, so the user has to restart to pick up changes; better to flag the
  // problem now than to let restart fail later).
  //
  // Container-side reload skips mount validation: mounts are host paths and
  // statSync against them inside the container always fails. The host-side
  // `start` / `restart` / doctor paths still gate on the full validateConfig.
  const validated = validateConfig(cwd, { skipMounts: skipMountValidation })
  if (!validated.ok) {
    return { scope: 'config', ok: false, reason: validated.reason }
  }

  let diff: ConfigReloadDiff
  try {
    diff = reloadConfig(cwd)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { scope: 'config', ok: false, reason: message }
  }

  if (diff.applied.some((c) => c.path === 'roles.match')) {
    permissions?.replaceRoles(getConfig().roles)
    await onRolesChanged?.()
  }

  if (diff.applied.some((c) => c.path === 'git.user')) onGitUserChanged?.()

  return {
    scope: 'config',
    ok: true,
    summary: formatSummary(diff),
    details: diff,
  }
}

function formatSummary(diff: ConfigReloadDiff): string {
  return `${diff.applied.length} applied, ${diff.restartRequired.length} restart-required, ${diff.ignored.length} ignored`
}
