import { readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'

import type { PluginLogger, PluginRegistry } from '@/plugin'

import {
  DEPENDENCY_BIN_DENYLIST,
  resolveDependencyBins,
  type DependencyBinDeclaration,
  type ResolvedDependencyBin,
} from './bin-resolver'

export { DEPENDENCY_BIN_DENYLIST } from './bin-resolver'

export type DependencyBinIssue = {
  package?: string
  message: string
}

export type DependencyBinDiscovery = {
  declarations: DependencyBinDeclaration[]
  issues: DependencyBinIssue[]
}

export type DependencyBinValidation = DependencyBinDiscovery & {
  resolutions: ResolvedDependencyBin[]
  unavailable: Extract<ResolvedDependencyBin, { kind: 'unavailable' }>[]
}

const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const BIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function discoverDependencyBins(agentDir: string): Promise<DependencyBinDiscovery> {
  const rootManifest = await readManifest(join(agentDir, 'package.json'))
  if (!rootManifest.ok) return { declarations: [], issues: [{ message: rootManifest.message }] }
  if (!isRecord(rootManifest.value)) {
    return { declarations: [], issues: [{ message: 'agent package.json must contain an object' }] }
  }
  const dependencies = rootManifest.value.dependencies
  if (dependencies === undefined) return { declarations: [], issues: [] }
  if (!isRecord(dependencies)) {
    return { declarations: [], issues: [{ message: 'agent package.json dependencies must be an object' }] }
  }

  const declarations: DependencyBinDeclaration[] = []
  const issues: DependencyBinIssue[] = []
  const agentRoot = await realpath(agentDir).catch(() => undefined)
  const nodeModulesRoot = await realpath(join(agentDir, 'node_modules')).catch(() => undefined)
  for (const packageName of Object.keys(dependencies).sort()) {
    if (!PACKAGE_PATTERN.test(packageName)) {
      issues.push({ package: packageName, message: 'direct dependency has an unsafe package name' })
      continue
    }
    const workspace =
      typeof dependencies[packageName] === 'string' && dependencies[packageName].startsWith('workspace:')
    const packageRoot = join(agentDir, 'node_modules', ...packageName.split('/'))
    const resolvedRoot = await realpath(packageRoot).catch(() => undefined)
    const packageRootAllowed =
      resolvedRoot !== undefined &&
      ((nodeModulesRoot !== undefined && isInside(nodeModulesRoot, resolvedRoot)) ||
        (workspace && agentRoot !== undefined && isInside(agentRoot, resolvedRoot)))
    if (!packageRootAllowed) {
      issues.push({ package: packageName, message: 'direct dependency is not installed in an allowed agent path' })
      continue
    }
    const packageManifestPath = join(resolvedRoot, 'package.json')
    const packageManifest = await readManifest(packageManifestPath)
    if (!packageManifest.ok) {
      issues.push({ package: packageName, message: packageManifest.message })
      continue
    }
    if (!isRecord(packageManifest.value)) {
      issues.push({ package: packageName, message: 'dependency package.json must contain an object' })
      continue
    }
    const binEntries = packageBinEntries(packageManifest.value, packageName)
    if (binEntries === undefined) continue
    for (const [bin, entry] of binEntries) {
      if (!BIN_PATTERN.test(bin) || typeof entry !== 'string') {
        issues.push({ package: packageName, message: 'dependency package.json#bin contains an unsafe entry' })
        continue
      }
      if (DEPENDENCY_BIN_DENYLIST.has(bin)) continue
      declarations.push({ package: packageName, bin, entry, ...(workspace ? { workspace: true } : {}) })
    }
  }
  const packagesByBin = new Map<string, string[]>()
  for (const declaration of declarations) {
    const packages = packagesByBin.get(declaration.bin) ?? []
    packages.push(declaration.package)
    packagesByBin.set(declaration.bin, packages)
  }
  const ambiguousBins = new Set<string>()
  for (const [bin, packages] of packagesByBin) {
    if (packages.length < 2) continue
    ambiguousBins.add(bin)
    issues.push({
      message: `direct dependencies ${packages.join(', ')} expose duplicate bin ${bin}; no wrapper generated`,
    })
  }
  return {
    declarations: declarations.filter((entry) => !ambiguousBins.has(entry.bin)),
    issues,
  }
}

export async function validateDependencyBins(
  agentDir: string,
  baselineDirs?: readonly string[],
): Promise<DependencyBinValidation> {
  const discovery = await discoverDependencyBins(agentDir)
  const resolutions = await resolveDependencyBins(
    agentDir,
    discovery.declarations,
    baselineDirs,
    DEPENDENCY_BIN_DENYLIST,
  )
  return {
    ...discovery,
    resolutions,
    unavailable: resolutions.filter(
      (resolution): resolution is Extract<ResolvedDependencyBin, { kind: 'unavailable' }> =>
        resolution.kind === 'unavailable',
    ),
  }
}

export function registerDependencyBinDoctorCheck(
  registry: PluginRegistry,
  agentDir: string,
  logger: PluginLogger,
): void {
  registry.doctorChecks.push({
    pluginName: 'typeclaw',
    checkName: 'dependency-bins',
    pluginConfig: undefined,
    logger,
    check: {
      description: 'direct dependency CLI binaries resolve inside the container',
      category: 'runtime',
      async run() {
        const validation = await validateDependencyBins(agentDir)
        const problems = dependencyBinProblemDetails(validation)
        if (problems.length === 0) {
          return { status: 'ok', message: `${validation.declarations.length} direct dependency bin(s) resolvable` }
        }
        return {
          status: 'error',
          message: `${problems.length} dependency bin problem(s)`,
          details: problems,
          fix: {
            description:
              'Run `bun install` at the agent root (from agent bash or on the host) and fix malformed dependency manifests.',
          },
        }
      },
    },
  })
}

export function logDependencyBinProblems(validation: DependencyBinValidation, logger: PluginLogger): void {
  for (const detail of dependencyBinProblemDetails(validation)) logger.warn(`[dependency-bin] ${detail}`)
}

function packageBinEntries(manifest: Record<string, unknown>, packageName: string): [string, unknown][] | undefined {
  if (typeof manifest.bin === 'string') {
    const manifestName = typeof manifest.name === 'string' ? manifest.name : packageName
    return [[basename(manifestName), manifest.bin]]
  }
  return isRecord(manifest.bin) ? Object.entries(manifest.bin) : undefined
}

async function readManifest(path: string): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ok: false, message: 'package.json is missing or unreadable' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, message: 'package.json is malformed' }
  }
}

function dependencyBinProblemDetails(validation: DependencyBinValidation): string[] {
  return [
    ...validation.issues.map((issue) =>
      issue.package === undefined ? issue.message : `direct dependency ${issue.package}: ${issue.message}`,
    ),
    ...validation.unavailable.map(
      (entry) =>
        `direct dependency ${entry.declaration.package}: bin ${entry.declaration.bin} unavailable (${entry.reason})`,
    ),
  ]
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
