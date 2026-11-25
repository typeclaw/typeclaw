import type { SessionOrigin } from '@/agent/session-origin'
import { readEnvFile } from '@/init/env-file'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'

export function canUseProcessGithubPat(
  permissions: Pick<PermissionService, 'has'>,
  origin: SessionOrigin | undefined,
): boolean {
  return permissions.has(origin, CORE_PERMISSIONS.fsSeeSecrets) || permissions.has(origin, 'security.bypass.medium')
}

export function effectiveGithubEnvToken(
  env: NodeJS.ProcessEnv = process.env,
  accepts: (name: 'GH_TOKEN' | 'GITHUB_TOKEN', value: string) => boolean = () => true,
) {
  for (const envName of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = env[envName]
    if (value !== undefined && value !== '' && accepts(envName, value)) return { envName, value }
  }
  return undefined
}

export function inheritedGithubEnvToken(agentDir: string) {
  const declared = readEnvFile(agentDir)
  return effectiveGithubEnvToken(process.env, (name) => Boolean(declared.get(name)))
}

export function declaredGithubEnvToken(agentDir: string) {
  const declared = readEnvFile(agentDir)
  const inherited = effectiveGithubEnvToken(process.env, (name) => Boolean(declared.get(name)))
  return inherited !== undefined && declared.get(inherited.envName) === inherited.value ? inherited : undefined
}
