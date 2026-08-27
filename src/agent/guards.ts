import {
  checkGlobalInstallGuard,
  checkNonBunPackageManagerGuard,
  checkNonBunPackageRunnerGuard,
} from '@/bundled-plugins/bun-hygiene/policy'
import {
  GUARD_GLOBAL_INSTALL,
  GUARD_IMAGE_READ_REDIRECT,
  GUARD_NON_BUN_PACKAGE_MANAGER,
  GUARD_NON_BUN_PACKAGE_RUNNER,
  GUARD_NON_WORKSPACE_WRITE,
} from '@/bundled-plugins/guard/keys'
import {
  checkManagedConfigGuard,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
} from '@/bundled-plugins/guard/policy'
import { CORE_TOOL_NAMES } from '@/plugin/core-tool-names'

import type { InternalGuard } from './guard-types'
import { checkImageReadRedirect } from './multimodal/read-redirect'

export type { InternalGuard } from './guard-types'

type InternalGuardDeclaration = Omit<InternalGuard, 'tools'> & {
  readonly tools: readonly [string, ...string[]]
}

const GUARD_KEY_REGEX = /^[a-z][A-Za-z0-9]*$/
const ACKNOWLEDGE_GUARDS = 'acknowledgeGuards'

export function buildInternalGuards(agentDir: string): readonly InternalGuard[] {
  const declarations: readonly InternalGuardDeclaration[] = [
    {
      owner: 'guard',
      key: GUARD_IMAGE_READ_REDIRECT,
      tools: ['read'],
      check: checkImageReadRedirect,
    },
    {
      owner: 'guard',
      key: GUARD_NON_WORKSPACE_WRITE,
      tools: ['write', 'edit'],
      check: async (event) => {
        const options = { tool: event.tool, args: event.args, agentDir }
        const managedConfigResult = await checkManagedConfigGuard(options)
        if (managedConfigResult) return { kind: 'block', reason: managedConfigResult.reason }
        const skillResult = await checkSkillAuthoringGuard(options)
        if (skillResult) return { kind: 'block', reason: skillResult.reason }
        return checkNonWorkspaceWriteGuard({ ...options, origin: event.origin })
      },
    },
    {
      owner: 'bun-hygiene',
      key: GUARD_GLOBAL_INSTALL,
      tools: ['bash'],
      check: checkGlobalInstallGuard,
    },
    {
      owner: 'bun-hygiene',
      key: GUARD_NON_BUN_PACKAGE_MANAGER,
      tools: ['bash'],
      check: checkNonBunPackageManagerGuard,
    },
    {
      owner: 'bun-hygiene',
      key: GUARD_NON_BUN_PACKAGE_RUNNER,
      tools: ['bash'],
      check: checkNonBunPackageRunnerGuard,
    },
  ]
  validateInternalGuardDeclarations(declarations, CORE_TOOL_NAMES)
  return declarations.map((declaration) => ({ ...declaration, tools: new Set(declaration.tools) }))
}

export function validateInternalGuardDeclarations(
  guards: readonly InternalGuardDeclaration[],
  availableToolNames: ReadonlySet<string>,
): void {
  const keysByOwner = new Map<string, Set<string>>()
  for (const guard of guards) {
    if (!GUARD_KEY_REGEX.test(guard.key)) {
      throw new Error(`internal guard ${guard.owner}.${guard.key} does not match ${GUARD_KEY_REGEX.source}`)
    }
    if (guard.key === ACKNOWLEDGE_GUARDS) {
      throw new Error(`internal guard ${guard.owner}.${guard.key} collides with the acknowledgement structure`)
    }
    const keys = keysByOwner.get(guard.owner) ?? new Set<string>()
    if (keys.has(guard.key)) throw new Error(`duplicate internal guard key ${guard.owner}.${guard.key}`)
    keys.add(guard.key)
    keysByOwner.set(guard.owner, keys)

    if (new Set(guard.tools).size !== guard.tools.length) {
      throw new Error(`internal guard ${guard.owner}.${guard.key} has duplicate tool names`)
    }
    for (const tool of guard.tools) {
      if (!availableToolNames.has(tool)) {
        throw new Error(`internal guard ${guard.owner}.${guard.key} targets nonexistent tool "${tool}"`)
      }
    }
  }
}
