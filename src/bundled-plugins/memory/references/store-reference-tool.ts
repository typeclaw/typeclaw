import { mkdir, writeFile } from 'node:fs/promises'

import { z } from 'zod'

import { defineTool } from '@/plugin'

import { referenceFilePath, referencesDir } from '../paths'
import { headingToSlug } from '../slug'
import { renderReference, type ReferenceOrigin } from './frontmatter'
import { listReferenceSlugs } from './load-references'

export type ReferenceStoredHook = (context: { slug: string; body: string }) => Promise<void>

export const storeReferenceTool = createStoreReferenceTool()

export function createStoreReferenceTool(onReferenceStored?: ReferenceStoredHook) {
  return defineTool({
    description:
      'store_reference: Store a verbatim reference artifact under memory/references/ and return its slug. Use this for user-provided SQL, code blocks, runbooks, pasted specs, or other content explicitly meant to be remembered byte-for-byte. This tool does not write memory stream fragments.',
    parameters: z.object({
      title: z.string().min(1),
      body: z.string(),
      origin: z.enum(['episode', 'curated', 'external']),
      tags: z.array(z.string()).optional(),
    }),
    // title/body/tags are prose the tool writes under a runtime-computed slug
    // path; none is a caller-supplied file path. Declared so a title like
    // "README.md" or a body carrying "/" is not misread as a file operand.
    fileOperands: { nonFile: ['title', 'body', 'tags'] },
    async execute(input, ctx) {
      return storeReference(input, ctx.agentDir, onReferenceStored)
    },
  })
}

export async function storeReference(
  input: {
    readonly title: string
    readonly body: string
    readonly origin: ReferenceOrigin
    readonly tags?: string[] | undefined
  },
  agentDir: string,
  onReferenceStored?: ReferenceStoredHook,
) {
  const { title, body, origin, tags } = input
  const existingSlugs = new Set(await listReferenceSlugs(agentDir))
  const created = new Date().toISOString()
  const content = renderReference(
    {
      title,
      origin,
      created,
      lastAccessed: created,
      accessCount: 0,
      pinned: false,
      demoted: false,
      tags: tags ?? [],
    },
    body,
  )

  await mkdir(referencesDir(agentDir), { recursive: true })
  // Concurrent writers (memory-logger and every main-agent session) can pick
  // the same slug from the same listing, so the file is reserved with an
  // exclusive create and a taken slug moves to the next deduplicated suffix.
  let slug = headingToSlug(title, existingSlugs)
  let path = referenceFilePath(agentDir, slug)
  for (;;) {
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
      break
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
      existingSlugs.add(slug)
      slug = headingToSlug(title, existingSlugs)
      path = referenceFilePath(agentDir, slug)
    }
  }

  if (onReferenceStored !== undefined) await onReferenceStored({ slug, body })

  return {
    content: [{ type: 'text' as const, text: `Stored reference as ${slug}` }],
    details: { path, slug },
  }
}
