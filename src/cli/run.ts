import { defineCommand } from 'citty'

import { config } from '@/config'
import { isInitialized } from '@/init'
import { startAgent } from '@/run'

export const run = defineCommand({
  meta: {
    name: 'run',
    description: 'run the agent in the foreground (container stage)',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to listen on',
      default: String(config.port),
    },
    prompt: {
      type: 'positional',
      description: 'initial prompt for the attached tui',
      required: false,
    },
    tui: {
      type: 'boolean',
      description: 'attach a local tui (default: auto, on when stdin is a tty)',
    },
    'no-tui': {
      type: 'boolean',
      description: 'never attach a local tui, stay headless',
    },
  },
  async run({ args }) {
    if (!isInitialized(process.cwd())) {
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const attachTui = resolveAttachTui({
      tui: args.tui,
      noTui: args['no-tui'],
      isTTY: Boolean(process.stdin.isTTY),
    })

    const { tuiPromise, stop } = await startAgent({
      port: Number(args.port),
      attachTui,
      initialPrompt: args.prompt,
    })

    const onSignal = async () => {
      await stop()
      process.exit(0)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)

    if (tuiPromise) {
      await tuiPromise
      await stop()
      process.exit(0)
    }
  },
})

function resolveAttachTui({
  tui,
  noTui,
  isTTY,
}: {
  tui: boolean | undefined
  noTui: boolean | undefined
  isTTY: boolean
}): boolean {
  if (noTui) return false
  if (tui) return true
  return isTTY
}
