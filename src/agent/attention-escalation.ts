import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Human attention-escalation is a budget hint, not a command. Keep phrases narrow:
// explicit demands for care, or clear dissatisfaction directed at this response.
const EN_PHRASES: readonly string[] = [
  'do it properly',
  'do it right',
  'do it correctly',
  'be careful',
  'be thorough',
  'think hard',
  'think harder',
  'think carefully',
  'more carefully',
  'ultrathink',
  'ultrawork',
  'ultracode',
  'wtf',
  'wtf is this',
  'fuck',
  'fucking',
  'fucked',
  'fuck this',
  'fuck off',
  'what the fuck',
  'what the hell',
  'da fuck',
  'the fuck',
  'what are you doing',
  'what are u doing',
  'this is wrong',
  "that's wrong",
  'ffs',
  'for fucks sake',
  'shit',
  'this is shit',
  'bullshit',
  'damn it',
  'damn this',
  'dammit',
  'goddamn',
  'god damn',
  'this is crap',
  'piece of shit',
  'screw this',
  'screwed up',
  'you suck',
  'this sucks',
  'garbage',
  'trash',
  'useless',
  'are you serious',
  'seriously?',
  'are you kidding',
  'you kidding me',
  'come on',
  'cmon',
  'jesus christ',
  'oh my god',
  'omfg',
  'stupid',
  'idiot',
  'moron',
  'pathetic',
  'terrible',
  'awful',
  'broken again',
  'still broken',
  'not again',
]

const KO_PHRASES: readonly string[] = [
  '제대로 해',
  '제대로 좀',
  '똑바로 해',
  '똑바로 좀',
  '잘 좀',
  '잘 해',
  '신중하게',
  '꼼꼼하게',
  '씨발',
  '시발',
  '씨바',
  'ㅅㅂ',
  '시바',
  '존나',
  '졸라',
  'ㅈㄴ',
  '개같',
  '개판',
  '병신',
  'ㅂㅅ',
  '미친',
  '미쳤',
  'ㅁㅊ',
  '엿같',
  '짜증',
  '짜증나',
  '빡치',
  '빡쳐',
  '개소리',
  '말도 안',
  '실화냐',
  '에휴',
  '아오',
  '하…',
  '쓰레기',
  '구려',
  '구리',
  '왜 안',
  '또 안',
  '또 틀',
  '왜 이래',
  '뭐하는 거야',
  '뭐하는거야',
  '뭐 하는 거야',
  '아 진짜',
  '장난해',
  '장난하냐',
  '이게 뭐야',
  '똑바로 안 해',
]

const ES_PHRASES: readonly string[] = [
  'hazlo bien',
  'hazlo correctamente',
  'con cuidado',
  'piensa bien',
  'qué haces',
  'que haces',
  'mierda',
  'joder',
  'jode',
  'puto',
  'puta madre',
  'cabrón',
  'cabron',
  'coño',
  'no jodas',
  'qué carajo',
  'que carajo',
  'carajo',
  'basura',
  'esto es una mierda',
  'es una basura',
  'inútil',
  'inutil',
  'me cago',
  'qué asco',
  'que asco',
  'maldita sea',
  'estás de broma',
  'estas de broma',
  'qué mierda',
  'que mierda',
  'en serio',
  'esto está mal',
  'esto esta mal',
]

const FR_PHRASES: readonly string[] = [
  'fais-le correctement',
  'fais-le bien',
  'sois attentif',
  'réfléchis bien',
  'reflechis bien',
  "qu'est-ce que tu fais",
  'putain',
  'merde',
  'fait chier',
  'fait chié',
  'connerie',
  'conneries',
  'bordel',
  'foutu',
  'fous-toi',
  "c'est de la merde",
  'c’est de la merde',
  "c'est pourri",
  'c’est pourri',
  'tu te fous',
  "n'importe quoi",
  'n’importe quoi',
  'inutile',
  'poubelle',
  'tu déconnes',
  'tu deconnes',
  'c’est nul',
  "c'est nul",
  'sérieusement',
  'serieusement',
  'c’est faux',
  "c'est faux",
]

