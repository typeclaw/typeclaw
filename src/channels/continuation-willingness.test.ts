import { describe, expect, test } from 'bun:test'

import { detectContinuationWillingness } from './continuation-willingness'

describe('detectContinuationWillingness — positive (self-directed future intent)', () => {
  const willing: readonly string[] = [
    "I'll continue now.",
    "I'll keep checking the diff.",
    "I'll take a look at the rest.",
    'let me check the other files',
    'Let me verify that real quick',
    'On it now — checking the logs',
    'working on it now, one sec',
    "I'm on it, one sec",
    "I'll investigate the rest",
    "I'll look it up real quick",
    'lemme check the logs',
    'let me pull that up',
    'give me a moment',
    '죄송합니다. 바로 계속 확인하겠습니다.',
    '바로 확인해볼게요',
    '이어서 확인하겠습니다',
    '계속 진행할게요',
    '계속하겠습니다',
    '나머지도 살펴볼게요',
    '잠시만요, 확인 중이에요',
    '바로 `gh`로 확인할게요',
    // Bare-volitional KO acks (the production miss: "…먼저 볼게요" matched nothing
    // because only the "바로 볼게요" compound was listed).
    '확인해볼게요, 이미지랑 타입 기준 먼저 볼게요.',
    '먼저 볼게요',
    '한번 볼게요',
    '검토해볼게요',
    '찾아볼게요',
    '바로 처리할게요',
    // Casual (banmal) -ㄹ게 volitional — the same first-person promise WITHOUT the
    // polite -요. A persona that speaks informally ("확인해볼게!") hit nothing
    // because every KO entry was polite-form; the morpheme pass now covers both.
    // The first entry mirrors the production ack that ended a Discord turn in silence.
    '확인해볼게! GitHub 접근이랑 gh 인증 기준으로 둘 다 빠르게 봐볼게',
    '확인해볼게',
    '살펴볼게',
    '검토해볼게',
    '찾아볼게',
    '계속 진행할게',
    '바로 처리할게',
    '업데이트할게',
    '수정할게',
    // Action/config verb family (English) — "I'll DO X" promises beyond the
    // retrieval verbs. The cron-update production miss is the canonical case.
    "I'll update the cron timing logic.",
    'Let me set up the new cron job now.',
    "I'll fix it right away.",
    "I'll configure the job.",
    // Action/config verb family (Korean) — caught by the -겠습니다 morpheme regex
    // (any verb, not just check/look) and the -게요 action forms.
    '크론 타이밍 로직 반영해두겠습니다.',
    '바로 티켓 AC 업데이트하겠습니다 🙏',
    '설정 값 수정하겠습니다.',
    '업데이트할게요',
    // Open X하다 class reached by the -(으)ㄹ게 morpheme pass, not by any table entry.
    // Enumeration could never cover these: every new action verb a user invents
    // ("머지", "롤백", "재시작") composes with 하다 and inherits 할게 for free.
    '바로 배포할게요',
    '이 브랜치 롤백할게',
    '충돌만 정리하고 머지할게요',
    '컨테이너 재시작할게요.',
    '그 파일 삭제할게',
    // The remaining -겠 stems in their -(으)ㄹ게 form: 두 → 둘게, 놓 → 놓을게.
    '크론 타이밍 반영해둘게요',
    '설정 값 미리 맞춰놓을게',
    // Playful -용 politeness particle, and banmal mid-sentence continuation.
    '배포할게용',
    '배포할게 지금 바로',
    // 드리 humble auxiliary, the one -(으)ㄹ게 stem outside the -겠 set.
    '알려드릴게요',
    '나머지는 제가 정리해서 알려드릴게',
    // 안 that opens or closes an unrelated word must not read as negation. 안내/안전
    // start one, 방안/제안 end one; all four carry a genuine promise.
    '안내해드릴게요',
    '안전하게 배포할게요',
    '방안 확인할게요',
    '제안 확인할게요',
    // A negator binds only its own verb — the promise in the following clause stands.
    '배포는 안 하고 확인만 할게요',
  ]

  for (const text of willing) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(true)
    })
  }
})

