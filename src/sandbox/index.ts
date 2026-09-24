export { buildSandboxedCommand, type SandboxedCommand } from './build'
export {
  CANONICAL_AGENT_SECRET_DIRS,
  CANONICAL_AGENT_SECRET_FILES,
  CANONICAL_HOME_SECRET_DIRS,
  CANONICAL_HOME_SECRET_FILES,
  CONTAINER_RUNTIME_HOME,
  OPERATOR_CLI_CREDENTIAL_DIRS,
  RUNTIME_OWNED_SECRET_DIRS,
} from './canonical-secrets'
export { CANONICAL_AGENT_RUNTIME_PRIVATE_FILES } from './runtime-private'
export {
  buildProcBindProbeScript,
  canBindProcSafely,
  canMountRealProc,
  ensureBwrapAvailable,
  getProcBindSafetyVerdict,
  PROC_BIND_RETRY_BACKOFF_MS,
  resolveProcBindSafetyWithRetry,
  resolveProcSelfExe,
  type ProcBindSafetyVerdict,
  _resetBwrapAvailabilityCacheForTests,
  _resetProcBindProbeCacheForTests,
  _resetRealProcProbeCacheForTests,
} from './availability'
export {
  canWriteAgentRootInSandbox,
  ensureHiddenMaskTargets,
  resolveHiddenPaths,
  verifyHiddenMaskTargets,
  type HiddenPaths,
} from './hidden-paths'
export {
  resolveProtectedZones,
  resolveWritableZones,
  isGitControlPath,
  subtractMasked,
  type ProtectedZones,
  type WritableZones,
} from './writable-zones'
export { resolveSandboxSymlinks, type SandboxSymlinkSpec } from './symlinks'
export { commandNeedsRealProc } from './package-install'
export {
  cleanupPrivilegedSandboxRuntime,
  resolvePrivilegedSandboxRuntime,
  verifyPrivilegedSandboxRuntime,
  type PrivilegedSandboxRuntime,
} from './privileged-runtime'
export {
  ensureSessionTmpDir,
  isUnderTmp,
  mapVirtualTmpPath,
  SESSION_TMP_ROOT,
  enterSubagentTmpScope,
  sessionTmpDir,
} from './session-tmp'
export {
  DEPENDENCY_BIN_SANDBOX_DIR,
  DEPENDENCY_BIN_SANDBOX_PATH,
  dependencyBinUnavailableHint,
  reconcileDependencyBinWrappers,
  type DependencyBinReconciliation,
} from './dependency-bins'
export { formatCommand, shellQuote } from './quote'
export {
  SandboxDegradedProcError,
  SandboxMaskTargetError,
  SandboxPolicyError,
  SandboxProcProbeUnverifiedError,
  SandboxUnavailableError,
} from './errors'
export {
  DEFAULT_SANDBOX_ENV,
  type SandboxCommandFilter,
  type SandboxEnvPolicy,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxPolicy,
  type SandboxProcessPolicy,
  type SandboxProcStrategy,
  type SandboxProtectedPolicy,
  type SandboxSymlinkOp,
  type SandboxWritablePolicy,
  type SandboxWritableRootPolicy,
} from './policy'
