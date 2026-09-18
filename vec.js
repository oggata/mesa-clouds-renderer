// vec.js — 行動をベクトルで表す。「行動の一覧から選ぶ」をやめて、
//          欲求ベクトルと、場所が与えるベクトルの照合で「いま何をするか」を決める。
//
// ── なぜ ──
// これまでの住民は options.js の一覧 (病院へ / 寝る / 食べる / 働く / 買う / 遊ぶ / ぶらぶら) から
// 段の優先順位 (if-else) で 1 つ選んでいた。一覧に無い過ごし方はできないし、
// 時代の変化 (在宅勤務・通販) も「PC 時代は 10% が在宅」のような**規則**として書くしかなかった。
//
// ここでは RGB が 3 チャンネルの強さで無限の色を表すのと同じ考え方をとる。
//   住民の「したいこと」 = チャンネルごとの強さ (欲求ベクトル d)
//   場所の「できること」 = 同じチャンネルごとの強さ (提供ベクトル A)
//   選ぶ場所           = argmax  Σ_c w_c · d_c · A_c  −  移動の手間  +  馴染み  +  揺らぎ
// 一覧に無い「友だちと図書館でひと休み」も、ベクトルとしては自然に表せる。
// 名前 (「図書館で休む (誰かと一緒に)」) は**選んだ後に**付ける。
//
// ── 書くのは「世界」だけ ──
// 在宅勤務も通販も郵便局の用事も、ここには**規則として書いていない**。
// 時代ごとに「自宅が何を与えてくれるか」(ERA_HOME) を変えるだけで、
// 住民は損得 (距離・満たされ方) からそれを選ぶようになる。
// 満たされ方も同じベクトルで決まる (server.js stepNeeds が A_c に比例して欲求を減らす)。
//
// ── チャンネルの作り方 ──
//   基本 7 … 世界の反応 (欲求の増減) と直結するもの。空腹・疲労などの既存の状態に対応する
//   暮らし 4 … 過ごし方 40 個 × 記述 14 個の採点を因子分析してまとめたもの
//             (data/vec/activities.json → node tools/vec-channels.js)
//             固有値 > 1 の因子が 4 つ: 人と会う / 体を動かす / 新しさ / 自然。
//             ★ 最初は「静けさ」も置くつもりだったが、因子として出なかった
//               (「ひとり・静か」は人と会う軸の、「くつろぐ」は体を動かす軸の反対側に吸収された)。
//               データに従って外した。静かな場所の価値は 休息・新しさ・自然 で表す。
// **世界が反応しないチャンネルは置かない** (違う行動を生まないので)。
//
// server.js に依存しない。three も headless-gl も要らない。

'use strict';

// ═══ チャンネル ═════════════════════════════════════════════════════════════
//   w     … 照合の重み (生命に関わるものほど大きい)
//   verb  … 名前付けの動詞 (その場所で「◯◯する」)
//   mod   … 2 番目に効いたときの添え言葉
//   need  … 既存コードの互換名 (UI / カメラ / 配達 / 需要ヒートマップが見ている)
const CH = [
  // ── 基本 (世界の反応と直結) ──
  { id: 'food',    ja: '満腹',     w: 1.0, verb: '食事する',         mod: '腹ごしらえしながら', need: 'eat' },
  { id: 'rest',    ja: '休息',     w: 1.0, verb: '休む',             mod: 'ひと休みしながら',   need: 'rest' },
  { id: 'supply',  ja: '日用品',   w: 0.8, verb: '買い物する',       mod: 'ついでに買い物して', need: 'shop' },
  { id: 'fun',     ja: '楽しさ',   w: 0.7, verb: '遊ぶ',             mod: '楽しみながら',       need: 'bored' },
  { id: 'care',    ja: '治療',     w: 1.6, verb: '診てもらう',       mod: '体を気づかいながら', need: 'sick' },
  { id: 'duty',    ja: '務め',     w: 1.0, verb: '働く',             mod: '仕事の合間に',       need: 'work' },
  { id: 'errand',  ja: '用事',     w: 0.8, verb: '用事を済ませる',   mod: '用事のついでに',     need: 'errand' },
  // ── 暮らし (因子分析でまとめたもの。tools/vec-channels.js) ──
  { id: 'social',  ja: '人と会う', w: 0.6, verb: '人と過ごす',       mod: '誰かと一緒に',       need: null },
  { id: 'novelty', ja: '新しさ',   w: 0.5, verb: '新しいものを見る', mod: '新しい発見を探して', need: null },
  { id: 'nature',  ja: '自然',     w: 0.5, verb: '自然に触れる',     mod: '緑を感じながら',     need: null },
  { id: 'active',  ja: '体を動かす', w: 0.5, verb: '体を動かす',     mod: '体を動かしながら',   need: null },
];
const NC = CH.length;
const IDX = Object.fromEntries(CH.map((c, i) => [c.id, i]));
const LIFE = ['social', 'novelty', 'nature', 'active', 'errand'];   // a.vn に状態を持つチャンネル