describe('detectContinuationWillingness — positive (multilingual self-directed future intent)', () => {
  const willing: readonly string[] = [
    'Lo reviso enseguida, un momento.',
    'Voy a verificar el resto.',
    'Je vais vérifier les autres fichiers.',
    'Laisse-moi regarder ça.',
    'Vado a controllare subito.',
    'Vou conferir o restante.',
    'Ich werde das gleich prüfen.',
    'Lass mich nachsehen.',
    'Сейчас проверю остальное.',
    'Я посмотрю и продолжу.',
    '我来确认一下其余的。',
    '我马上检查日志。',
    '確認してみます、少々お待ちください。',
    '引き続き確認します。',
    'سأتحقق من الباقي.',
    'دعني أراجع ذلك.',
    'मैं अभी जाँच करूँगा।',
    'Hemen kontrol ediyorum.',
    'Devam edeceğim, bir saniye.',
    'Để tôi kiểm tra phần còn lại.',
    'Tôi sẽ xem ngay.',
    'Biar saya cek dulu.',
    'Saya akan periksa sisanya.',
    // Gap-closure cases surfaced by a cross-language audit — natural ack phrasings
    // the original tables missed (e.g. "let me take a quick look" idioms and the
    // present-tense "I'm looking at it now" forms each language uses).
    'Ahora lo reviso, dame un segundo.',
    'Voy a echar un vistazo.',
    'Je vais jeter un œil.',
    'Je regarde ça tout de suite.',
    'Je vais creuser un peu.',
    "Vado a dare un'occhiata.",
    'Vou dar uma olhada.',
    'Ich schaue mir das an.',
    'Ich prüfe das gleich.',
    'Дай мне проверить это.',
    '让我查一下。',
    'Bir bakayım.',
    // Action/config verb family across languages — the "I'll DO X" class that the
    // retrieval-only tables missed. Korean/Turkish/Hindi/Japanese hit the morpheme
    // pass; the rest hit the phrase pass.
    'Voy a actualizar la configuración.',
    'Je vais corriger ça.',
    'Ich werde aktualisieren.',
    'Сейчас обновлю конфигурацию.',
    '我来更新一下。',
    '設定を更新します。',
    '対応してみます。',
    'मैं इसे अपडेट करूँगा।',
    'Hemen güncelleyeceğim.',
    'Ayarı yapacağım.',
    'Tôi sẽ cập nhật ngay.',
    'Saya akan perbarui sekarang.',
  ]

  for (const text of willing) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(true)
    })
  }
})

