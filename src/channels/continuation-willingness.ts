// A channel turn ends after a successful `channel_reply` (the terminal-reply
// abort in router.ts). When the model's reply PROMISES to keep working this
// turn ("바로 확인해볼게요", "let me check", "I'll continue now") but it forgot
// to set `channel_reply({ more_work_this_turn: true })`, the turn aborts and the promised
// follow-up never runs. The router uses this detector to inject ONE bounded
// reminder nudge so the model gets a second chance. See the empty-turn retry
// (router.ts) for the sibling mechanism this mirrors.
//
// Design bias: PREFER FALSE NEGATIVES. A miss leaves the status quo (turn ends,
// recoverable by a later user message); a false positive costs one wasted
// reminder-only turn that the model ends with NO_REPLY. So the phrase tables are
// deliberately narrow — only self-directed FUTURE intent to act THIS turn, never
// descriptive ("I checked and it's fine") or other-directed ("you can continue")
// usage. This is a HINT, not a control-flow authority: the abort still fires
// regardless; only the optional nudge is gated on it.
//
// Detection is two-pass: a phrase-substring pass (ALL_PHRASES) for analytic
// languages where future intent is a separate word ("I'll", "voy a", "我会"),
// plus a morpheme pass (MORPHEME_PATTERNS + the Japanese check) for languages
// where it is a verb inflection/affix. The morpheme pass matches the marker
// itself, so it generalizes across EVERY action verb (update/configure/fix/…)
// instead of enumerating each — what the per-verb KO/TR/HI/JA lists used to do
// by hand.

// Strip markdown emphasis/code fences before matching so an inline `gh` span
// inside "바로 `gh`로 확인할게요" does not split the phrase.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Self-directed future-intent phrases. Each asserts the SPEAKER will do more
// work imminently. The leading "i" / "let me" anchors self-direction so
// "you can continue" never matches.
const EN_PHRASES: readonly string[] = [
  "i'll continue",
  'i will continue',
  "i'll keep going",
  "i'll keep checking",
  "i'll keep looking",
  "i'll take a look",
  "i'll check",
  "i'll look into",
  "i'll dig in",
  "i'll go ahead and",
  'let me check',
  'let me look',
  'let me take a look',
  'let me dig',
  'let me continue',
  'let me verify',
  'checking now',
  'looking into it now',
  'working on it now',
  'on it now',
  "i'm on it",
  'give me a moment',
  'give me a sec',
  // Parity additions for common first-person-future acks: "investigate / look up
  // / pull up" are work-verb siblings of the "look into / dig in" entries above,
  // and "lemme" is the contracted "let me" that chat models routinely emit.
  "i'll investigate",
  "i'll look it up",
  "i'll pull that up",
  "i'll pull it up",
  'let me pull',
  'lemme check',
  'lemme look',
  'lemme take a look',
  // Action/config verb family. The retrieval verbs above ("check/look/look up")
  // miss the much larger class of "I'll DO X" promises — update/configure/set up/
  // schedule/fix/apply/create — which is exactly the class that silently truncates
  // when the model forgets `more_work_this_turn: true` (the cron-update production miss).
  "i'll update",
  "i'll set up",
  "i'll set it up",
  "i'll configure",
  "i'll schedule",
  "i'll fix",
  "i'll apply",
  "i'll add",
  "i'll create",
  "i'll handle",
  'let me update',
  'let me fix',
  'let me set up',
  'let me configure',
  'let me add',
  'let me create',
  'let me handle',
  // Casual/contracted acks chat models emit. "imma"/"ima"/"gonna" are the
  // spoken-future contractions; in an assistant reply "gonna VERB" is self-directed
  // (a rival "you're gonna" is other-directed and never a willingness signal here).
  'lemme dig',
  'imma check',
  'gonna check',
  'gonna look',
  'ima look',
  'let me go check',
  'let me peek',
  'gimme a sec',
]