const vec = obj => { const v = new Float32Array(NC); for (const k in obj) v[IDX[k]] = obj[k]; return v; };

// ═══ 場所が与えるもの ═══════════════════════════════════════════════════════
// 建物の型ごと。open … 開いている時間 [開, 閉) (null = いつでも)。price … 1 回あたりの出費感 (0..1)。
// public:false … 誰でも行ける場所ではない (住宅・職場・学校は本人だけ)。
const PLACE = {
  kiosk:       { a: vec({ food: .55, social: .35, novelty: .2 }),                     open: [10, 21], price: .15 },
  conbini:     { a: vec({ supply: .7, food: .35, errand: .35 }),                      open: null,     price: .25 },
  pharmacy:    { a: vec({ care: .7, supply: .35 }),                                   open: [9, 20],  price: .3 },
  cafe:        { a: vec({ food: .45, rest: .5, social: .45 }),              open: [7, 21],  price: .35 },
  gyudon:      { a: vec({ food: .8 }),                                                open: [6, 24],  price: .15 },
  ramen:       { a: vec({ food: .9, social: .2 }),                                    open: [11, 23], price: .3 },
  bento:       { a: vec({ food: .7 }),                                                open: [8, 20],  price: .2 },
  shop:        { a: vec({ supply: .6, novelty: .35, fun: .2 }),                       open: [10, 20], price: .35 },
  post:        { a: vec({ errand: 1.0 }),                                             open: [9, 17],  price: .05 },
  bank:        { a: vec({ errand: .95 }),                                             open: [9, 15],  price: .0 },
  hotel:       { a: vec({ rest: .6, novelty: .3 }),                         open: null,     price: .8 },
  supermarket: { a: vec({ supply: 1.0, food: .25 }),                                  open: [9, 22],  price: .4 },
  temple:      { a: vec({ nature: .55, rest: .5, novelty: .15 }),                          open: [6, 18],  price: .0 },
  station:     { a: vec({ novelty: .45, social: .3 }),                                open: [5, 24],  price: .1 },
  library:     { a: vec({ fun: .45, rest: .45, novelty: .45, errand: .15 }), open: [9, 20], price: .0 },
  hospital:    { a: vec({ care: 1.0 }),                                               open: null,     price: .5 },
  cityhall:    { a: vec({ errand: .85 }),                                             open: [9, 17],  price: .0 },
  museum:      { a: vec({ novelty: .9, fun: .5 }),                         open: [10, 18], price: .45 },
  stadium:     { a: vec({ fun: .85, active: .8, social: .6 }),                        open: [9, 21],  price: .45 },
  mall:        { a: vec({ supply: .75, fun: .6, novelty: .45, food: .4, social: .35 }), open: [10, 21], price: .5 },
  park:        { a: vec({ nature: .9, rest: .4, active: .45, social: .3 }), open: null,    price: .0 },
  ground:      { a: vec({ active: .95, fun: .45, social: .45, nature: .35 }),         open: [6, 20],  price: .0 },
  // ── 本人だけの場所 (住宅・職場・学校)。a は下の personal() が作る ──
  house:       { a: vec({}), public: false, home: true },
  apartment:   { a: vec({}), public: false, home: true },
  office:      { a: vec({}), public: false, work: true },
  tower:       { a: vec({}), public: false, work: true },
  police:      { a: vec({}), public: false, work: true },
  warehouse:   { a: vec({}), public: false, work: true },
  school:      { a: vec({}), public: false, work: true },
  elementary:  { a: vec({}), public: false, work: true },
  junior:      { a: vec({}), public: false, work: true },
  high:        { a: vec({}), public: false, work: true },
  university:  { a: vec({ novelty: .3 }), public: false, work: true },
};

