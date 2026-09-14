// options.js — 住民の「行動の単位」(Option) の一覧。
//
// ── なぜ要るか ──
// これまで住民の1日は needOf() の if-else 梯子ひとつで決まっていた。
//
//     sick > SICK_HI          → 病院
//     夜 or 限界まで疲れた    → 帰って寝る
//     疲れた                  → ひと休み
//     腹が減った              → 飲食店
//     平日9-17時              → 職場
//     日用品が切れた          → 買い物
//     退屈                    → 娯楽施設
//
// 閾値は全員共通の定数なので、**冒険好きも食いしん坊もこの梯子を同じ順で降りる**。
// 性格が効くのは「どの店を選ぶか」(好みの重み) だけで、「どういう1日を送るか」には
// 一切効いていなかった。
//
// ここでは行動を **Option という単位のデータ**にする。1日の流れは
// 「Option を選ぶ → 実行する → 終わったらまた選ぶ」の繰り返しになり、
// 選び方 (hlp.js) と実行 (llp.js / server.js の追従) が分かれる。
//
// ── 固定サイズの行動enumにしない理由 ──
// 「起業して店を建てる」「誰かの財布を盗む」「屋台でたこ焼きを買う」— 行動は
// これからも増える。行動集合を固定サイズの softmax ヘッドにすると、**行動を1つ
// 足すたびに方策の再学習が要る**。だから選択は
//
//     score(o) = tier(o) + f(state) · g(embed(o))
//
// の形にしてある。`embed` は行動の自然言語記述の埋め込み (Phase B で入れる) で、
// 学習時に存在しなかった行動でもスコアが付く。いまは f·g を 0 にしてあるので
// tier だけが効き、**既存の needOf() と完全に同じ順序**になる (tools/hlp-equiv.js で検証)。
//
// ── server.js に依存しない ──
// world.js / pastime.js と同じ。判定に要るものは全部 ctx で渡してもらう。
// three も headless-gl も要らないので、単体で総当たり検証できる。

'use strict';

// ── 効用の段 (tier) ─────────────────────────────────────────────────────────
// needOf() の優先順位をそのまま数値にしたもの。段の間隔 (50) は、性格ボーナスの
// 上限 (PERSONA_MAX) より必ず大きくしておくこと。**そうしないと性格が
// 「腹が減っているのに寝る」のような生命に関わる逆転を起こす。**
const TIER = {
  survival: 600,   // 病気
  sleep:    500,   // 睡眠 (夜 / 限界の疲労)
  rest:     400,   // 日中のひと休み
  eat:      300,   // 空腹
  duty:     200,   // 勤務 / 通学
  errand:   100,   // 買い物
  leisure:   50,   // 退屈しのぎ
  idle:       0,   // 用事なし
};
// 性格ボーナスの絶対値の上限。TIER の段差 (50) の半分未満に保つ。
const PERSONA_MAX = 20;

// ── targetSpec ──────────────────────────────────────────────────────────────
// **座標ではなく「何を探すか」**を返す。座標を返した時点で、LLP 側の
// 「視覚で目的地かどうかを確かめる」という仕事が儀式になってしまう。
// 解決は llp.js の resolver が行い、既定の map 版は今までと同じ抽選をする。
//
//   {kind:'home'}                     自宅 (無ければ最寄りの住居)
//   {kind:'workplace'}                職場 or 学校
//   {kind:'restSpot'}                 休める場所 (飲食/娯楽/屋根なし) の最寄り
//   {kind:'cat', cat, pref, topK}     カテゴリから好みで上位 topK のランダム
//   {kind:'random'}                   従来のランダム建物
//   {kind:'stay'}                     動かない (その場で完結する Option)
const spec = (kind, o) => Object.assign({ kind }, o);

// ── Option の定義 ───────────────────────────────────────────────────────────
// id      … 一意。セーブデータのキーになるので**一度決めたら変えない**。
// need    … 既存 needOf() が返していた名前。UI・カメラ・配達判定など 25 箇所が
//           これを見ているので、互換の要として必ず持たせる。null = 用事なし。
// tier    … 上の TIER。
// precond … この Option を候補に上げてよいか。**needOf() の各行と 1:1 に対応する。**
// target  … targetSpec。
// stay    … 屋内に居るとき、そこに留まるか (shouldLeaveBuilding の裏返し)。
//           typeIdx = いま居る建物のタイプ (null なら建物でない)。
// persona … 性格ボーナス [-PERSONA_MAX, PERSONA_MAX]。HLP_PERSONA=1 でだけ効く。
//           既定は 0 = 既存挙動と完全一致。
// text    … Phase B で埋め込みを作るための自然言語記述。いまは使わない。
const ACTS = [];

