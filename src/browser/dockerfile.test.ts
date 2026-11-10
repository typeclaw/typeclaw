import { expect, test } from 'bun:test'

import { buildDockerfile } from '@/init/dockerfile'

test('the default browser config adds no browser layers to the image', () => {
  const dockerfile = buildDockerfile(undefined, { baseImageVersion: '1.2.3' })

  expect(dockerfile).not.toContain('# Browser engine')
  expect(dockerfile).not.toContain('# Browser extension')
})

test('enabled engines and extensions install pinned, checksum-verified layers in both image heads', () => {
  for (const baseImageVersion of ['1.2.3', null]) {
    const dockerfile = buildDockerfile(undefined, {
      baseImageVersion,
      browser: { engines: ['agent-browser', 'omowright', 'browser-use'], extensions: ['browserskill'] },
    })

    expect(dockerfile).toMatch(/bun add omowright@\d+\.\d+\.\d+/)
    expect(dockerfile).toMatch(/uv tool install --python 3\.12 browser-use==\d+\.\d+\.\d+/)
    expect(dockerfile).toContain('sha256sum -c -')
    expect(dockerfile).toContain('/usr/local/lib/typeclaw-browser/extensions/browserskill')
    expect(dockerfile.indexOf('# Browser engine omowright')).toBeLessThan(dockerfile.indexOf('ENTRYPOINT'))
  }
})