describe('detectContinuationWillingness — positive (casual / informal register across languages)', () => {
  const willing: readonly string[] = [
    // English contractions/slang
    'lemme dig into the logs',
    'imma check the config',
    'gonna check the diff now',
    'ima look at the rest',
    'let me go check the tests',
    'gimme a sec',
    // Spanish casual (déjame ver/checar, ya lo + present, checar)
    'déjame ver los otros archivos',
    'déjame checar eso',
    'ya lo reviso y te digo',
    'ahora mismo reviso los logs',
    // French casual (check anglicism, laisse-moi voir, je m'en charge)
    'je check ça tout de suite',
    'laisse-moi voir le reste',
    "je m'en charge maintenant",
    // Italian casual (fammi vedere, vedo subito, ci guardo io)
    'fammi vedere il resto',
    'vedo subito i log',
    'ci guardo io adesso',
    // Portuguese casual (vou ver, deixa eu ver/checar, deixa comigo)
    'vou ver isso agora',
    'deixa eu ver os arquivos',
    'deixa comigo, já checo',
    // German casual (ich schau mal, ich guck nach, ich kümmere mich)
    'ich schau mal nach',
    'ich guck nach den logs',
    'ich kümmere mich darum',
    'das übernehm ich',
    // Russian colloquial (щас/гляну + perfective)
    'щас гляну логи',
    'сейчас гляну остальное',
    'дай гляну быстро',
    'щас разберусь с этим',
    // Chinese spoken (去/来 + verb)
    '我去看下日志',
    '我来处理这个',
    '我去核实一下',
    // Arabic colloquial (راح/رح/هـ future, خليني)
    'راح أشوف الباقي',
    'رح أتأكد من هالشي',
    'خليني أشوف الكود',
    // Hindi casual (अभी + habitual, completive ले)
    'अभी देखता हूँ',
    'मैं देख लेता हूँ',
    'जरा देखता हूँ बाकी फाइलें',
    // Turkish optative (-eyim/-ayım)
    'şuna bakayım',
    'bir göz atayım',
    'şimdi bakayım hemen',
    // Vietnamese casual/Southern (coi, thử)
    'để tôi coi thử',
    'coi thử cái này',
    'tôi coi thử phần còn lại',
    // Indonesian casual (coba/dulu/aja)
    'coba saya cek dulu',
    'saya liat dulu ya',
    'saya cek sekarang',
    // Japanese plain form (particle-anchored)
    '確認するね',
    '調べとくね、ちょっと待って',
    '見てみるね',
    'すぐ見るね',
  ]

  for (const text of willing) {
    test(`detects: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(true)
    })
  }
})

describe('detectContinuationWillingness — negative (final / descriptive / other-directed)', () => {
  const notWilling: readonly string[] = [
    'Done. The diff looks good, no issues.',
    'I checked and it is fine.',
    'You can continue with the merge.',
    'Looks good to me, approving.',
    'ok',
    'done',
    '네',
    '확인 결과 문제 없습니다.',
    '계속 진행하세요.',
    '이대로 진행하셔도 됩니다.',
    '리뷰 완료했습니다. 승인합니다.',
    // Idiomatic -겠습니다 that is NOT volitional work intent: 알겠습니다 = "understood"
    // (a pure ack), 모르겠습니다 = "I don't know". The morpheme regex excludes these.
    '알겠습니다, 감사합니다!',
    '잘 모르겠습니다.',
    // Adjective-stem conjecture/desiderative — 겠 sits on an adjective, not a verb
    // stem, so the verb-anchored regex must not read these as work promises.
    '좋겠어요.',
    '괜찮겠어요.',
    '오늘은 좀 힘들겠습니다.',
    // Bare adverb+noun fragments removed from the KO table — they fire on
    // other-directed requests and descriptive progressives, not self-intent.
    '바로 확인 부탁드려요.',
    '계속 확인 중입니다.',
    // Casual (banmal) idiomatic -겠어 acks — 알겠어 = "got it", 모르겠어 = "dunno".
    // The verb-anchored volitional regex must not read these casual forms as work
    // promises, exactly as it excludes their polite -겠어요/-겠습니다 siblings.
    '알겠어, 고마워!',
    '잘 모르겠어.',
    // Descriptive casual past — an already-done report, not a promise to act.
    '이미 확인했어, 문제 없어.',
    // -게 forms that are NOT the volitional ending. These are why the ㄹ게 pattern is
    // anchored to the 하/보/두/놓 stems instead of matching any ㄹ-batchim syllable:
    // the adverbial -게 sits on a bare adjective stem (힘들게/길게/멀게), 별게 is a noun
    // + 이, and -게 되다/만들다 is a change-of-state auxiliary. All are clause-medial,
    // so a sentence-final lookahead would NOT have excluded them — the space after 게
    // is one character wide and a lookahead cannot see past it.
    '힘들게 찾았지만 결국 됐어요.',
    '로그가 길게 나와서 잘라서 봤어요.',
    '그건 별게 아니에요.',
    '이제야 원인을 알게 되었습니다.',
    '멀게 느껴지실 수 있어요.',
    // 것이 contraction — 할 게 is two tokens ("things to do"), not the 할게 ending.
    '아직 할 게 많이 남았습니다.',
    // Genuine first-person -(으)ㄹ게 volitionals that promise the OPPOSITE of
    // continuation, or no work at all. They are excluded by the stem anchor: 마치/쉬/
    // 기다리 are not 하/보/두/놓.
    '그럼 여기서 마칠게요.',
    '답변 기다릴게요.',
    // Permission-seeking question — awaits the user rather than committing to act,
    // mirroring the Japanese 〜ますか guard.
    '그럼 제가 배포할게요?',
    // Reported speech — the promise belongs to someone else, not the agent.
    '리뷰어가 "배포할게요"라고 했습니다.',
    // Short negation 안/못 inverts the promise. These must stay false for enumerated
    // verbs too, which is why no -게 form remains in the phrase table: a table hit
    // returns before the negation strip and the guards ever run.
    '네, 배포 안 할게요',
    '그건 안 볼게요',
    '지금은 안 해볼게요',
    '안 업데이트할게요',
    '그 브랜치는 안할게',
    // Long negation -지 않을게요 — excluded structurally, 않을게 is not a stem.
    '배포하지 않을게요',
    // The negated -겠 sibling, same inversion.
    '배포 안 하겠습니다',
    // Question and quotative forms of verbs that used to sit in the phrase table and
    // therefore short-circuited both guards.
    '제가 처리할게요?',
    '리뷰어가 "확인할게요"라고 했습니다.',
    '알려드릴게요?',
    '',
    '...',
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})

describe('detectContinuationWillingness — negative (multilingual final / descriptive / other-directed)', () => {
  const notWilling: readonly string[] = [
    'Sí, todo bien. Puedes continuar.',
    'Ya lo revisé, está correcto.',
    "Oui, c'est bon. Tu peux continuer.",
    "J'ai vérifié, aucun problème.",
    'Va bene, ho controllato tutto.',
    'Está tudo certo, pode continuar.',
    'Alles gut, ich habe es geprüft.',
    'Да, всё хорошо, можешь продолжать.',
    '好的，我检查过了，没问题。',
    '你可以继续了。',
    'はい、確認しました。問題ありません。',
    'تم، تحققت من كل شيء.',
    'ठीक है, मैंने जाँच लिया।',
    'Tamam, kontrol ettim, sorun yok.',
    'Vâng, tôi đã kiểm tra rồi.',
    'Oke, sudah saya periksa, tidak ada masalah.',
    // Japanese idioms that end in します but are requests/greetings, not work
    // intent — stripped before the morpheme test so they do not fire.
    'お願いします。',
    'よろしくお願いいたします。',
    '失礼します。',
    'どうしますか？',
    'どうします？',
    '更新します？',
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})

describe('detectContinuationWillingness — negative (casual-register false-positive guards)', () => {
  // Ambiguous casual forms deliberately EXCLUDED when the casual tables were widened:
  // bare present that reads descriptive, other-directed imperatives, and short forms
  // that collide. Each asserts the widening did not overreach past the false-negative bias.
  const notWilling: readonly string[] = [
    // Bare present-as-descriptive (no temporal/volitional anchor) — omitted on purpose
    'je regarde les résultats maintenant',
    'guardo la TV',
    'saya cek email tiap pagi',
    // Present-continuous = "I'm doing it now", descriptive not future
    'şimdi bakıyorum ekrana',
    // Other-directed imperatives ("you look" / "let's see what happens")
    'baksana şuna',
    '你看看这个文件',
    'để coi sao đã',
    // Chinese 2-char descriptive that must not fire ("I see you're right" / receipt ack)
    '我看你说得对',
    '我查收了邮件',
    // Japanese bare dictionary form (no committing particle) stays out
    '確認する',
    // Arabic other-directed ("do YOU want to look?")
    'بدك أشوف هالشي',
  ]

  for (const text of notWilling) {
    test(`ignores: ${JSON.stringify(text)}`, () => {
      expect(detectContinuationWillingness(text)).toBe(false)
    })
  }
})
