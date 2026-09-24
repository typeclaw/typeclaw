import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOAuthInteraction, makeFakeOAuthLoginRunner, makeOAuthLoginRunner } from './oauth-login'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-oauth-'))
})
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('OAuth login runner', () => {
  test('reports provider selected by the model ref', async () => {
    const calls: string[] = []
    const result = await makeFakeOAuthLoginRunner({ onCalled: ({ providerId }) => calls.push(providerId) })({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['openai-codex'])
  })

  test('rejects an API-key-only provider before login', async () => {
    const result = await makeOAuthLoginRunner({
      onAuth: () => {},
      onPrompt: async () => null,
      onSecret: async () => null,
      onSelect: async () => null,
    })({
      cwd: root,
      model: 'openai/gpt-5.4-nano',
    })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('does not support OAuth') })
  })
  test('returns the selected OpenAI Codex login method ID to pi-ai', async () => {
    const options = [
      { id: 'browser', label: 'Browser login (default)' },
      { id: 'device_code', label: 'Device code login (headless)' },
    ] as const

    for (const expected of ['browser', 'device_code']) {
      const interaction = createOAuthInteraction({
        onAuth: () => {},
        onPrompt: async () => {
          throw new Error('select prompts must not use the text callback')
        },
        onSecret: async () => {
          throw new Error('select prompts must not use the secret callback')
        },
        onSelect: async (_message, receivedOptions) => {
          expect(receivedOptions).toEqual(options)
          return expected
        },
      })

      expect(await interaction.prompt({ type: 'select', message: 'Choose a method', options })).toBe(expected)
    }
  })

  test('cancels login when the selection is cancelled or does not match an option ID', async () => {
    const options = [{ id: 'browser', label: 'Browser login (default)' }] as const

    for (const selected of [null, 'unknown-method']) {
      const interaction = createOAuthInteraction({
        onAuth: () => {},
        onPrompt: async () => {
          throw new Error('select prompts must not use the text callback')
        },
        onSecret: async () => {
          throw new Error('select prompts must not use the secret callback')
        },
        onSelect: async () => selected,
      })

      await expect(interaction.prompt({ type: 'select', message: 'Choose a method', options })).rejects.toThrow(
        'Login cancelled by user',
      )
    }
  })

  test('forwards manual-code input only when provided', async () => {
    const supplied = createOAuthInteraction({
      onAuth: () => {},
      onPrompt: async () => 'fallback',
      onSelect: async () => 'browser',
      onSecret: async () => 'fallback-secret',
      onManualCodeInput: async () => 'manual',
    })
    expect(await supplied.prompt({ type: 'manual_code', message: 'paste' })).toBe('manual')
    const absent = createOAuthInteraction({
      onAuth: () => {},
      onPrompt: async () => 'fallback',
      onSelect: async () => 'browser',
      onSecret: async () => 'fallback-secret',
    })
    expect(await absent.prompt({ type: 'manual_code', message: 'paste' })).toBe('fallback')
  })

  test('routes secret prompts to the masked callback', async () => {
    let textCalls = 0
    let secretCalls = 0
    const interaction = createOAuthInteraction({
      onAuth: () => {},
      onPrompt: async () => {
        textCalls++
        return 'visible'
      },
      onSecret: async () => {
        secretCalls++
        return 'masked'
      },
      onSelect: async () => 'browser',
    })

    expect(await interaction.prompt({ type: 'secret', message: 'API key' })).toBe('masked')
    expect(secretCalls).toBe(1)
    expect(textCalls).toBe(0)
  })

  test('passes a configured fake failure through unchanged', async () => {
    const result = await makeFakeOAuthLoginRunner({ result: { ok: false, reason: 'cancelled' } })({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
    })
    expect(result).toEqual({ ok: false, reason: 'cancelled' })
  })
})