// Korean: the -겠습니다/-겠어요 and -(으)ㄹ게(요) verb endings are first-person
// volitional — they cannot address the listener, so they are safe self-direction
// anchors. BOTH are matched by MORPHEME_PATTERNS below, stem-anchored to the same
// action/auxiliary stems, so they generalize across every verb built on them. No
// -게 form is enumerated here at all: an entry in this table would SHORT-CIRCUIT
// the morpheme pass, because the substring pass returns before it runs, and the
// negation / question / quotative guards that make the morpheme pass safe would
// never execute. A table entry 처리할게 is what made 제가 처리할게요? report
// willingness despite the question guard. Only the stall idioms — which have no
// verb to negate or question — remain.
//
// The stem anchor is what keeps this narrow. A broad `[ㄹ-final]게` regex was
// rejected: it fires on the adverbial -게 of adjective stems (힘들게 "hard-ly",
// 멀게 "far-ly", 길게 "long-ly"), on the noun 별게 ("별게 아니에요" = "it's nothing"),
// and on the -게 되다/만들다 construction (알게 되었습니다 = "I came to know") — none
// of which promise work. Requiring the -게 be sentence-final does NOT rescue it,
// because every one of those confusables is followed by a SPACE, so a lookahead
// cannot see past it. Worse, an open-class rule also admits genuine volitionals
// that mean the OPPOSITE of continuation (여기서 마칠게요 "I'll stop here", 이제
// 쉴게요 "I'll rest now"), violating the file's prefer-false-negatives bias.
//
// Bare adverb+noun fragments ("바로 확인", "계속 확인") are still excluded: without
// the -게 volitional they match other-directed requests
// ("바로 확인 부탁드려요" = "please check") and descriptive progressives ("계속 확인
// 중입니다" = "I'm still checking"). The persona speaking banmal ("확인해볼게!") was
// the production miss that closed a Discord turn in silence.
const KO_PHRASES: readonly string[] = ['잠시만요', '잠깐만요']

// The remaining languages mirror the precision-first selection above: every
// entry pairs a FIRST-PERSON future/volitional anchor with a work verb
// (check/look/continue/proceed/verify or update/configure/fix/create) or is an
// immediate-work idiom ("on it now"). The same false-negative bias holds — bare
// verbs, bare acknowledgments ("ok", "sí", "好"), second-person imperatives ("you
// continue"), and descriptive past forms ("I checked") are deliberately excluded
// because a substring match on those would mis-fire. Latin/Cyrillic/Arabic/Indic
// entries are inflected first-person-future forms (or multi-word) so they cannot
// collide with a bare common word; CJK entries are full 4+ character intent
// phrases, never a lone noun.

// Spanish: "voy a" / "déjame" + work verb; "enseguida" (right away) idioms.
const ES_PHRASES: readonly string[] = [
  'voy a revisar',
  'voy a comprobar',
  'voy a verificar',
  'voy a mirar',
  'voy a continuar',
  'voy a seguir',
  'déjame revisar',
  'déjame comprobar',
  'déjame verificar',
  'déjame mirar',
  'voy a echar un vistazo',
  'déjame echar un vistazo',
  'ahora lo reviso',
  'ahora reviso',
  'ahora lo verifico',
  'ahora mismo lo reviso',
  'lo reviso enseguida',
  'lo verifico enseguida',
  'enseguida lo reviso',
  'enseguida reviso',
  'un momento',
  'dame un momento',
  'dame un segundo',
  // Action/config verb family.
  'voy a actualizar',
  'voy a configurar',
  'voy a corregir',
  'voy a arreglar',
  'voy a crear',
  'voy a añadir',
  'voy a programar',
  'voy a aplicar',
  'déjame actualizar',
  'déjame corregir',
  // Casual register: "déjame ver/checar" (the colloquial twins of the déjame-forms
  // above), and "ya lo"/"ahora mismo" + bare present, whose temporal anchor pins the
  // present-as-future so it can't read as the descriptive "reviso [cada mañana]".
  // "checar" is the LatAm colloquial for "revisar".
  'déjame ver',
  'déjame checar',
  'ya lo reviso',
  'lo reviso ya',
  'ya lo checo',
  'lo checo ya',
  'me pongo a revisar',
  'ahora mismo reviso',
  'voy a darle un vistazo',
  'reviso y te digo',
  'lo checo enseguida',
]

