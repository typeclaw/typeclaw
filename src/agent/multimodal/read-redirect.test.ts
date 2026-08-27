import { describe, expect, test } from 'bun:test'

import { GUARD_IMAGE_READ_REDIRECT, checkImageReadRedirect } from './read-redirect'

describe('image-read-redirect guard', () => {
  test('blocks read of common image extensions', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'screenshot.png' } })?.kind).toBe(
      'acknowledgement-required',
    )
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'photo.jpg' } })?.kind).toBe('acknowledgement-required')
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'photo.jpeg' } })?.kind).toBe(
      'acknowledgement-required',
    )
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'meme.gif' } })?.kind).toBe('acknowledgement-required')
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'hero.webp' } })?.kind).toBe('acknowledgement-required')
  })

  test('matches extensions case-insensitively', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'Screenshot.PNG' } })?.kind).toBe(
      'acknowledgement-required',
    )
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'PHOTO.JPG' } })?.kind).toBe('acknowledgement-required')
  })

  test('blocks images under nested paths and absolute paths', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'workspace/screenshots/foo.png' } })?.kind).toBe(
      'acknowledgement-required',
    )
    expect(checkImageReadRedirect({ tool: 'read', args: { path: '/agent/workspace/foo.jpg' } })?.kind).toBe(
      'acknowledgement-required',
    )
    expect(checkImageReadRedirect({ tool: 'read', args: { path: '/tmp/agent-browser-snapshot.png' } })?.kind).toBe(
      'acknowledgement-required',
    )
  })

  test('redirect message names look_at and quotes the original path', () => {
    const result = checkImageReadRedirect({ tool: 'read', args: { path: 'workspace/foo.png' } })
    expect(result?.reason).toContain('look_at')
    expect(result?.reason).toContain('"workspace/foo.png"')
    expect(result?.reason).toContain('imageReadRedirect')
  })

  test('cannot observe an acknowledgement envelope', () => {
    const result = checkImageReadRedirect({
      tool: 'read',
      args: { path: 'workspace/foo.png' },
    })
    expect(result?.kind).toBe('acknowledgement-required')
  })

  test('allows reads of non-image files', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'README.md' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'src/index.ts' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'package.json' } })).toBeUndefined()
  })

  test('allows reads of non-supported image formats (matches upstream attachment scope)', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'icon.svg' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'photo.heic' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'scan.tiff' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'photo.bmp' } })).toBeUndefined()
  })

  test('allows reads of extensionless files (matches extension-only trigger contract)', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'Dockerfile' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 'workspace/raw-screenshot' } })).toBeUndefined()
  })

  test('does not apply to non-read tools', () => {
    expect(checkImageReadRedirect({ tool: 'write', args: { path: 'workspace/foo.png' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'edit', args: { path: 'workspace/foo.png' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'bash', args: { path: 'workspace/foo.png' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'grep', args: { path: 'workspace/foo.png' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'ls', args: { path: 'workspace/foo.png' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'find', args: { path: 'workspace/foo.png' } })).toBeUndefined()
  })

  test('handles non-string and missing path gracefully', () => {
    expect(checkImageReadRedirect({ tool: 'read', args: { path: 42 } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: { path: '' } })).toBeUndefined()
    expect(checkImageReadRedirect({ tool: 'read', args: {} })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_IMAGE_READ_REDIRECT).toBe('imageReadRedirect')
  })
})