// 自宅が与えるもの。**時代で変わる**。在宅勤務・通販・ネットの用事・家での娯楽はここだけで表す。
//   [アナログ, PC, スマホ, AI]
const ERA_HOME = {
  rest:   [1.0, 1.0, 1.0, 1.0],
  food:   [.25, .3, .45, .55],    // 自炊 → 出前。★ .45 から始めたら来店が 1/3 に落ちた (実測) ので昔ほど低く
  fun:    [.15, .25, .4, .5],     // ラジオ → ゲーム → 動画 → VR
  supply: [0, 0, .55, .75],       // 通販 (届くのを待つ)
  errand: [0, .15, .7, .9],       // ネット銀行・電子申請
  social: [.05, .1, .35, .45],    // 電話 → SNS → 通話
  duty:   [0, .1, .6, .95],       // 在宅勤務 (在宅でできる仕事の人だけ)
  novelty:[0, .1, .2, .3],        // ネットで新しいものを見る
};
const ERA_WORK_DUTY = 1.0;        // 職場・学校の「務め」(時代で変わらない)

// 本人にとっての住宅・職場のベクトル
//   who = { own: 'home'|'work'|'other-home'|'none', homeless, teleworkable }
function personal(kind, era, who) {
  const v = new Float32Array(NC);
  if (kind === 'home') {
    for (const k in ERA_HOME) v[IDX[k]] = ERA_HOME[k][era] || 0;
    if (!who.teleworkable) v[IDX.duty] = 0;
    return v;
  }
  if (kind === 'shelter') { v[IDX.rest] = .8; return v; }       // 家なしが住居で休む
  if (kind === 'work') { v[IDX.duty] = ERA_WORK_DUTY; v[IDX.social] = .25; return v; }
  return v;
}

// 開いているか (0..1)。**閉店の前後 0.5 時間で滑らかに落とす** — 境目で一斉に店を出る/入るのを防ぐ。
function openness(open, hour) {
  if (!open) return 1;
  let [o, c] = open;
  const soft = 0.5;
  const h = hour;
  const up = Math.max(0, Math.min(1, (h - o + soft) / soft));
  const down = Math.max(0, Math.min(1, (c - h) / soft));
  return Math.min(up, down);
}

// ═══ 欲求ベクトル ═══════════════════════════════════════════════════════════
// 欲求の強さは**なめらかな曲線**で作る (閾値の if を置かない)。
//   s = { hunger, fatigue, supply, bored, sick, vn:{social,novelty,nature,active,errand},
//         hour, weekend, era, worker, student, dutyShift, chrono, traits:{curiosity,sociability,homebody,thrift,diligence} }
const ERA_SLEEP_MID = [1.25, 2.0, 3.25, 3.0];   // 眠気の山の中心 (時刻)。アナログは早寝、スマホで夜更かし
const sq = x => x * x;
// 夜の眠気: 中心から離れるほど弱まる山 (0..1)
function circadian(hour, mid) {
  let d = Math.abs(hour - mid); if (d > 12) d = 24 - d;
  return Math.pow(Math.max(0, Math.cos(d / 12 * Math.PI) * 0.5 + 0.5), 5);
}
// 勤務/通学の時間帯 (0..1)。始業・終業はシグモイドでなめらかに
const sig = x => 1 / (1 + Math.exp(-x));
function dutyCurve(hour, from, to) { return sig((hour - from) * 4) * sig((to - hour) * 4); }

