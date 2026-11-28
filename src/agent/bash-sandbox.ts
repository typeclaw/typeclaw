import { join } from 'node:path'

import type { GetGithubSelf } from '@/channels/github-token-bridge'
import { config, getConfig, getSandboxWritablePathSpecs } from '@/config/config'
import type { PermissionService } from '@/permissions/permissions'
import {
  buildSandboxedCommand,
  canWriteAgentRootInSandbox,
  cleanupPrivilegedSandboxRuntime,
  commandNeedsRealProc,
  DEFAULT_SANDBOX_ENV,
  DEPENDENCY_BIN_SANDBOX_DIR,
  ensureBwrapAvailable,
  ensureHiddenMaskTargets,
  ensureSessionTmpDir,
  leaseSessionTmp,
  reconcileDependencyBinWrappers,
  resolveHiddenPaths,
  resolvePrivilegedSandboxRuntime,
  resolveProcSelfExe,
  resolveProtectedZones,
  resolveSandboxSymlinks,
  resolveWritableZones,
  SandboxDegradedProcError,
  SandboxProcProbeUnverifiedError,
  SandboxPolicyError,
  subtractMasked,
  verifyHiddenMaskTargets,
  verifyPrivilegedSandboxRuntime,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxPolicy,
  type DependencyBinReconciliation,
} from '@/sandbox'
import { resolveDevSourceMounts } from '@/sandbox/dev-source'
import { typevaultBashCliPath } from '@/typevault/cli-path'

import {
  buildRoleScopedConfigEnv,
  buildSandboxEnvPolicy,
  resolveAgentGitIdentityEnv,
  resolveExposableBashEnvNames,
  spreadSandboxEnv,
} from './bash-sandbox-env'
import { resolveProcStrategy, type ProcStrategyResolution } from './bash-sandbox-proc'
import type { SessionOrigin } from './session-origin'
export type DeferredBashPreparationResult = {
  command: string
  env?: Record<string, string>
  mount: Extract<SandboxMount, { type: 'ro-bind' }>
  cleanup: () => Promise<void>
}
export type DeferredBashPreparation = () => Promise<DeferredBashPreparationResult>
export type BashSandboxBoundary = {
  ensureAvailable: () => Promise<void>
  buildCommand: typeof buildSandboxedCommand
  resolveProcStrategy?: () => Promise<ProcStrategyResolution>
  resolveRuntime?: typeof resolvePrivilegedSandboxRuntime
  verifyRuntime?: typeof verifyPrivilegedSandboxRuntime
  cleanupRuntime?: typeof cleanupPrivilegedSandboxRuntime
}

const DEFAULT_BASH_SANDBOX_BOUNDARY: BashSandboxBoundary = {
  ensureAvailable: ensureBwrapAvailable,
  buildCommand: buildSandboxedCommand,
}

type BashFilesystemPolicyOptions = {
  agentDir: string
  canWriteAgentRoot: boolean
  masks: { dirs: string[]; files: string[] }
  writable: { dirs: string[]; files: string[] }
  protected: { dirs: string[]; files: string[] }
}

export type PreparedBashSandbox = {
  commandString: string
  policy: SandboxPolicy
  verify: () => Promise<void>
  cleanup: () => Promise<void>
  spawnEnv: Record<string, string>
  dependencyBins?: DependencyBinReconciliation
  withheld: {
    paths: { dirs: string[]; files: string[] }
    envNames: string[]
  }
}

export function buildBashFilesystemPolicy(options: BashFilesystemPolicyOptions) {
  const { agentDir, canWriteAgentRoot, masks, writable, protected: protectedZones } = options
  if (canWriteAgentRoot) {
    return { writableRoot: { dir: agentDir }, masks, protected: protectedZones }
  }
  return { masks, writable, protected: protectedZones }
}

export type BashSandboxReveal = NonNullable<SandboxPolicy['reveal']>

