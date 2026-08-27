// Keep this module import-free: acknowledgement folding runs during module
// evaluation, and cycles through key owners can throw a temporal-dead-zone ReferenceError.
export const ACKNOWLEDGE_GUARDS = 'acknowledgeGuards'
export const GUARD_IMAGE_READ_REDIRECT = 'imageReadRedirect'
export const GUARD_NON_WORKSPACE_WRITE = 'nonWorkspaceWrite'
export const GUARD_GLOBAL_INSTALL = 'globalInstall'
export const GUARD_NON_BUN_PACKAGE_MANAGER = 'nonBunPackageManager'
export const GUARD_NON_BUN_PACKAGE_RUNNER = 'nonBunPackageRunner'