function desire(s, out) {
  const d = out || new Float32Array(NC);
  const t = s.traits;
  // 飢えと限界の疲労は、限界に近づくほど急に強くなる (h⁸ の項)。**段の if は置かない**が、
  // 満腹 1.0 に近い空腹は仕事 (最大 2.5) より強くなるので、「腹ペコのまま働き続ける」は起きない。
  d[IDX.food]   = sq(s.hunger) * 2.4 + Math.pow(s.hunger, 8) * 3.0;
  d[IDX.rest]   = sq(s.fatigue) * 1.8 + Math.pow(s.fatigue, 8) * 3.0
                + circadian(s.hour, ERA_SLEEP_MID[s.era] + (s.chrono || 0)) * 2.6;
  d[IDX.supply] = sq(s.supply) * 1.6;
  d[IDX.fun]    = sq(s.bored) * 1.4 + 0.12;
  d[IDX.care]   = s.sick * 3.5;
  let duty = 0;
  if (!s.weekend) {
    if (s.student) duty = dutyCurve(s.hour, 8, 15);
    else if (s.worker) duty = dutyCurve(s.hour, 9 + (s.dutyShift || 0), 17 + (s.dutyShift || 0));
  }
  d[IDX.duty]   = duty * (1.9 + 0.6 * (t.diligence || 0.5));
  const vn = s.vn;
  d[IDX.errand] = sq(vn.errand) * 1.8;
  d[IDX.social] = vn.social * (0.3 + 0.9 * (t.sociability || 0.5));
  d[IDX.novelty]= vn.novelty * (0.2 + 0.9 * (t.curiosity || 0.5));
  d[IDX.nature] = vn.nature * 0.8;
  d[IDX.active] = vn.active * (0.2 + 0.6 * (1 - (t.homebody || 0.3)));
  return d;
}
// 暮らしのチャンネルの状態が 1 秒あたりどれだけ溜まるか (その場で満たされなければ)
const LIFE_RATE = { social: 1 / 900, novelty: 1 / 1400, nature: 1 / 1600, active: 1 / 1300, errand: 1 / 2600 };
// その場所に居るとき、1 秒あたりどれだけ満たされるか (A_c に掛ける)
const LIFE_SAT  = { social: 1 / 120, novelty: 1 / 150, nature: 1 / 150, active: 1 / 140, errand: 1 / 25 };

// ═══ 照合 ═══════════════════════════════════════════════════════════════════
// 候補 = [{ key, kind, typeName, r, c, A (Float32Array), dist, price, fam }]
//   kind … 'place' | 'home' | 'work' | 'shelter' | 'walk'
// 戻り値 { best, score, contrib (Float32Array), fit, need, label }
const TRAVEL_W = 0.035;     // 1 セルあたりの移動の手間
const STICK    = 0.12;      // いま向かっている/居る場所を続ける上乗せ (行ったり来たりを防ぐ)
const THRIFT_W = 0.35;

function match(d, cands, opt) {
  const o = opt || {};
  let best = null, bestS = -Infinity;
  let dmag = 0;
  for (let c = 0; c < NC; c++) dmag += CH[c].w * d[c];
  for (const k of cands) {
    let s = 0;
    const A = k.A;
    for (let c = 0; c < NC; c++) s += CH[c].w * d[c] * A[c];
    s -= TRAVEL_W * k.dist * (0.6 + (o.fatigue || 0));
    s -= THRIFT_W * (k.price || 0) * (o.thrift || 0.5) * 0.3;
    s += (k.fam || 0) + (k.jit || 0);
    if (k.key === o.current) s += STICK;
    k._s = s;
    if (s > bestS) { bestS = s; best = k; }
  }
  const contrib = new Float32Array(NC);
  let got = 0;
  if (best) for (let c = 0; c < NC; c++) { contrib[c] = CH[c].w * d[c] * best.A[c]; got += contrib[c]; }
  return { best, score: bestS, contrib, fit: dmag > 0 ? got / dmag : 1, dmag };
}

// 選んだ行動の主な中身 (効いたチャンネルの上位 2 つ)
function topChannels(contrib) {
  let a = -1, b = -1;
  for (let c = 0; c < NC; c++) {
    if (a < 0 || contrib[c] > contrib[a]) { b = a; a = c; }
    else if (b < 0 || contrib[c] > contrib[b]) b = c;
  }
  return [a, b];
}

// 互換名 (needOf の戻り値)。休息は「夜に自宅で」なら sleep
function needOf(m, isNight) {
  if (!m.best) return null;
  const [a] = topChannels(m.contrib);
  if (a < 0 || m.contrib[a] <= 0.05) return null;
  const n = CH[a].need;
  if (n === 'rest' && m.best.kind === 'home' && isNight) return 'sleep';
  if (n === 'rest' && m.best.kind === 'shelter') return 'sleep';
  if (n === 'work' && m.best.kind === 'home') return 'work';
  return n;
}