const IT_PHRASES: readonly string[] = [
  'fallo bene',
  'con attenzione',
  'pensa bene',
  'ma che fai',
  'cazzo',
  'merda',
  'che cazzo',
  'porca',
  'porca miseria',
  'stronzata',
  'stronzate',
  'vaffanculo',
  'è una merda',
  'e una merda',
  'che schifo',
  'schifo',
  'spazzatura',
  'inutile',
  'ma che cavolo',
  'fai schifo',
  'scherzi',
  'che cavolo',
  'sul serio',
  'è sbagliato',
  'e sbagliato',
]

const PT_PHRASES: readonly string[] = [
  'faça direito',
  'faca direito',
  'faça corretamente',
  'faca corretamente',
  'com cuidado',
  'pense bem',
  'que isso',
  'merda',
  'porra',
  'caralho',
  'que merda',
  'que porra',
  'puta que pariu',
  'porcaria',
  'é uma merda',
  'e uma merda',
  'que saco',
  'lixo',
  'inútil',
  'inutil',
  'que droga',
  'tá de brincadeira',
  'ta de brincadeira',
  'foda-se',
  'foda se',
  'está errado',
  'esta errado',
]

const DE_PHRASES: readonly string[] = [
  'mach es richtig',
  'sei gründlich',
  'sei gruendlich',
  'denk nach',
  'sorgfältig',
  'sorgfaeltig',
  'was machst du',
  'was soll das',
  'scheiße',
  'scheisse',
  'scheiss',
  'verdammt',
  'verflucht',
  'so ein mist',
  'blödsinn',
  'bloedsinn',
  'quatsch',
  'das ist mist',
  'das ist müll',
  'das ist mull',
  'müll',
  'schwachsinn',
  'nutzlos',
  'unbrauchbar',
  'verarschst',
  'soll das',
  'im ernst',
  'ernsthaft',
  'das ist falsch',
]

const RU_PHRASES: readonly string[] = [
  'сделай правильно',
  'сделай как надо',
  'внимательно',
  'тщательно',
  'что ты делаешь',
  'что за',
  'блять',
  'бля',
  'блядь',
  'сука',
  'нахуй',
  'нахер',
  'пиздец',
  'хуйня',
  'говно',
  'дерьмо',
  'бред',
  'это бред',
  'фигня',
  'хрень',
  'мусор',
  'бесполезно',
  'издеваешься',
  'охренеть',
  'какого черта',
  'какого чёрта',
  'да блин',
  'серьёзно',
  'серьезно',
  'это неправильно',
]

const ZH_PHRASES: readonly string[] = [
  '认真做',
  '好好做',
  '仔细点',
  '用心做',
  '卧槽',
  '我操',
  '操你',
  '操你妈',
  '我擦',
  '草泥马',
  '我草',
  '草你',
  '我靠',
  '靠北',
  '靠杯',
  '妈的',
  '他妈的',
  'tmd',
  '垃圾',
  '狗屎',
  '搞屁',
  '搞毛',
  '什么垃圾',
  '太烂了',
  '烂代码',
  '废话',
  '神经病',
  '有病',
  '认真点',
  '搞什么',
  '搞什么鬼',
  '你在干什么',
  '什么鬼',
  '认真的吗',
]

const JA_PHRASES: readonly string[] = [
  'ちゃんとやって',
  'しっかりやって',
  '真面目にやって',
  '丁寧に',
  'くそ',
  'クソ',
  'くそが',
  'ふざけんな',
  'ふざけるな',
  'ばか',
  'バカ',
  'あほ',
  'アホ',
  'ゴミ',
  'クズ',
  'ちくしょう',
  '畜生',
  '使えない',
  '最悪',
  'ありえない',
  'うざい',
  'むかつく',
  'なんなの',
  'ksk',
  '何やってんの',
  '何してるの',
  'ふざけてるの',
  'マジで',
  'ちゃんとして',
]

const AR_PHRASES: readonly string[] = [
  'اعملها صح',
  'بعناية',
  'فكر جيدا',
  'تبا',
  'تباً',
  'اللعنة',
  'لعنة',
  'قرف',
  'هراء',
  'حقير',
  'غبي',
  'سخيف',
  'فاشل',
  'هذا هراء',
  'ما هذا الهراء',
  'تافه',
  'زبالة',
  'عديم الفائدة',
  'هل تمزح',
  'ماذا تفعل',
  'ما هذا',
  'بجدية',
  'هذا خطأ',
]