// French: "je vais" + work verb; "laisse-moi" idioms.
const FR_PHRASES: readonly string[] = [
  'je vais vérifier',
  'je vais regarder',
  'je vais continuer',
  'je vais poursuivre',
  'je vais voir',
  'je vais contrôler',
  'je vais creuser',
  'je vais jeter un œil',
  'laisse-moi vérifier',
  'laisse-moi regarder',
  'laisse-moi jeter un œil',
  'je vérifie tout de suite',
  'je regarde tout de suite',
  'je regarde ça tout de suite',
  'je regarde ça',
  'un instant',
  'donne-moi un instant',
  'donne-moi une seconde',
  // Action/config verb family.
  'je vais mettre à jour',
  'je vais configurer',
  'je vais corriger',
  'je vais créer',
  'je vais ajouter',
  'je vais programmer',
  'je vais appliquer',
  'laisse-moi corriger',
  'laisse-moi mettre à jour',
  // Casual: the "check" anglicism (not a native French word, so zero descriptive
  // ambiguity), "laisse-moi voir" (colloquial twin of laisse-moi vérifier),
  // present+"rapidement" (the adverb forces future intent), and "je m'en charge"
  // ("I'll take charge of it"). Bare "je regarde"/"je vérifie" are deliberately
  // omitted — present tense alone reads as descriptive "I'm looking [right now]".
  'je check ça',
  'laisse-moi voir',
  'je vais checker',
  'je regarde rapidement',
  'je vérifie rapidement',
  "je m'en charge",
]

// Italian: "vado a" / "fammi" + work verb; "controllo subito" idioms.
const IT_PHRASES: readonly string[] = [
  'vado a controllare',
  'vado a verificare',
  'vado a guardare',
  "vado a dare un'occhiata",
  'fammi controllare',
  'fammi verificare',
  'fammi guardare',
  "fammi dare un'occhiata",
  "do un'occhiata",
  'controllo subito',
  'verifico subito',
  'continuo subito',
  'guardo subito',
  'un momento',
  'dammi un momento',
  'dammi un secondo',
  // Action/config verb family.
  'vado ad aggiornare',
  'vado a configurare',
  'vado a correggere',
  'vado a creare',
  'vado ad aggiungere',
  'vado ad applicare',
  'fammi aggiornare',
  'fammi correggere',
  // Casual: "fammi vedere" (colloquial twin of fammi controllare), present+"subito"/
  // "adesso" (temporal anchor forces future), "vado a vedere", and "ci guardo io"
  // (the "io" makes it emphatically self-directed). Bare "controllo"/"guardo" are
  // omitted — present alone reads descriptive ("guardo la TV" = I'm watching TV).
  'fammi vedere',
  'vedo subito',
  'vado a vedere',
  'ci guardo io',
  'controllo adesso',
  'verifico adesso',
]

// Portuguese: "vou" + work verb; "deixa eu" idioms.
const PT_PHRASES: readonly string[] = [
  'vou verificar',
  'vou checar',
  'vou conferir',
  'vou olhar',
  'vou continuar',
  'vou prosseguir',
  'vou dar uma olhada',
  'deixa eu verificar',
  'deixa eu conferir',
  'deixa eu olhar',
  'deixa eu dar uma olhada',
  'verifico já',
  'já verifico',
  'um momento',
  'me dê um momento',
  'me dá um segundo',
  // Action/config verb family.
  'vou atualizar',
  'vou configurar',
  'vou corrigir',
  'vou criar',
  'vou adicionar',
  'vou agendar',
  'vou aplicar',
  'deixa eu atualizar',
  'deixa eu corrigir',
  // Casual (BR-leaning): "vou ver" (the most common informal ack), "deixa eu ver/
  // checar" and "deixa que eu vejo" (colloquial "let me"), "deixa comigo" ("leave it
  // to me"), and "já vou ver"/"já dou uma olhada"/"...agora" (the já/agora temporal
  // anchor forces future). "checar" is the BR colloquial for "verificar".
  'vou ver',
  'deixa eu ver',
  'deixa eu checar',
  'deixa comigo',
  'já vou ver',
  'verifico agora',
  'deixa que eu vejo',
  'já dou uma olhada',
]