/**
 * Option を登録する。**後から足せることが設計の目的**なので、
 * 起業・犯罪・娯楽・まだ無い行動は、ここを呼ぶだけで増やせる。
 * hlp.js は一覧を舐めるだけで、個々の Option を知らない。
 */
function register(opt) {
  if (!opt || !opt.id) throw new Error('option には id が要る');
  if (byId[opt.id]) throw new Error(`option id の重複: ${opt.id}`);
  const o = Object.assign({
    need: null,
    tier: TIER.idle,
    precond: () => true,
    target: () => spec('random'),
    stay: () => false,
    persona: () => 0,
    text: '',
  }, opt);
  ACTS.push(o);
  byId[o.id] = o;
  return o;
}

const byId = {};

// ═══ 既存の needOf() をそのまま Option にしたもの ═══════════════════════════
// **この 8 個の precond は needOf() の各行の逐語訳**。書き換えるときは
// tools/hlp-equiv.js を必ず通すこと (総当たりで一致を確かめる)。

// 病気 — 優先順位の最上位。
register({
  id: 'seek-care', need: 'sick', tier: TIER.survival,
  ja: '病院へ行く', en: 'seek care', icon: '🏥',
  text: 'go to a hospital or pharmacy because of illness',
  precond: (a, C) => (a.sick || 0) > C.thr.sickHi,
  // 病気のときは好みより近さを優先する (元コードの PREF_WEIGHT*0.3 / topK=2)。
  target: (a, C) => spec('cat', { cat: C.IDX.care, pref: C.prefWeight * 0.3, topK: 2 }),
  stay: (a, C, t) => t != null && C.IDX.care.includes(t),
});

// 睡眠 — 夜 / 限界の疲労。REST が無効なら日中の疲労もここに落ちる。
register({
  id: 'sleep', need: 'sleep', tier: TIER.sleep,
  ja: '帰って寝る', en: 'go home and sleep', icon: '😴',
  text: 'go home to sleep for the night',
  precond: (a, C) => {
    const fa = a.fatigue || 0;
    if (C.hour < 6 || C.hour >= 22 || fa > C.thr.sleepHi) return true;
    // REST が切られているときだけ、日中の疲労もここが受け持つ (元 needOf の三項)。
    return !C.restOn && fa > C.thr.needHi;
  },
  target: () => spec('home'),
  // 家がある人は自宅でだけ留まる。家なしは住居なら留まる (元 shouldLeaveBuilding)。
  stay: (a, C, t) => a.home
    ? (C.indoorsAt(a, a.home[0], a.home[1]))
    : (t != null && C.IDX.home.includes(t)),
});

// 日中のひと休み — 家まで帰らず近場で済ませる。
register({
  id: 'rest', need: 'rest', tier: TIER.rest,
  ja: 'ひと休みする', en: 'take a break', icon: '☕',
  text: 'take a short break at a cafe, a fun spot or an open place',
  precond: (a, C) => C.restOn && (a.fatigue || 0) > C.thr.needHi,
  target: () => spec('restSpot'),
  // 元コードの shouldLeaveBuilding には 'rest' の行が無く、最後の `return true` に
  // 落ちていた = 屋内には留まらない。**その挙動をそのまま写す。**
  stay: () => false,
});

// 空腹。
register({
  id: 'eat', need: 'eat', tier: TIER.eat,
  ja: '食事に行く', en: 'go eat', icon: '🍜',
  text: 'go to a restaurant to eat a meal',
  precond: (a, C) => (a.hunger || 0) > C.thr.needHi,
  target: (a, C) => spec('cat', { cat: C.IDX.food, pref: C.prefWeight, topK: 3 }),
  stay: (a, C, t) => t != null && C.IDX.food.includes(t),
});

// 勤務 / 通学。**学生は平日の校時だけ**。学生は一般の 9-17 時の行を通らない
// (元 needOf は isStudent で早期 return していた)。
register({
  id: 'work', need: 'work', tier: TIER.duty,
  ja: '仕事・学校へ行く', en: 'go to work or school', icon: '💼',
  text: 'go to the workplace or school for the day',
  precond: (a, C) => C.isStudent(a)
    ? (!C.weekend && C.hour >= C.school.from && C.hour < C.school.to)
    : (!C.weekend && C.hour >= C.work.from && C.hour < C.work.to),
  target: () => spec('workplace'),
  stay: (a, C) => {
    // 配達員は「街の中」が職場。倉庫に留めると荷物が一つも届かない。
    if (C.isCourier(a) && C.onDeliveryDuty(a)) return false;
    const w = a.school || a.work;
    return !!(w && C.indoorsAt(a, w[0], w[1]));
  },
});