const HI_PHRASES: readonly string[] = [
  'ठीक से करो',
  'ध्यान से',
  'अच्छे से करो',
  'बकवास',
  'यह बकवास है',
  'बेकार',
  'बेवकूफ',
  'घटिया',
  'कचरा',
  'गंदा',
  'मज़ाक',
  'मजाक',
  'धत',
  'क्या बकवास',
  'पागल हो',
  'बहुत बुरा',
  'क्या कर रहे हो',
  'यह गलत है',
  'सच में',
]

const TR_PHRASES: readonly string[] = [
  'düzgün yap',
  'duzgun yap',
  'doğru yap',
  'dogru yap',
  'dikkatli ol',
  'iyice düşün',
  'iyice dusun',
  'siktir',
  'lanet',
  'kahretsin',
  'saçmalık',
  'saçma',
  'bok',
  'boktan',
  'rezalet',
  'berbat',
  'çöp',
  'işe yaramaz',
  'ise yaramaz',
  'aptal',
  'salak',
  'dalga mı',
  'dalga mi',
  'bu ne rezalet',
  'ne yapıyorsun',
  'ne yapiyorsun',
  'ne saçmalık',
  'ne sacmalik',
  'cidden mi',
  'bu yanlış',
  'bu yanlis',
]

const VI_PHRASES: readonly string[] = [
  'làm cho đúng',
  'lam cho dung',
  'làm cẩn thận',
  'lam can than',
  'suy nghĩ kỹ',
  'suy nghi ky',
  'đệch',
  'đếch',
  'vãi',
  'cứt',
  'rác',
  'vô dụng',
  'vo dung',
  'ngớ ngẩn',
  'tệ',
  'tệ hại',
  'quá tệ',
  'đùa à',
  'dua a',
  'vớ vẩn',
  'vo van',
  'chán',
  'đang làm gì vậy',
  'dang lam gi vay',
  'cái gì vậy',
  'cai gi vay',
  'nghiêm túc',
  'nghiem tuc',
  'sai rồi',
  'sai roi',
]

const ID_PHRASES: readonly string[] = [
  'lakukan dengan benar',
  'hati-hati',
  'pikirkan baik-baik',
  'anjing',
  'bangsat',
  'sialan',
  'kampret',
  'goblok',
  'tolol',
  'bodoh',
  'sampah',
  'jelek',
  'payah',
  'tidak berguna',
  'gak guna',
  'omong kosong',
  'yang benar saja',
  'bercanda',
  'lagi ngapain',
  'apa-apaan',
  'ini salah',
]

const ALL_PHRASES: readonly string[] = [
  ...EN_PHRASES,
  ...KO_PHRASES,
  ...ES_PHRASES,
  ...FR_PHRASES,
  ...IT_PHRASES,
  ...PT_PHRASES,
  ...DE_PHRASES,
  ...RU_PHRASES,
  ...ZH_PHRASES,
  ...JA_PHRASES,
  ...AR_PHRASES,
  ...HI_PHRASES,
  ...TR_PHRASES,
  ...VI_PHRASES,
  ...ID_PHRASES,
]

const MORPHEME_PATTERNS: readonly RegExp[] = []

const MIN_LENGTH = 2

