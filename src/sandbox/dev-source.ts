import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SandboxMount } from './policy'

const RUNTIME_MODULE_FILE = fileURLToPath(import.meta.url)

// Dev mode (`file:`/`link:` typeclaw dep): files under node_modules/typeclaw
// are symlinks into a checkout outside the agent folder. `typeclaw start`
// mirror-mounts that checkout read-only into the container, but bwrap only
// binds the agent folder, so anything typeclaw resolves inside the checkout
// dangles inside model bash. Bind the checkout's `src/` (bundled skills) and
// `node_modules/` (runtime-provided bins such as `typevault`, which resolve
// into typeclaw's own dependencies), never the checkout root, so a
// developer's `.env` or `.git` stays out of the sandbox. The path comes from
// the running module's own realpath, which the model cannot redirect by
// rewriting node_modules. Registry installs resolve inside the agent folder
// and get no mount.
export async function resolveDevSourceMounts(
  agentDir: string,
  moduleFile: string = RUNTIME_MODULE_FILE,
): Promise<Extract<SandboxMount, { type: 'ro-bind' }>[]> {
  const srcDir = dirname(dirname(await realpath(moduleFile)))
  const rel = relative(await realpath(agentDir), srcDir)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return []
  const mounts: Extract<SandboxMount, { type: 'ro-bind' }>[] = [{ type: 'ro-bind', source: srcDir, dest: srcDir }]
  const nodeModules = join(dirname(srcDir), 'node_modules')
  // bwrap aborts on a missing bind source; a checkout that was never
  // installed has nothing there to expose.
  if ((await stat(nodeModules).catch(() => undefined))?.isDirectory()) {
    mounts.push({ type: 'ro-bind', source: nodeModules, dest: nodeModules })
  }
  return mounts
}
