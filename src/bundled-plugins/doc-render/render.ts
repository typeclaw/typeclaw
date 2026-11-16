#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundled `bun run`-able render script for the doc-render plugin: the agent runs
// `bun run <this> <doc.html> <out.pdf>`. Lives as a script (not a registered
// tool) so it costs zero always-on system-prompt context. It prints with the
// Chrome the image already ships for the default browser tooling, through
// Chrome's own headless `--print-to-pdf`, so rendering needs no package install.
// Headless print honors the document's `@page` size and margin boxes; the
// document is self-contained and nothing is injected.

// Same default the image's agent-browser wrapper uses (src/init/dockerfile.ts);
// an operator AGENT_BROWSER_EXECUTABLE_PATH wins there and here.
export const DEFAULT_CHROME_PATH = '/usr/local/lib/typeclaw-agent-browser/chrome'
const RENDER_TIMEOUT_MS = 90_000

export function chromePath(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_BROWSER_EXECUTABLE_PATH || DEFAULT_CHROME_PATH
}

export function chromePrintArgs(inFile: string, outFile: string, profileDir: string): string[] {
  return [
    '--headless',
    // Chrome's own sandbox cannot nest inside the per-tool bwrap userns; bwrap
    // is the boundary here, same as for agent-browser. The image wrapper adds
    // this too, but an operator override may point at a raw binary.
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--allow-file-access-from-files',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${resolve(outFile)}`,
    pathToFileURL(resolve(inFile)).href,
  ]
}

export async function renderPdf(inFile: string, outFile: string): Promise<number> {
  const chrome = chromePath()
  if (!existsSync(chrome)) {
    throw new Error(`no Chrome at ${chrome}. Set AGENT_BROWSER_EXECUTABLE_PATH to a Chrome/Chromium binary.`)
  }
  if (!existsSync(inFile)) throw new Error(`no such document: ${inFile}`)

  const out = resolve(outFile)
  // A stale PDF from an earlier run must not pass for this run's output.
  await rm(out, { force: true })
  await mkdir(dirname(out), { recursive: true })
  const profileDir = await mkdtemp(join(tmpdir(), 'doc-render-chrome-'))
  try {
    const proc = Bun.spawn([chrome, ...chromePrintArgs(inFile, out, profileDir)], {
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: RENDER_TIMEOUT_MS,
    })
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (proc.signalCode) throw new Error(`Chrome was killed (${proc.signalCode}) after ${RENDER_TIMEOUT_MS / 1000}s`)
    if (exitCode !== 0 || !existsSync(out) || statSync(out).size === 0) {
      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      throw new Error(`Chrome exited ${exitCode} without writing ${outFile}${tail ? `:\n${tail}` : ''}`)
    }
    return statSync(out).size
  } finally {
    await rm(profileDir, { recursive: true, force: true })
  }
}

const EXIT_RENDER_FAILED = 1
const EXIT_BAD_USAGE = 2

async function main(): Promise<void> {
  const [, , inFile, outFile] = process.argv
  if (!inFile || !outFile) {
    process.stderr.write('usage: bun run render.ts <doc.html> <out.pdf>\n')
    process.exit(EXIT_BAD_USAGE)
  }

  let bytes: number
  try {
    bytes = await renderPdf(inFile, outFile)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`doc-render: render failed: ${message}\n`)
    process.exit(EXIT_RENDER_FAILED)
  }

  process.stdout.write(`wrote ${outFile} (${bytes} bytes)\n`)
}

if (import.meta.main) {
  await main()
}