// "Jeff Bezos detection": a message that is dense with question marks is a
// human pressing for a real answer (Bezos was famous for replying to internal
// mail with a single "?"). We treat three question-shaped patterns as the same
// budget hint the phrase tables emit — care, not a command. Idea from
// GitHub @kdhfred.
//
// Question punctuation is multilingual: ASCII `?`, fullwidth `？` (U+FF1F),
// Arabic `؟` (U+061F), and Armenian `՞` (U+055E). The Greek question mark is the
// ASCII `;`, and `·` (U+00B7) is the Greek ano teleia — both are ambiguous with
// ordinary punctuation in Latin text, so they only count as question marks when
// the same message actually contains Greek letters.
const QUESTION_PUNCT_RE = /[?？\u061F\u055E]/u
// The Greek question mark is the ASCII semicolon `;` (and its canonical
// equivalent U+037E). The ano teleia `·` (U+00B7) is the Greek SEMICOLON, not a
// question mark, so it splits sentences but must never count as a question.
const GREEK_QUESTION_PUNCT_RE = /[;\u037E]/u
const GREEK_LETTER_RE = /\p{Script=Greek}/u
// Armenian writes its question mark `՞` (U+055E) INSIDE the questioned word
// (e.g. `Ի՞նչ եք անում։`), not as a terminal mark — so it must not split a
// sentence. We detect it on the chunk body instead, and let the Armenian full
// stop `։` (U+0589, distinct from ASCII `:`) terminate the sentence.
const ARMENIAN_INLINE_QUESTION_RE = /\u055E/u
// `\b` is ASCII-only and meaningless for CJK/Arabic/Hindi, so we count Unicode
// letters and numbers directly instead of tokenizing on word boundaries.
const ALNUM_RE = /[\p{L}\p{N}]/gu
// Terminal punctuation that ends a sentence-like chunk, across scripts.
const TERMINATOR_SPLIT_RE = /([.!?？\u061F;·。！？\u0589]+)/u

function hasGreek(text: string): boolean {
  return GREEK_LETTER_RE.test(text)
}

function isQuestionRun(run: string, greek: boolean): boolean {
  if (QUESTION_PUNCT_RE.test(run)) return true
  return greek && GREEK_QUESTION_PUNCT_RE.test(run)
}

function isQuestionSentence(body: string, terminator: string, greek: boolean): boolean {
  return isQuestionRun(terminator, greek) || ARMENIAN_INLINE_QUESTION_RE.test(body)
}

function isQuestionOrSpace(char: string, greek: boolean): boolean {
  if (/\s/u.test(char)) return true
  if (QUESTION_PUNCT_RE.test(char)) return true
  return greek && GREEK_QUESTION_PUNCT_RE.test(char)
}

function countAlnum(text: string): number {
  const matches = text.match(ALNUM_RE)
  return matches === null ? 0 : matches.length
}

// Mode 1: the whole message is nothing but question marks (and whitespace) —
// `?`, `???`, `？？`, `؟؟؟`. A trailing `?` on a real sentence, or `?!`, must NOT
// match here; those are handled (if at all) by the other modes.
function isQuestionOnlyMessage(normalized: string): boolean {
  if (normalized.length === 0) return false
  const greek = hasGreek(normalized)
  let sawQuestion = false
  for (const char of normalized) {
    if (QUESTION_PUNCT_RE.test(char) || (greek && GREEK_QUESTION_PUNCT_RE.test(char))) {
      sawQuestion = true
      continue
    }
    if (!isQuestionOrSpace(char, greek)) return false
  }
  return sawQuestion
}

type Sentence = { text: string; isQuestion: boolean }

function splitSentences(normalized: string): Sentence[] {
  const greek = hasGreek(normalized)
  const parts = normalized.split(TERMINATOR_SPLIT_RE)
  const sentences: Sentence[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? ''
    const terminator = parts[i + 1] ?? ''
    const trimmed = body.trim()
    if (trimmed.length === 0 && terminator.length === 0) continue
    if (trimmed.length === 0) continue
    sentences.push({ text: trimmed, isQuestion: isQuestionSentence(trimmed, terminator, greek) })
  }
  return sentences
}

// Mode 2: a single turn packed with separate questions — "are you …? do you …?
// what …? how …?". Require 3+ genuine question sentences, each with enough
// content (>= 3 letters/numbers) so a bare "? ? ?" stays a mode-1 case only.
const MODE2_MIN_QUESTIONS = 3
const SENTENCE_MIN_ALNUM = 3

function countContentfulQuestions(sentences: readonly Sentence[]): number {
  let count = 0
  for (const sentence of sentences) {
    if (sentence.isQuestion && countAlnum(sentence.text) >= SENTENCE_MIN_ALNUM) count++
  }
  return count
}

export type QuestionSignal = {
  endedWithQuestion: boolean
  questionSentenceCount: number
  // True when the turn is mostly questions (>= 60% of its sentences), so a
  // single trailing "?" on an otherwise statement-heavy message is not "dominant".
  dominant: boolean
  alnumCount: number
}