// German: "ich werde" / "lass mich" + work verb; "ich schaue gleich" idioms.
const DE_PHRASES: readonly string[] = [
  'ich werde prüfen',
  'ich werde überprüfen',
  'ich werde nachsehen',
  'ich werde weitermachen',
  'ich werde fortfahren',
  'lass mich prüfen',
  'lass mich nachsehen',
  'lass mich schauen',
  'ich schaue gleich',
  'ich schaue mir das an',
  'ich schaue mir das mal an',
  'ich prüfe gleich',
  'ich prüfe das gleich',
  'ich sehe gleich nach',
  'gleich prüfen',
  'gleich überprüfen',
  'gleich nachsehen',
  'einen moment',
  'einen augenblick',
  'gib mir eine sekunde',
  // Action/config verb family.
  'ich werde aktualisieren',
  'ich werde konfigurieren',
  'ich werde korrigieren',
  'ich werde einrichten',
  'ich werde erstellen',
  'ich werde hinzufügen',
  'ich werde anwenden',
  'lass mich aktualisieren',
  'lass mich korrigieren',
  // Casual: present-as-future with the "mal"/"kurz"/"nach" particles ("ich schau
  // mal", "ich guck nach"), the V2-inverted "schau ich mir" (word order flags 1sg),
  // the Germanized "ich check das", and the take-responsibility forms ("ich kümmere
  // mich", "das übernehm ich", "ich nehm das"). Bare "ich schau" is omitted — it also
  // fits "ich schau dir zu" (I'm watching you), which is not a work promise.
  'ich schau mal',
  'ich guck mal',
  'ich schau nach',
  'ich guck nach',
  'schau ich mir',
  'ich kümmere mich',
  'ich check das',
  'das übernehm ich',
  'ich nehm das',
  'ich geh das checken',
  'ich schau kurz',
]

// Russian: first-person-future verbs (проверю/посмотрю/продолжу) — the -ю/-у
// inflection is unambiguously "I will", so it is a safe self-anchor. (Note: the
// bare -ю ending is shared with present-imperfective "я делаю" = "I do", so this
// stays an enumerated list rather than a morpheme regex.)
const RU_PHRASES: readonly string[] = [
  'сейчас проверю',
  'я проверю',
  'я посмотрю',
  'я продолжу',
  'продолжу проверку',
  'сейчас посмотрю',
  'дай мне проверить',
  'дайте мне проверить',
  'дайте мне минуту',
  'одну секунду',
  'минутку',
  // Action/config verb family (perfective first-person futures).
  'я обновлю',
  'я настрою',
  'я исправлю',
  'я создам',
  'я добавлю',
  'я применю',
  'сейчас обновлю',
  'сейчас исправлю',
  // Colloquial: "щас" is the ubiquitous informal spelling of "сейчас"; "гляну" is
  // bare 1sg perfective of глянуть — morphologically locked to "I will" (2sg is
  // глянешь, 3sg глянет), so it's self-directed even without a pronoun. All entries
  // pair a 1sg-perfective verb (гляну/посмотрю/проверю/разберусь/сделаю/поправлю)
  // with щас/сейчас/дай, none of which can read as descriptive or other-directed.
  'гляну',
  'щас гляну',
  'сейчас гляну',
  'щас посмотрю',
  'щас проверю',
  'дай гляну',
  'дай посмотреть',
  'сейчас разберусь',
  'щас разберусь',
  'сейчас сделаю',
  'щас сделаю',
  'сейчас поправлю',
  'щас поправлю',
]

