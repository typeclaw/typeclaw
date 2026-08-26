import {
  GUARD_GLOBAL_INSTALL,
  GUARD_IMAGE_READ_REDIRECT,
  GUARD_NON_BUN_PACKAGE_MANAGER,
  GUARD_NON_BUN_PACKAGE_RUNNER,
  GUARD_NON_WORKSPACE_WRITE,
} from '@/bundled-plugins/guard/keys'

export const FIRST_PARTY_GUARD_ACKNOWLEDGEMENT_DECLARATIONS = [
  { key: GUARD_IMAGE_READ_REDIRECT, tools: ['read'] },
  { key: GUARD_NON_WORKSPACE_WRITE, tools: ['write', 'edit'] },
  { key: GUARD_GLOBAL_INSTALL, tools: ['bash'] },
  { key: GUARD_NON_BUN_PACKAGE_MANAGER, tools: ['bash'] },
  { key: GUARD_NON_BUN_PACKAGE_RUNNER, tools: ['bash'] },
] as const

const guardAcknowledgements = new Map<string, Set<string>>()
for (const { key, tools } of FIRST_PARTY_GUARD_ACKNOWLEDGEMENT_DECLARATIONS) {
  for (const tool of tools) {
    const keys = guardAcknowledgements.get(tool) ?? new Set<string>()
    keys.add(key)
    guardAcknowledgements.set(tool, keys)
  }
}

export const GUARD_ACKNOWLEDGEMENTS: ReadonlyMap<string, ReadonlySet<string>> = guardAcknowledgements
