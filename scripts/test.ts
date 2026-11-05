// `bun run test`: runs only the test files impacted by your changes. CI always
// runs everything, so a heuristic selection can never decide a merge.
//
// Why not `bun test --changed`: it follows imports only, but many tests here
// spawn the CLI or a worker script by path, or read a source file directly, and
// it knows nothing about inputs that are not modules. Those tests would be
// skipped silently. The rule below is to over-select rather than miss a test:
// anything this script cannot trace to specific tests runs the full suite.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

export type ImportGraph = {
  files: readonly string[]
  importsOf(file: string): readonly string[]
}

export type Selection = { mode: 'full'; reason: string } | { mode: 'files'; files: string[] }

export type ChangeSet = { base: string; baseLabel: string; files: string[] }

const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/
const MODULE_ROOTS = ['src/', 'scripts/']
// Verified not to be read by any test. Everything else that is not a module,
// including the skill Markdown under src/, may be a test input.
const NON_INPUT_DIRECTORIES = ['docs/', '.github/']
const NON_INPUT_FILES = new Set(['LICENSE', '.gitattributes', '.oxlintrc.json', '.oxfmtrc.json'])
// A path in a string, such as './worker.ts', '../cli/index', or 'src/cli/index.ts'.
const PATH_LITERAL = /(?:\.{1,2}\/[\w@./-]+|[\w@./-]+\.(?:[cm]?[jt]s|[jt]sx))(?![\w/-])/g
// `join(import.meta.dir, '..', 'plugin', 'index.ts')` spreads one path over several strings.
const JOINED_PATH = /(?:join|resolve)\(\s*import\.meta\.dir((?:\s*,\s*'[^']*')+)/g
const QUOTED_SIBLING = /['"](?:\.\/)?([\w@.-]+\.(?:[cm]?[jt]s|[jt]sx))['"]/g
// Type-only imports do not run, so their paths must not count as path literals.
const TYPE_ONLY_IMPORT = /^\s*(?:import|export)\s+type\b[^;'"`]*?\bfrom\s+['"][^'"]+['"]/gm

export function selectImpactedTests(
  changedFiles: readonly string[],
  preloads: readonly string[],
  graph: ImportGraph,
): Selection {
  const existing = new Set(graph.files)
  const changedModules: string[] = []

  for (const file of changedFiles) {
    if (isNonInput(file)) continue
    if (!MODULE_FILE.test(file)) return { mode: 'full', reason: `${file} is not a module` }
    if (existing.has(file)) changedModules.push(file)
    else if (!TEST_FILE.test(file)) return { mode: 'full', reason: `${file} was deleted` }
  }

  const importers = new Map<string, string[]>()
  for (const file of graph.files) {
    for (const dependency of graph.importsOf(file)) {
      const list = importers.get(dependency)
      if (list) list.push(file)
      else importers.set(dependency, [file])
    }
  }

  const impacted = new Set(changedModules)
  const pending = [...changedModules]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const importer of importers.get(file) ?? []) {
      if (impacted.has(importer)) continue
      impacted.add(importer)
      pending.push(importer)
    }
  }

  const preload = preloads.find((file) => impacted.has(file))
  if (preload) return { mode: 'full', reason: `the test preload ${preload} is impacted` }
  return { mode: 'files', files: [...impacted].filter((file) => TEST_FILE.test(file)).sort() }
}

export function createImportGraph(repoRoot: string, files: readonly string[]): ImportGraph {
  // Bun resolves symlinks, so a checkout under one (macOS /tmp) must compare by real path.
  const root = realpathSync(repoRoot)
  const known = new Set(files)
  const toRepoPath = (path: string) => relative(root, path).split(sep).join('/')
  const lookup = (path: string) =>
    [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`].map(toRepoPath).find((file) => known.has(file))
  const transpilers = {
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
    js: new Bun.Transpiler({ loader: 'js' }),
  }
  const cache = new Map<string, string[]>()

  return {
    files,
    importsOf(file) {
      const cached = cache.get(file)
      if (cached) return cached

      const path = resolve(root, file)
      const directory = dirname(path)
      // scanImports treats a shebang as a syntax error.
      const source = readFileSync(path, 'utf8').replace(/^#!.*/, '')
      const imports = new Set<string>()

      let scanned: Bun.Import[]
      try {
        scanned = transpilers[loaderOf(file)].scanImports(source)
      } catch (error) {
        throw new Error(`Could not scan imports of ${file}. Run with --full to skip change detection.`, {
          cause: error,
        })
      }
      for (const { path: specifier } of scanned) {
        const target = resolveImport(specifier, directory)
        const repoPath = target && lookup(target)
        if (repoPath) imports.add(repoPath)
      }

      // A test can name anything it spawns or reads. A runtime module only counts for
      // a sibling it names as a quoted file, like a script it launches: its other
      // paths are mostly prose, and following those ties the whole tree into one
      // cycle through the CLI entry, which would select most tests for any change.
      if (!TEST_FILE.test(file)) {
        for (const [, sibling = ''] of source.matchAll(QUOTED_SIBLING)) {
          const repoPath = lookup(resolve(directory, sibling))
          if (repoPath) imports.add(repoPath)
        }
      } else {
        const code = source.replace(TYPE_ONLY_IMPORT, '')
        for (const [literal] of code.matchAll(PATH_LITERAL)) {
          for (const base of [directory, root]) {
            const repoPath = lookup(resolve(base, literal))
            if (repoPath) imports.add(repoPath)
          }
        }
        for (const [, segments = ''] of code.matchAll(JOINED_PATH)) {
          const parts = [...segments.matchAll(/'([^']*)'/g)].flatMap(([, part]) => (part ? [part] : []))
          const repoPath = lookup(resolve(directory, ...parts))
          if (repoPath) imports.add(repoPath)
        }
      }

      imports.delete(file)
      const result = [...imports]
      cache.set(file, result)
      return result
    },
  }
}

// Branch commits plus staged, unstaged, and untracked files. The base is the
// merge-base, not origin/main itself, so commits landed on main after branching
// do not count as changes.
export async function collectChangeSet(repoRoot: string): Promise<ChangeSet> {
  const mergeBase = await git(repoRoot, ['merge-base', 'HEAD', 'origin/main'])
  const base = mergeBase ?? (await git(repoRoot, ['rev-parse', 'HEAD']))
  if (!base) throw new Error('Could not resolve a git base commit. Run with --full outside a git checkout.')

  const [tracked, untracked] = await Promise.all([
    git(repoRoot, ['diff', '--name-only', '--no-renames', base]),
    git(repoRoot, ['ls-files', '--others', '--exclude-standard']),
  ])
  return {
    base,
    baseLabel: mergeBase ? 'merge-base with origin/main' : 'HEAD, origin/main not found',
    files: [...new Set([...lines(tracked), ...lines(untracked)])].sort(),
  }
}

export async function listModuleFiles(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard'])
  return lines(output).filter(
    (file) =>
      MODULE_FILE.test(file) &&
      MODULE_ROOTS.some((root) => file.startsWith(root)) &&
      existsSync(resolve(repoRoot, file)),
  )
}

export function readPreloads(repoRoot: string): string[] {
  const config = Bun.TOML.parse(readFileSync(resolve(repoRoot, 'bunfig.toml'), 'utf8')) as {
    test?: { preload?: string | string[] }
  }
  return [config.test?.preload ?? []].flat().flatMap((entry) => (entry.startsWith('./') ? [entry.slice(2)] : []))
}

function loaderOf(file: string): 'ts' | 'tsx' | 'js' {
  if (file.endsWith('x')) return 'tsx'
  return /\.[cm]?js$/.test(file) ? 'js' : 'ts'
}

function isNonInput(file: string): boolean {
  if (NON_INPUT_FILES.has(file) || NON_INPUT_DIRECTORIES.some((directory) => file.startsWith(directory))) return true
  return file.endsWith('.md') && !file.includes('/')
}

// Failures here are builtins and uninstalled optional dependencies. Neither is a repository file.
function resolveImport(specifier: string, fromDirectory: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, fromDirectory)
  } catch {
    return undefined
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await Bun.$`git ${args}`.cwd(cwd).quiet().nothrow()
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

function lines(output: string | undefined): string[] {
  return output ? output.split('\n').filter((line) => line.length > 0) : []
}

function isCi(): boolean {
  const value = process.env.CI?.toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

async function runBunTest(args: readonly string[]): Promise<number> {
  const proc = Bun.spawn([process.execPath, 'test', '--parallel', '--no-orphans', ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return proc.exited
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((arg) => arg !== '--full')
  // Any other argument is a selection of its own, such as a path or `-t`.
  if (args.length !== argv.length || args.length > 0 || isCi()) return runBunTest(args)

  const repoRoot = resolve(import.meta.dir, '..')
  const [changeSet, moduleFiles] = await Promise.all([collectChangeSet(repoRoot), listModuleFiles(repoRoot)])
  const selection = selectImpactedTests(
    changeSet.files,
    readPreloads(repoRoot),
    createImportGraph(repoRoot, moduleFiles),
  )
  const since = `${changeSet.files.length} changed file(s) since ${changeSet.base.slice(0, 9)} (${changeSet.baseLabel})`

  if (selection.mode === 'full') {
    console.log(`Running every test because ${selection.reason}.\n`)
    return runBunTest([])
  }
  if (selection.files.length === 0) {
    console.log(`No tests impacted by ${since}. Run with --full to test everything.\n`)
    return 0
  }
  console.log(`Impacted: ${selection.files.length} test file(s), from ${since}. --full runs everything.\n`)
  return runBunTest(selection.files.map((file) => `./${file}`))
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