// Chinese: 我会/我来/我再 + work verb. Full multi-character intent phrases only;
// no bare nouns. 继续 alone is excluded (could be "you continue").
const ZH_PHRASES: readonly string[] = [
  '我来确认',
  '我来检查',
  '我来看看',
  '我会确认',
  '我会检查',
  '我会继续',
  '我再确认',
  '我再检查',
  '我继续确认',
  '我马上确认',
  '我马上检查',
  '我马上看',
  '让我看看',
  '让我查一下',
  '让我确认一下',
  '让我检查一下',
  '稍等一下',
  '我看一下',
  // Action/config verb family.
  '我来更新',
  '我会更新',
  '我来配置',
  '我来设置',
  '我会设置',
  '我来修改',
  '我会修改',
  '我来修复',
  '我来创建',
  '我来添加',
  '我马上更新',
  '让我更新',
  '让我改一下',
  // Casual/spoken: 去+verb (我去看下/我去核实) and 来+verb (我来处理/我来瞧瞧) mark quick
  // self-initiated action. Entries are ≥4 chars ending in a volitional suffix. The
  // 2-char 我看/我查 are omitted (descriptive 我看你说的对 = "I see you're right"), and
  // the 3-char reduplications 我看看/我查查 are omitted too: they fall under MIN_LENGTH
  // as standalone acks, and embedded they risk the past-narrative 我看看了 ("I glanced").
  '我去看下',
  '我来处理',
  '我搜一下',
  '我确认下',
  '我去核实',
  '我来瞧瞧',
]

// Japanese: handled by the JA_VOLITIONAL morpheme check below (-します/-いたします/
// -してみます generalizes across all する action verbs). Only the regular-verb
// ます forms (調べます/見てみます/続けます — bare ます is too broad to regex) and
// stall idioms are enumerated here.
const JA_PHRASES: readonly string[] = [
  '調べてみます',
  '調べます',
  '見てみます',
  '続けます',
  '少々お待ちください',
  'ちょっと待ってください',
  // Casual plain form (タメ口), particle-anchored. Bare dictionary forms (見る/確認する)
  // are the SAME as descriptive present and far too ambiguous, so each entry pins a
  // work verb to a self-commitment sentence-final particle: 〜ね (volitional), 〜わ
  // (soft assertion), or the 〜とく/〜てくる/〜てみる auxiliaries that already imply
  // "I'll take care of / go do / try". 〜よ is excluded (it can be merely informational).
  '確認するね',
  '調べるね',
  '見てみるね',
  '確認しとくね',
  '調べとくね',
  'チェックしとくね',
  '見とくね',
  '見てみるわ',
  '調べてみるね',
  '確認してみるね',
  '見てくるね',
  '調べてくるね',
  'すぐ見るね',
]

// Arabic: future particle سـ prefixed first-person verb (سأتحقق = "I will
// verify"). The سأ prefix is first-person-future, but as a bare substring it
// collides with the root س-أ-ل ("ask": سألت "I asked", المسألة "the matter"), so
// this stays an enumerated list of full verbs rather than a سأ-prefix regex.
const AR_PHRASES: readonly string[] = [
  'سأتحقق',
  'سأتأكد',
  'سأراجع',
  'سأطلع',
  'سأكمل',
  'سأواصل',
  'دعني أتحقق',
  'دعني أراجع',
  'لحظة من فضلك',
  // Action/config verb family.
  'سأحدث',
  'سأحدّث',
  'سأعدل',
  'سأعدّل',
  'سأضبط',
  'سأصلح',
  'سأنشئ',
  'سأضيف',
  // Colloquial dialects: explicit future markers راح/رح (Gulf/Levantine) and هـ
  // (Egyptian) + verb, plus خليني ("let me") and بدي ("I want to", Levantine
  // volitional). Bare بشوف is omitted — بـ+imperfect is present-habitual in some
  // dialects, so it can read descriptive. شيك only appears prefixed (هاشيك/راح أشيك)
  // so it can't collide with the noun شيك ("cheque").
  'راح أشوف',
  'رح أشوف',
  'هشوف',
  'هأشوف',
  'خليني أشوف',
  'رح أتأكد',
  'هاشيك',
  'راح أشيك',
  'رح أتحقق',
  'بدي أشوف',
  'هجيب المعلومة',
  'راح أراجع',
]