export type BashSandboxRequest = {
  readonly cwd?: string
  // Applied inside bwrap, after guards and token brokers have inspected the
  // actual command. Watch probes need separate bounded stdout/stderr.
  readonly frameOutput?: (command: string) => string
  readonly getGithubSelf?: GetGithubSelf
  readonly command: string
  readonly permissions: PermissionService
  readonly origin: SessionOrigin | undefined
  readonly agentDir: string
  readonly sessionId: string
  readonly envOverlay?: Record<string, string>
  readonly envWithhold?: string[]
  readonly deferredPreparation?: DeferredBashPreparation
  readonly reveal?: BashSandboxReveal
  // Existing files bound read-only for this call only, on top of the role's
  // writable zones (the config files when coordination failed).
  readonly readOnlyFiles?: readonly string[]
  readonly boundary?: BashSandboxBoundary
  readonly network?: SandboxNetwork
}

// Shared preparation for model bash and codemode. The caller owns verification
// immediately before spawn and cleanup after the process has exited.
export async function prepareBashSandbox(options: BashSandboxRequest): Promise<PreparedBashSandbox> {
  const {
    command: originalCommand,
    permissions,
    origin,
    agentDir,
    sessionId,
    envOverlay,
    envWithhold,
    deferredPreparation,
  } = options
  const boundary = options.boundary ?? DEFAULT_BASH_SANDBOX_BOUNDARY
  // Held until the caller's post-exit cleanup, so neither a session dispose nor
  // the orphan sweep removes the scratch dir a running command has bound.
  const releaseTmpLease = leaseSessionTmp(sessionId)
  let preparation: DeferredBashPreparationResult | undefined
  let privilegedRuntime: Awaited<ReturnType<typeof resolvePrivilegedSandboxRuntime>> | undefined
  const cleanup = async (): Promise<void> => {
    releaseTmpLease()
    const tasks: Promise<void>[] = []
    if (privilegedRuntime !== undefined) {
      tasks.push((boundary.cleanupRuntime ?? cleanupPrivilegedSandboxRuntime)(privilegedRuntime))
    }
    if (preparation !== undefined) tasks.push(preparation.cleanup())
    const outcomes = await Promise.allSettled(tasks)
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  try {
    preparation = await deferredPreparation?.()
    const command = preparation?.command ?? originalCommand
    const envNames = resolveExposableBashEnvNames(agentDir)
    const gitIdentityEnv = await resolveAgentGitIdentityEnv(
      agentDir,
      envNames.declared,
      options.getGithubSelf?.(),
      getConfig().git.user,
    )
    const mergedEnvOverlay = { ...gitIdentityEnv, ...envOverlay, ...preparation?.env }
    const preparedEnvOverlay = Object.keys(mergedEnvOverlay).length > 0 ? mergedEnvOverlay : undefined
    const { dirs, files } = resolveHiddenPaths(permissions, origin, agentDir)
    const sandboxEnvOverlay = buildRoleScopedConfigEnv(agentDir, dirs, preparedEnvOverlay)
    const effectiveEnvWithhold = (envWithhold ?? []).filter((name) => !Object.hasOwn(sandboxEnvOverlay ?? {}, name))
    const maskTargets = await ensureHiddenMaskTargets({ dirs, files })
    await boundary.ensureAvailable()
    const sessionTmp = await ensureSessionTmpDir(sessionId)
    const dependencyBins = await reconcileDependencyBinWrappers({
      agentDir,
      sessionTmp,
      ...(config.typevault.enabled ? { runtimeBins: { typevault: typevaultBashCliPath() } } : {}),
    })
    const writable = subtractMasked(await resolveWritableZones(agentDir, getSandboxWritablePathSpecs(config)), {
      dirs,
      files,
    })
    const writableRoot = canWriteAgentRootInSandbox(permissions, origin)
    const baseProtectedZones =
      writableRoot || writable.dirs.includes(join(agentDir, '.git'))
        ? subtractMasked(await resolveProtectedZones(agentDir), { dirs, files })
        : { dirs: [], files: [] }
    // A read-only bind renders after the masks, so one on or inside a hidden
    // path would re-expose it: refuse the call instead of binding.
    const readOnlyFiles = options.readOnlyFiles ?? []
    const hiddenReadOnly = readOnlyFiles.filter(
      (file) => !subtractMasked({ dirs: [], files: [file] }, { dirs, files }).files.includes(file),
    )
    if (hiddenReadOnly.length > 0) {
      throw new SandboxPolicyError(
        `[TypeClaw config guard] This command was not run: ${hiddenReadOnly.join(', ')} would have to be bound read-only inside a path hidden from this command, which would expose it. Retry the command once the agent can coordinate config writes with host typeclaw commands again.`,
      )
    }
    const protectedZones = {
      dirs: baseProtectedZones.dirs,
      files: [...new Set([...baseProtectedZones.files, ...readOnlyFiles])],
    }
    const writableDirSet = new Set(writable.dirs)
    const sandboxHome = DEFAULT_SANDBOX_ENV.HOME ?? '/tmp'
    const symlinks = resolveSandboxSymlinks(agentDir, config.sandbox.symlinks, sandboxHome).filter((op) =>
      writableDirSet.has(op.target),
    )
    const { strategy: proc, degradeReason } = await (boundary.resolveProcStrategy ?? resolveProcStrategy)()
    if (proc === 'tmpfs' && commandNeedsRealProc(command)) {
      throw degradeReason === 'unverified' ? new SandboxProcProbeUnverifiedError() : new SandboxDegradedProcError()
    }
    privilegedRuntime = await (boundary.resolveRuntime ?? resolvePrivilegedSandboxRuntime)({
      agentDir,
      command,
      env: sandboxEnvOverlay,
    })
    await verifyHiddenMaskTargets(maskTargets)
    const devSourceMounts = await resolveDevSourceMounts(agentDir)
    const policy: SandboxPolicy = {
      mounts: [
        { type: 'ro-bind', source: agentDir, dest: agentDir },
        { type: 'bind', source: sessionTmp, dest: '/tmp' },
        // `/tmp` is writable, but PATH entries must remain runtime-owned for
        // the lifetime of this command. Last-op-wins makes this narrow re-bind
        // read-only without adding any broader filesystem exposure.
        { type: 'ro-bind', source: dependencyBins.wrapperDir, dest: DEPENDENCY_BIN_SANDBOX_DIR },
        // The running Bun ELF is runtime-owned, not a model-selected path.
        // Dev/CI installations may place it outside /usr; expose only the
        // executable, never its parent directory, under every proc strategy.
        { type: 'ro-bind', source: process.execPath, dest: process.execPath },
        ...devSourceMounts,
        ...(privilegedRuntime?.mounts ?? []),
        ...(preparation === undefined ? [] : [preparation.mount]),
      ],
      ...buildBashFilesystemPolicy({
        agentDir,
        canWriteAgentRoot: writableRoot,
        masks: maskTargets,
        writable,
        protected: protectedZones,
      }),
      ...(options.reveal === undefined ? {} : { reveal: options.reveal }),
      symlinks,
      network: options.network ?? 'inherit',
      cwd: options.cwd ?? agentDir,
      proc,
      procSelfExe: resolveProcSelfExe(),
      ...spreadSandboxEnv(
        buildSandboxEnvPolicy(sandboxEnvOverlay, privilegedRuntime?.env, envNames.exposable, envWithhold),
      ),
    }
    const { commandString, spawnEnv } = boundary.buildCommand(options.frameOutput?.(command) ?? command, policy)
    // The overlay carries command-scoped secret VALUES (e.g. a per-repo GH_TOKEN)
    // that live in neither process.env nor argv; resolveSpawnEnv snapshots
    // inherited names from process.env only, so merge the overlay values in here
    // to complete the exact bwrap-parent env.
    const mergedSpawnEnv =
      spawnEnv !== undefined && sandboxEnvOverlay !== undefined ? { ...spawnEnv, ...sandboxEnvOverlay } : spawnEnv
    const runtimeForResult = privilegedRuntime
    return {
      commandString,
      policy,
      verify: async () => (boundary.verifyRuntime ?? verifyPrivilegedSandboxRuntime)(runtimeForResult),
      cleanup,
      spawnEnv: mergedSpawnEnv,
      dependencyBins,
      withheld: { paths: maskTargets, envNames: [...new Set([...envNames.withheld, ...effectiveEnvWithhold])] },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