export function getQuestionSignal(text: string): QuestionSignal {
  const normalized = normalize(text)
  if (normalized.length === 0) {
    return { endedWithQuestion: false, questionSentenceCount: 0, dominant: false, alnumCount: 0 }
  }
  const sentences = splitSentences(normalized)
  const questionSentenceCount = sentences.reduce((acc, s) => acc + (s.isQuestion ? 1 : 0), 0)
  const sentenceCount = Math.max(sentences.length, 1)
  return {
    endedWithQuestion: sentences.at(-1)?.isQuestion ?? false,
    questionSentenceCount,
    dominant: questionSentenceCount >= 1 && questionSentenceCount >= Math.ceil(sentenceCount * 0.6),
    alnumCount: countAlnum(normalized),
  }
}

// Mode 3: the user is interrogating across turns — a question-dominant turn
// following another question-dominant turn (prev "why …?", current "how …?").
// A single trailing "?" on consecutive turns is far too common in normal chat,
// so both turns must be dominant, both must end on a question mark, and both
// must carry real content (>= 12 letters/numbers) to clear the noise floor.
const MODE3_MIN_ALNUM = 12

function isSequentialQuestionEscalation(current: QuestionSignal, prior: QuestionSignal | null | undefined): boolean {
  return Boolean(
    prior?.dominant &&
    current.dominant &&
    prior.endedWithQuestion &&
    current.endedWithQuestion &&
    prior.alnumCount >= MODE3_MIN_ALNUM &&
    current.alnumCount >= MODE3_MIN_ALNUM,
  )
}

export function detectAttentionEscalation(text: string, prior?: QuestionSignal | null): boolean {
  const normalized = normalize(text)
  // Mode 1 deliberately bypasses MIN_LENGTH: a lone "?" is shorter than the
  // phrase-table floor but is itself the signal.
  if (isQuestionOnlyMessage(normalized)) return true
  if (normalized.length < MIN_LENGTH) return false
  const sentences = splitSentences(normalized)
  if (countContentfulQuestions(sentences) >= MODE2_MIN_QUESTIONS) return true
  if (isSequentialQuestionEscalation(getQuestionSignal(text), prior)) return true
  if (ALL_PHRASES.some((phrase) => normalized.includes(phrase))) return true
  return MORPHEME_PATTERNS.some((pattern) => pattern.test(normalized))
}

// Escalation targets `xhigh`. `setThinkingLevel` clamps it per model (down to
// `high` where unsupported), so it's safe to pass unconditionally. `max` ranks
// above `xhigh` (pi-ai models.js level order) on the models that offer it
// (GPT-6, Claude Opus 5.5), so a session already at `max` keeps it: an
// escalation turn must never get less effort than an ordinary one.
const ESCALATED_LEVEL: ThinkingLevel = 'xhigh'

// `allowEscalation: false` pins the turn to `sessionDefault`. Subagent turns set
// it because their "user prompt" is composed by another agent, not a human — so
// the question-mark/frustration heuristics would misread a multi-question brief
// and silently bump a `fast`/`low` worker to `xhigh`. Default `true` keeps the
// human-facing sessions (TUI, channels, cron) escalating as before.
export type TurnThinkingOptions = { allowEscalation?: boolean }

export function resolveTurnThinkingLevel(
  text: string,
  sessionDefault: ThinkingLevel | undefined,
  prior?: QuestionSignal | null,
  options?: TurnThinkingOptions,
): ThinkingLevel | undefined {
  if (options?.allowEscalation === false) return sessionDefault
  if (sessionDefault === 'max' || !detectAttentionEscalation(text, prior)) return sessionDefault
  return ESCALATED_LEVEL
}

type ThinkingLevelSettable = {
  setThinkingLevel(level: ThinkingLevel): void
}

// `setThinkingLevel` only mutates reasoning_effort (a per-request param), so a
// per-turn bump preserves the prompt-prefix cache — no session recreation, no
// model swap. Skipping the call when nothing resolves leaves the SDK default intact.
export function applyTurnThinkingLevel(
  session: ThinkingLevelSettable,
  text: string,
  sessionDefault: ThinkingLevel | undefined,
  prior?: QuestionSignal | null,
  options?: TurnThinkingOptions,
): void {
  const resolved = resolveTurnThinkingLevel(text, sessionDefault, prior, options)
  if (resolved !== undefined) session.setThinkingLevel(resolved)
}
