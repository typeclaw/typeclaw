import { defineCommand } from 'citty'

import { DevDepError, switchTypeclawDependency, type TypeclawDepMode } from '@/dev-dep'

import { c, errorLine, successLine } from './ui'

const localCommand = defineCommand({
  meta: {
    name: 'local',
    description: 'point the agent at a local typeclaw checkout (file: spec)',
  },
  args: {
    path: {
      type: 'string',
      description: 'path to the local typeclaw checkout (default: existing file: spec or the running CLI)',
    },
    'no-commit': {
      type: 'boolean',
      description: 'skip auto-committing the package.json change',
      default: false,
    },
  },
  async run({ args }) {
    await runSwitch('local', { localPath: args.path, noCommit: args['no-commit'] })
  },
})

const npmCommand = defineCommand({
  meta: {
    name: 'npm',
    description: 'point the agent at the published typeclaw package (^version spec)',
  },
  args: {
    version: {
      type: 'string',
      description: 'version to pin as ^X.Y.Z (default: installed or CLI version)',
    },
    'no-commit': {
      type: 'boolean',
      description: 'skip auto-committing the package.json change',
      default: false,
    },
  },
  async run({ args }) {
    await runSwitch('npm', { version: args.version, noCommit: args['no-commit'] })
  },
})

export const devDepCommand = defineCommand({
  meta: {
    name: 'dev-dep',
    description: "switch the agent's typeclaw dependency between a local checkout and npm",
  },
  subCommands: {
    local: localCommand,
    npm: npmCommand,
  },
})

async function runSwitch(
  mode: TypeclawDepMode,
  opts: { localPath?: string; version?: string; noCommit: boolean },
): Promise<void> {
  try {
    const result = await switchTypeclawDependency({
      agentRoot: process.cwd(),
      mode,
      localPath: opts.localPath,
      version: opts.version,
      commit: !opts.noCommit,
    })

    if (!result.changed) {
      process.stdout.write(`${c.dim(`typeclaw is already on ${result.newSpec}; nothing to change.`)}\n`)
      return
    }

    process.stdout.write(`${successLine(`typeclaw: ${result.oldSpec ?? '<none>'} → ${result.newSpec}`)}\n`)
    if (result.committed) {
      process.stdout.write(`${c.dim(`Committed: ${result.commitSubject}`)}\n`)
    } else if (!opts.noCommit) {
      process.stdout.write(`${c.dim('package.json updated (not committed — not a git repo or commit skipped).')}\n`)
    }
  } catch (err) {
    if (err instanceof DevDepError) {
      console.error(errorLine(err.message))
      process.exit(1)
    }
    throw err
  }
}
