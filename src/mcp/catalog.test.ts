import { describe, expect, test } from 'bun:test'

import { renderMcpCatalog } from './catalog'

describe('renderMcpCatalog', () => {
  test('returns an empty string when there are no connected MCP servers', () => {
    expect(renderMcpCatalog([])).toBe('')
    expect(renderMcpCatalog([{ name: 'failed', connected: false, toolCount: 3 }])).toBe('')
  })

  test('renders connected servers with tool counts and descriptions', () => {
    const catalog = renderMcpCatalog([
      { name: 'files', description: 'Filesystem tools', connected: true, toolCount: 2 },
      { name: 'git', connected: true, toolCount: 1 },
    ])

    expect(catalog).toContain('## MCP servers')
    expect(catalog).toContain('- files (2 tools): Filesystem tools')
    expect(catalog).toContain('- git (1 tools): no description')
    expect(catalog).toContain('mcp_list_tools(server)')
  })

  test('does not advertise disconnected servers', () => {
    const catalog = renderMcpCatalog([
      { name: 'files', connected: true, toolCount: 2 },
      { name: 'broken', description: 'Unavailable', connected: false, toolCount: 9 },
    ])

    expect(catalog).toContain('files')
    expect(catalog).not.toContain('broken')
  })
})
