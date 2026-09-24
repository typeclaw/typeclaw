import { describe, expect, test } from 'bun:test'

import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

import {
  applyTurnThinkingLevel,
  detectAttentionEscalation,
  getQuestionSignal,
  resolveTurnThinkingLevel,
} from './attention-escalation'

describe('detectAttentionEscalation — positive (explicit effort)', () => {
  const escalating: readonly string[] = [
    'do it properly this time',
    'please ultrathink before answering',
    '제대로 해 주세요',
    '认真做一下',
    'ちゃんとやってください',
  ]

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — positive (frustration / dissatisfaction)', () => {
  const escalating: readonly string[] = [
    'wtf',
    'what are you doing',
    'this is fucking broken',
    'bullshit',
    'this is garbage',
    '뭐하는 거야',
    '씨발',
    '존나',
    '존나 짜증나',
    '병신같네',
    '我操',
    '卧槽',
    '草泥马',
    '我靠',
    '靠北',
    '垃圾代码',
    'くそ',
    'ふざけんな',
    'esto es una mierda',
    'que merda',
    'это бред',
    'هذا هراء',
    'apa-apaan',
    'goddamn it',
    'dammit',
  ]

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — positive (normalization)', () => {
  const escalating: readonly string[] = ['WTF', 'Ultrathink', '**제대로** 해', '`wtf`']

  for (const text of escalating) {
    test(`detects normalized: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }
})

describe('detectAttentionEscalation — negative', () => {
  const notEscalating: readonly string[] = [
    'please add a test',
    'looks good, thanks',
    '네 알겠습니다',
    '수고하셨습니다',
    'serious',
    'seriously',
    'this is a serious issue',
    'serious refactor',
    'i need serious help here',
    'a series of tests',
    'abs workout',
    'great jobs',
    'position update',
    'copy the file',
    'racing game',
    'compose a message',
    'i can cut this',
    'the tabs are aligned',
    'subscribe now',
    '操作系统',
    '操作步骤',
    '草稿',
    '起草文档',
    '可靠的方案',
    '依靠',
    '废物利用很好',
    'damnation is a word',
    'scrap the old code',
    'the condemnation',
    'reassign the task',
    '',
    'ok',
  ]

  for (const text of notEscalating) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(false)
    })
  }
})

describe('detectAttentionEscalation — question-only message (mode 1)', () => {
  const escalating: readonly string[] = ['?', '???', '？？', '？？？', '؟؟؟', '？ ？ ？', '?\n?', '`?`', '? ? ?']

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }

  const notQuestionOnly: readonly string[] = ['?!', 'what?', 'hmm ...', '!', '. ?']

  for (const text of notQuestionOnly) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(false)
    })
  }
})

describe('detectAttentionEscalation — many questions in one turn (mode 2)', () => {
  const escalating: readonly string[] = [
    'are you sure? do you mean this? what about that? how does it work?',
    '왜 이렇게 했어? 어떻게 고쳐? 이게 맞아?',
    // zh: "Is this right? Why like this? How to change?"
    '\u8fd9\u662f\u5bf9\u7684\u5417? \u4e3a\u4ec0\u4e48\u8fd9\u6837? \u600e\u4e48\u6539?',
    'これで合ってる？ なぜこうした？ どう直す？',
  ]

  for (const text of escalating) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(true)
    })
  }

  const notEscalating: readonly string[] = [
    'is this right?',
    'is this right? yes it is. moving on now.',
    'do you think we should refactor this whole module today?',
  ]

  for (const text of notEscalating) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectAttentionEscalation(text)).toBe(false)
    })
  }
})

describe('detectAttentionEscalation — sequential question turns (mode 3)', () => {
  test('two question-dominant turns in a row escalate', () => {
    const prior = getQuestionSignal('why did the container crash on startup?')
    expect(detectAttentionEscalation('how do i actually fix this properly now?', prior)).toBe(true)
  })

  test('works across scripts (Korean prior + current)', () => {
    const prior = getQuestionSignal('이 컨테이너는 왜 자꾸 죽는 거야?')
    expect(detectAttentionEscalation('그럼 어떻게 고쳐야 하는 거야?', prior)).toBe(true)
  })

  test('no prior signal does not escalate a lone question', () => {
    expect(detectAttentionEscalation('how do i fix this thing?', null)).toBe(false)
    expect(detectAttentionEscalation('how do i fix this thing?', undefined)).toBe(false)
  })

  test('short trailing-? chit-chat on both turns does not escalate', () => {
    const prior = getQuestionSignal('this?')
    expect(detectAttentionEscalation('now this?', prior)).toBe(false)
  })

  test('statement-heavy current turn does not escalate even after a question', () => {
    const prior = getQuestionSignal('why did the container crash on startup?')
    expect(detectAttentionEscalation('ok thanks, that makes sense. i will try it now.', prior)).toBe(false)
  })
})

describe('getQuestionSignal', () => {
  test('captures trailing question, count, dominance, and content size', () => {
    const signal = getQuestionSignal('why did the container crash on startup?')
    expect(signal.endedWithQuestion).toBe(true)
    expect(signal.questionSentenceCount).toBe(1)
    expect(signal.dominant).toBe(true)
    expect(signal.alnumCount).toBeGreaterThanOrEqual(12)
  })

  test('statement-dominant turn is not dominant', () => {
    const signal = getQuestionSignal('here is the plan. step one is done. is that ok?')
    expect(signal.endedWithQuestion).toBe(true)
    expect(signal.dominant).toBe(false)
  })

  test('empty text yields a zero signal', () => {
    expect(getQuestionSignal('')).toEqual({
      endedWithQuestion: false,
      questionSentenceCount: 0,
      dominant: false,
      alnumCount: 0,
    })
  })

  test('Armenian in-word question mark counts as a question ending', () => {
    // ՞ (U+055E) sits inside the word `Ի՞նչ`; the sentence ends with `։` (U+0589).
    const signal = getQuestionSignal('Ի՞նչ եք անում։')
    expect(signal.questionSentenceCount).toBe(1)
    expect(signal.endedWithQuestion).toBe(true)
    expect(signal.dominant).toBe(true)
    expect(signal.alnumCount).toBeGreaterThan(0)
  })

  test('Greek ano teleia is a semicolon, not a question mark', () => {
    // `·` (U+00B7) splits clauses but is the Greek semicolon — not interrogative.
    const signal = getQuestionSignal('Πρώτο μέρος· δεύτερο μέρος· τρίτο μέρος·')
    expect(signal.questionSentenceCount).toBe(0)
    expect(signal.endedWithQuestion).toBe(false)
  })

  test('Greek question mark (ASCII semicolon) is interrogative', () => {
    const signal = getQuestionSignal('Τι κάνεις;')
    expect(signal.questionSentenceCount).toBe(1)
    expect(signal.endedWithQuestion).toBe(true)
  })
})

describe('detectAttentionEscalation — Greek ano teleia is not a question (mode 2)', () => {
  test('three ano-teleia clauses do not escalate', () => {
    expect(detectAttentionEscalation('Πρώτο μέρος· δεύτερο μέρος· τρίτο μέρος·')).toBe(false)
  })
})

describe('detectAttentionEscalation — Armenian sequential question turns (mode 3)', () => {
  test('two Armenian question turns in a row escalate', () => {
    const prior = getQuestionSignal('Ինչու՞ է այս կոնտեյները անընդհատ կանգ առնում։')
    expect(detectAttentionEscalation('Իսկ ինչպե՞ս եմ ես սա շտկում հիմա։', prior)).toBe(true)
  })
})

describe('resolveTurnThinkingLevel', () => {
  test('escalation text bumps to xhigh from any weaker session default', () => {
    expect(resolveTurnThinkingLevel('wtf', 'low')).toBe('xhigh')
    expect(resolveTurnThinkingLevel('제대로 해', undefined)).toBe('xhigh')
  })

  test('escalation never lowers a max session default', () => {
    expect(resolveTurnThinkingLevel('wtf', 'max')).toBe('max')
    expect(resolveTurnThinkingLevel('제대로 해', 'max')).toBe('max')
    expect(resolveTurnThinkingLevel('?', 'max')).toBe('max')
  })

  test('normal text falls back to the session default', () => {
    expect(resolveTurnThinkingLevel('add a comment', 'low')).toBe('low')
  })

  test('normal text with no session default stays undefined', () => {
    expect(resolveTurnThinkingLevel('add a comment', undefined)).toBeUndefined()
  })

  test('allowEscalation:false pins to the session default even on escalation text', () => {
    expect(resolveTurnThinkingLevel('wtf', 'low', null, { allowEscalation: false })).toBe('low')
    expect(resolveTurnThinkingLevel('제대로 해', 'low', null, { allowEscalation: false })).toBe('low')
  })

  test('allowEscalation:false with no session default stays undefined', () => {
    expect(resolveTurnThinkingLevel('wtf', undefined, null, { allowEscalation: false })).toBeUndefined()
  })
})

describe('applyTurnThinkingLevel', () => {
  function fakeSession() {
    const calls: ThinkingLevel[] = []
    return {
      calls,
      setThinkingLevel(level: ThinkingLevel): void {
        calls.push(level)
      },
    }
  }

  test('escalation turn sets xhigh', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'ultrathink please', 'low')
    expect(session.calls).toEqual(['xhigh'])
  })

  test('normal turn resets to the session default', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'add a comment', 'low')
    expect(session.calls).toEqual(['low'])
  })

  test('normal turn with no session default makes no call', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'add a comment', undefined)
    expect(session.calls).toEqual([])
  })

  test('escalation then normal bumps then resets', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, '뭐하는 거야', 'low')
    applyTurnThinkingLevel(session, 'thanks, looks good', 'low')
    expect(session.calls).toEqual(['xhigh', 'low'])
  })

  test('allowEscalation:false keeps an escalation turn at the session default', () => {
    const session = fakeSession()
    applyTurnThinkingLevel(session, 'ultrathink please', 'low', null, { allowEscalation: false })
    expect(session.calls).toEqual(['low'])
  })
})