// Hindi: first-person-future is the -ūṅgā/-ūṅgī suffix, matched by
// MORPHEME_PATTERNS below (it covers all X-करना compounds). Only the stall idiom
// is enumerated here.
// Casual Hindi uses the habitual present (देखता हूँ) for immediate intent, but only
// with an immediacy anchor (अभी "now", जरा "just") or the completive ले, which mark
// volition; bare देखता हूँ / करता हूँ are omitted (descriptive "I'm looking / I do").
// Both genders (-ता/-ती) are listed since the ending marks speaker gender. The formal
// -ऊँगा future is already covered by MORPHEME_PATTERNS. एक मिनट रुकिए is the stall idiom.
const HI_PHRASES: readonly string[] = [
  'एक मिनट रुकिए',
  'अभी देखता हूँ',
  'देख लेता हूँ',
  'मैं देख लेता हूँ',
  'अभी चेक करता हूँ',
  'चेक कर लेता हूँ',
  'अभी देख लेता हूँ',
  'जरा देखता हूँ',
  'देख लेती हूँ',
  'चेक कर लेती हूँ',
]

// Turkish: first-person-future "-eceğim/-acağım" is matched by MORPHEME_PATTERNS
// below. The present-progressive ("ediyorum" = "I'm checking now"), optative
// ("bir bakayım" = "let me look"), and stall idioms stay enumerated — the
// progressive -ıyorum ending is too polysemous to regex ("biliyorum" = "I know").
const TR_PHRASES: readonly string[] = [
  'kontrol ediyorum',
  'bir bakayım',
  'bir kontrol edeyim',
  'kontrol edeyim',
  'hemen kontrol ediyorum',
  'hemen bakıyorum',
  'bir saniye',
  'bir dakika',
  // Casual: the -eyim/-ayım optative ("let me VERB") is the safest volition anchor
  // (bakayım/edeyim/atayım/inceleyeyim); the -ır/-ar aorist (bakarım) is only added
  // with hemen/şimdi to force future over habitual. -yor present-continuous
  // (bakıyorum) is NOT extended — it's descriptive "I'm looking [now]". baksana is
  // excluded (imperative "look!", other-directed).
  'şuna bakayım',
  'bir inceleyeyim',
  'bir göz atayım',
  'şimdi bakayım',
  'hemen bakarım',
]

// Vietnamese: "tôi sẽ" / "để tôi" (I will / let me) + work verb.
const VI_PHRASES: readonly string[] = [
  'tôi sẽ kiểm tra',
  'tôi sẽ xem',
  'tôi sẽ tiếp tục',
  'để tôi kiểm tra',
  'để tôi xem',
  'tôi kiểm tra ngay',
  'tôi xem ngay',
  'chờ một chút',
  'đợi một chút',
  // Action/config verb family.
  'tôi sẽ cập nhật',
  'tôi sẽ cấu hình',
  'tôi sẽ sửa',
  'tôi sẽ tạo',
  'tôi sẽ thêm',
  'để tôi cập nhật',
  'để tôi sửa',
  // Casual/Southern: "coi" is the Southern colloquial for "xem" (look); "thử" (try)
  // is a strong volition marker, so coi/xem/kiểm tra + thử are safe. Bare "để coi" is
  // omitted — it can mean "let's see [what happens]" (观望), not a work promise.
  'coi thử',
  'để tôi coi',
  'xem thử',
  'tôi coi thử',
  'kiểm tra thử',
  'coi một lúc',
  'để tôi coi thử',
]