// 名前。placeJa は呼び出し側 (店名など) が渡す
function label(m, placeJa, isNight, ja) {
  if (!m.best) return ja ? 'ぶらぶらする' : 'wander';
  const [a, b] = topChannels(m.contrib);
  if (a < 0 || m.contrib[a] <= 0.02) return m.best.kind === 'home' ? '自宅でくつろぐ' : `${placeJa}へ向かう`;
  const A = CH[a];
  let verb = A.verb;
  if (A.id === 'rest' && m.best.kind === 'home' && isNight) verb = '寝る';
  if (A.id === 'duty' && m.best.kind === 'home') verb = '在宅勤務する';
  if (A.id === 'duty' && m.best.student) verb = '学ぶ';
  if (A.id === 'supply' && m.best.kind === 'home') verb = '通販で買い物する';
  if (A.id === 'errand' && m.best.kind === 'home') verb = 'ネットで用事を済ませる';
  if (A.id === 'social' && m.best.kind === 'home') verb = '連絡を取り合う';
  const where = m.best.kind === 'walk' ? '街' : placeJa;
  let s = m.best.kind === 'walk' ? `${where}を歩いて${verb}` : `${where}で${verb}`;
  if (b >= 0 && m.contrib[b] > m.contrib[a] * 0.5 && m.contrib[b] > 0.05) s += ` (${CH[b].mod})`;
  return s;
}

// 行動の署名 (新しさの計測用)。上位 2 チャンネル + 場所の種類
function signature(m) {
  if (!m.best) return 'none';
  const [a, b] = topChannels(m.contrib);
  const hi = c => (c >= 0 && m.contrib[c] > 0.05) ? CH[c].id : '-';
  return `${hi(a)}+${(b >= 0 && m.contrib[b] > m.contrib[a] * 0.5) ? hi(b) : '-'}@${m.best.typeName || m.best.kind}`;
}

// 叶わなかった欲求: **いちばん強い欲求 (務め・休息を除く) を、行ける範囲のどこでも満たせない**。
//   ★ 最初は「選んだ場所で欲求全体の 3 割以下しか満たされない」で判定していた。複数の欲求を
//     同時に持つ人はどこへ行ってもそうなるので、1 日 3 万件を超えて意味が無くなった (実測)。
//     「その欲求に応える場所が街に無い / 遠すぎる / 閉まっている」だけを数える。
const UNMET_SKIP = new Set(['duty', 'rest']);
const UNMET_MAG = 0.8, UNMET_BEST = 0.3;
function unmetChannel(d, cands) {
  let c0 = -1, v0 = 0;
  for (let c = 0; c < NC; c++) {
    if (UNMET_SKIP.has(CH[c].id)) continue;
    const v = CH[c].w * d[c];
    if (v > v0) { v0 = v; c0 = c; }
  }
  if (c0 < 0 || v0 < UNMET_MAG) return -1;
  let best = 0;
  for (const k of cands) {
    const s = k.A[c0] - TRAVEL_W * k.dist * 0.6;
    if (s > best) best = s;
  }
  return best < UNMET_BEST ? c0 : -1;
}
function isUnmet(m) { return m.unmetCh != null && m.unmetCh >= 0; }

// 叶わなかった欲求ベクトルに最も合う建物の型 (起業の種)
function bestTypeFor(unmet, allowed) {
  let best = null, bs = -Infinity;
  for (const name of allowed) {
    const P = PLACE[name]; if (!P || P.public === false) continue;
    let s = 0, n = 0;
    for (let c = 0; c < NC; c++) { s += unmet[c] * P.a[c]; n += unmet[c] * unmet[c]; }
    s /= Math.sqrt(n || 1);
    if (s > bs) { bs = s; best = name; }
  }
  return best;
}

module.exports = {
  CH, NC, IDX, LIFE, PLACE, ERA_HOME, ERA_SLEEP_MID, LIFE_RATE, LIFE_SAT,
  vec, personal, openness, circadian, dutyCurve, desire, match, topChannels,
  needOf, label, signature, isUnmet, unmetChannel, bestTypeFor, TRAVEL_W, STICK,
};