// 買い物。
register({
  id: 'shop', need: 'shop', tier: TIER.errand,
  ja: '買い物に行く', en: 'go shopping', icon: '🛒',
  text: 'go shopping for daily supplies',
  precond: (a, C) => (a.supply || 0) > C.thr.needHi,
  target: (a, C) => spec('cat', { cat: C.IDX.buy, pref: C.prefWeight, topK: 3 }),
  stay: (a, C, t) => t != null && C.IDX.buy.includes(t),
});

// 退屈しのぎ (娯楽施設へ出かける)。
register({
  id: 'entertain', need: 'bored', tier: TIER.leisure,
  ja: '遊びに行く', en: 'go have fun', icon: '🎡',
  text: 'go to an entertainment place because of boredom',
  precond: (a, C) => (a.bored || 0) > C.thr.needHi,
  target: (a, C) => spec('cat', { cat: C.IDX.fun, pref: C.prefWeight, topK: 3 }),
  stay: (a, C, t) => t != null && C.IDX.fun.includes(t),
});

// 用事なし。**街でいちばん多い状態**。従来の「ランダムな建物へ向かって歩く」。
// pastime.js の娯楽はこの Option の最中に発生する (server.js 側は変えない)。
register({
  id: 'idle', need: null, tier: TIER.idle,
  ja: 'ぶらぶらする', en: 'wander around', icon: '🚶',
  text: 'wander around the town with nothing in particular to do',
  precond: () => true,
  target: () => spec('random'),
  stay: () => false,      // 用事が無ければ外へ出る (元 shouldLeaveBuilding の n===null)
});

// ═══ ここから下は「後から足せること」の実例 ═════════════════════════════════
// **既定では登録しない。** HLP_EXTRA=1 のときだけ足す。これがあることで
// 「行動を1つ増やすのに options.js を1ブロック書くだけで済む」ことを示す。
// 効用は既存の段の隙間に置き、生命に関わる段は決して跨がない。

const EXTRA = [
  // 街を見て回る (冒険好き)。idle の上、leisure の下。
  {
    id: 'explore', need: null, tier: TIER.idle + 20,
    ja: '街を探検する', en: 'explore the town', icon: '🧭',
    text: 'explore an unfamiliar part of the town out of curiosity',
    precond: (a, C) => !C.weekend || C.hour >= 8,
    target: () => spec('random'),
    persona: (a, C) => C.trait(a, 'curiosity') * PERSONA_MAX,
  },
  // 食べ歩き (食いしん坊)。空腹でなくても飲食店へ寄る。
  {
    id: 'food-crawl', need: null, tier: TIER.idle + 10,
    ja: '食べ歩きする', en: 'go for a food crawl', icon: '🍡',
    text: 'visit several food places in a day for pleasure, not hunger',
    precond: (a, C) => C.hour >= 11 && C.hour < 21 && (a.hunger || 0) <= C.thr.needHi,
    target: (a, C) => spec('cat', { cat: C.IDX.food, pref: C.prefWeight, topK: 4 }),
    persona: (a, C) => C.trait(a, 'gourmet') * PERSONA_MAX,
  },
];

/** EXTRA を登録する (HLP_EXTRA=1 のときだけ server.js から呼ぶ)。 */
function registerExtras() {
  for (const e of EXTRA) if (!byId[e.id]) register(e);
}

// ── 割り込み (percept) の種類 ───────────────────────────────────────────────
// LLP が歩きながら気づいたことを HLP に上げるための語彙。
// **ここに無いものは割り込めない**ので、増やすときはここに足す。
//   from … 誰が出すか (診断用)
//   pre  … 割り込みで新しく始まる Option の id (null = 現在の Option を続ける)
//   gain … 割り込みの強さ。現 Option の効用にこれを足しても勝てるなら乗り換える。
const PERCEPTS = {
  'saw-friend':       { pre: 'idle',      gain: 30, ja: '知り合いを見かけた' },
  'saw-new-shop':     { pre: 'idle',      gain: 25, ja: '知らない店を見つけた' },
  'saw-crime':        { pre: null,        gain: 40, ja: '事件を目撃した' },
  'target-gone':      { pre: null,        gain: 999, ja: '目的地が無くなっていた' },
  'target-mismatch':  { pre: null,        gain: 999, ja: '着いたが目的の建物ではなかった' },
  'blocked':          { pre: null,        gain: 10, ja: '道が塞がっている' },
};