// Indonesian: "saya akan" / "biar saya" (I will / let me) + work verb.
const ID_PHRASES: readonly string[] = [
  'saya akan periksa',
  'saya akan cek',
  'saya akan lihat',
  'saya akan lanjutkan',
  'biar saya periksa',
  'biar saya cek',
  'saya cek dulu',
  'saya periksa dulu',
  'tunggu sebentar',
  'sebentar ya',
  // Action/config verb family.
  'saya akan perbarui',
  'saya akan memperbarui',
  'saya akan atur',
  'saya akan konfigurasi',
  'saya akan perbaiki',
  'saya akan buat',
  'saya akan tambah',
  'biar saya perbaiki',
  'biar saya perbarui',
  // Casual/spoken: "coba" (let/try) leads a volitional; "dulu"/"aja"/"sekarang" anchor
  // the bare present as imminent ("saya cek dulu" = "I'll check first"). "liat" is the
  // casual "lihat". Bare "saya cek"/"saya liat" are omitted (present/past ambiguous),
  // and the Javanese "tak" prefix is excluded (3-char substring collides with takut
  // "afraid", menata "arrange").
  'coba saya cek',
  'saya cek dulu',
  'liat dulu',
  'saya liat dulu',
  'coba saya liat',
  'saya cek aja',
  'liat dulu ya',
  'saya cek sekarang',
  'saya bantu cek',
  'saya usahakan cek',
  'liat sebentar',
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

// First-person future/volitional realized as a verb inflection or affix (not a
// separate word), so matching the marker generalizes across ALL action verbs.
const MORPHEME_PATTERNS: readonly RegExp[] = [
  // Korean first-person volitional: a verb stem + -겠습니다/-겠어요. The stem must
  // be one of the action/auxiliary verbs 하 (the 하다 light verb behind every
  // X하다 — 업데이트하겠습니다/반영하겠어요), 보 (살펴보겠습니다), 두 (반영해두겠습니다), or
  // 놓 (해놓겠습니다). Anchoring on the verb stem is what keeps this self-directed:
  // bare 겠 also matches adjective-stem CONJECTURE (좋겠어요 "that'd be nice",
  // 괜찮겠어요 "must be fine") and the idioms 알겠/모르겠, none of which promise work.
  // Listener-directed conjecture takes the honorific 시 (피곤하시겠어요 → 시겠, not
  // 하겠), so it is excluded too.
  /(?:하|보|두|놓)겠(?:습니다|어요)/,
  // Korean first-person volitional -(으)ㄹ게(요): the same stems as -겠 above plus the
  // humble auxiliary 드리 (알려드릴게요), carrying the ㄹ that marks the ending
  // (하 → 할게, 보 → 볼게, 두 → 둘게, 놓 → 놓을게, 드리 → 드릴게; consonant-final 놓 takes
  // the -을게 allomorph). This is what generalizes across the
  // open X하다 class the tables cannot enumerate — 배포할게요/롤백할게요/머지할게요 all
  // reduce to 할게. The ㄹ is load-bearing for precision, not just morphology: the
  // adverbial -게 attaches to a BARE stem (착하게 "kindly", never 착할게), so 할게/볼게
  // have no adjective reading at all, and the 여기서 마칠게요 ("I'll stop here") class of
  // non-work volitionals never reaches these stems. The (?![?？]) lookahead drops the
  // permission-seeking question form (제가 처리할게요? "shall I handle it?"), mirroring
  // the Japanese question guard below; a question awaits the user rather than
  // committing to act. The quotative lookahead drops reported speech
  // ("확인할게요"라고 했습니다 = "they said they'd check"), where the promise is someone
  // else's — an optional closing quote may sit between the ending and 라고.
  // The (?![요여용]) is load-bearing: without it the optional particle group
  // backtracks to empty and the guards below inspect the 요 instead of what follows
  // it, so 배포할게요? would slip through. Forcing the particle to be consumed when
  // present is JS's substitute for a possessive quantifier.
  /(?:할|볼|둘|놓을|드릴)게(?:요|여|용)?(?![요여용])(?![?？])(?!["'”』]?\s*라(?:고|며|는|던))/,
  // Turkish first-person-singular future "-acağım/-eceğim" ("I will VERB").
  // Vowel harmony yields exactly these two suffixes; the y-buffer
  // ("bekleyeceğim") leaves the suffix intact.
  /acağım|eceğim/,
  // Hindi first-person future "-ūṅgā/-ūṅgī" on any verb, covering all X-करना
  // compounds ("अपडेट करूँगा"). Both nasal spellings (ँ U+0901 / ं U+0902) and
  // both genders (ा/ी) are included.
  /ू[ँं]ग[ाी]/,
]

// Japanese する-verb volitional します/いたします/してみます — covers the action class
// (更新します/設定します/対応します). Bare ます is the universal polite verb ending and
// far too broad to match, so this keys on します specifically. Two request/greeting
// idioms end in します without being work intent — お願い(いた)します ("please") and
// 失礼します ("excuse me") — and are stripped before the test so they don't fire.
// The (?![か？?]) lookahead drops question forms — both the か question particle
// (どうしますか "what should I do?") and a trailing question mark, fullwidth ？ or
// ASCII ? (どうします？, 更新します？ "shall I update?"). A question awaits the user;
// it is not a commitment to act this turn. A statement keeps its 。/, so
// 更新します。 still matches.
const JA_VOLITIONAL_IDIOMS = /お願い(?:いた)?します|失礼します/g
const JA_VOLITIONAL = /します(?![か？?])|してみます(?![か？?])/

// Korean short negation 안/못 inverts the promise: 배포 안 할게요 is a commitment NOT
// to deploy. Both Korean morpheme families are affected (안 할게요 and 안 하겠습니다),
// so negated spans are stripped before the morpheme pass rather than guarded inside
// each pattern — the same strip-then-test shape JA_VOLITIONAL_IDIOMS uses above.
//
// The negator must be its OWN token. Two lookbehind/shape constraints enforce that,
// and both are load-bearing in opposite directions: (?<![가-힣]) rejects a 안 that ends
// a word (방안/제안 확인할게요 = "I'll check the plan/proposal"), while requiring a space
// before the {0,6} verb window rejects a 안 that merely STARTS one (안내해드릴게요 =
// "I'll guide you", 안전하게 배포할게요 = "I'll deploy safely"). Without the space the
// window swallows 내해 and suppresses a real promise. The no-space branch stays for the
// attached spelling 안할게요.
//
// The {0,6} window spans the verb the negator scopes over, which may be several
// syllables (안 업데이트할게요), but cannot cross a space, so a negator in an earlier
// clause never reaches a later promise (배포는 안 하고 확인만 할게요 stays willing).
// Long negation -지 않을게요 needs no entry: 않을게 is not one of the stems.
const KO_NEGATED_VOLITIONAL = /(?<![가-힣])(?:안|못)(?:\s+[가-힣]{0,6})?(?:(?:할|볼|둘|놓을|드릴)게|(?:하|보|두|놓)겠)/g

// Reply texts shorter than this are almost always a complete final answer
// ("네", "ok", "done") where a partial match would be noise. The shortest
// legitimate intent phrases ("on it now", "확인할게요") clear this floor.
const MIN_LENGTH = 4

export function detectContinuationWillingness(text: string): boolean {
  if (text.length < MIN_LENGTH) return false
  const normalized = normalize(text)
  if (normalized.length < MIN_LENGTH) return false
  if (ALL_PHRASES.some((phrase) => normalized.includes(phrase))) return true
  const affirmed = normalized.replace(KO_NEGATED_VOLITIONAL, ' ')
  if (MORPHEME_PATTERNS.some((pattern) => pattern.test(affirmed))) return true
  return JA_VOLITIONAL.test(affirmed.replace(JA_VOLITIONAL_IDIOMS, ''))
}