// ═══ 学習したハイポリシーの行動カタログ ═══════════════════════════════════
// **一覧の唯一の定義は hlp_meta.json (ノートブックが吐く)。** ここで JS 側に
// 書き写すと必ずズレるので、メタから組み立てる。id・説明文・埋め込みが
// 学習時とビット単位で同じであることが、方策が正しく動く前提。
//
// precond は**学習時の mask() の逐語訳**にすること。deploy 側だけが余計に
// 候補を出す/削ると、方策は学習中に一度も見ていない状況に置かれる。

/** 既定の 8 個を捨てて、学習済みカタログに入れ替える。 */
function resetTo(list) {
  ACTS.length = 0;
  for (const k of Object.keys(byId)) delete byId[k];
  for (const o of list) register(o);
}

/**
 * hlp_meta.json の options[] から Option を作る。
 *   meta … hlp_meta.json
 *   X    … server.js 側の橋渡し
 *          catIdx: {food:[typeIdx...], buy:[], fun:[], care:[], home:[], work:[]}
 *          typeIndexOf(name) -> typeIdx | null
 *          hasCat(cat) / hasType(typeIdx) … その街に在るか
 */
function registerFromMeta(meta, X) {
  const built = [];
  for (const m of (meta.options || [])) {
    const ttypeIdx = m.ttype ? X.typeIndexOf(m.ttype) : null;
    const catList  = X.catIdx[m.cat] || null;
    built.push({
      // idx = hlp_meta.json の options[] の並び順。**ネットのスコア表はこの順**。
      // 並べ替えたら学習した対応が壊れるので、メタの順序をそのまま使うこと。
      idx: built.length,
      id: m.id, need: m.need || null, tier: TIER.idle,
      ja: m.id, en: m.id, icon: '',
      text: m.text || '',
      emb: Float32Array.from(m.emb || []),      // 学習時と同じ埋め込み
      cat: m.cat, ttype: m.ttype, dwellMin: m.dwell_min, cost: m.cost,
      // ── 学習時 mask() の逐語訳 ──
      //   ① 夜 (22時〜6時) と限界の疲労 (>0.93) では sleep だけ
      //   ② 行き先のカテゴリ / 建物タイプが街に無い行動は候補に出さない
      precond: (a, C) => {
        const forceSleep = (C.hour >= 22 || C.hour < 6) || (a.fatigue || 0) > 0.93;
        if (forceSleep) return m.id === 'sleep';
        if (m.cat === '-') return true;
        if (ttypeIdx != null) return X.hasType(ttypeIdx);
        if (m.cat === 'home') return !!a.home || X.hasCat('home');
        if (m.cat === 'work') return !!(a.work || a.school);
        if (m.cat === 'other') return true;
        return !!(catList && catList.length && X.hasCat(m.cat));
      },
      target: (a, C) => {
        if (m.cat === '-')     return spec('stay');
        if (m.cat === 'home')  return spec('home');
        if (m.cat === 'work')  return spec('workplace');
        if (m.cat === 'other') return spec('random');
        // 特定の店 (ラーメン屋など) が指定されていればその型だけ、無ければカテゴリ全体
        const cat = ttypeIdx != null ? [ttypeIdx] : catList;
        if (!cat || !cat.length) return spec('random');
        return spec('cat', { cat, pref: C.prefWeight, topK: 3 });
      },
      // 屋内に留まるかは既存の need ごとの規則をそのまま使う (UI と回復判定の互換)
      stay: (a, C, t) => {
        switch (m.need) {
          case 'sleep': return a.home ? C.indoorsAt(a, a.home[0], a.home[1])
                                      : (t != null && C.IDX.home.includes(t));
          case 'work':  { if (C.isCourier(a) && C.onDeliveryDuty(a)) return false;
                          const w = a.school || a.work;
                          return !!(w && C.indoorsAt(a, w[0], w[1])); }
          case 'eat':   return t != null && C.IDX.food.includes(t);
          case 'shop':  return t != null && C.IDX.buy.includes(t);
          case 'bored': return t != null && C.IDX.fun.includes(t);
          case 'sick':  return t != null && C.IDX.care.includes(t);
          default:      return false;
        }
      },
    });
  }
  if (!built.length) throw new Error('hlp_meta.json に options が無い');
  resetTo(built);
  return built.length;
}

module.exports = {
  ACTS, byId, register, registerExtras, registerFromMeta, resetTo, spec,
  TIER, PERSONA_MAX, PERCEPTS, EXTRA,
};
