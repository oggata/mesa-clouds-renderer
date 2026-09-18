// tech.js — 時代 (テクノロジーレベル) と研究開発。
//
// ── 何をするか ──
// 街に「時代」の軸を足す。アナログ → パソコン → スマホ → AI。
// 発展段階 (集落→都市) は**大きさ**の軸で、経済で上がる。時代は**発見**で上がる。
// 軸を分けておくと「大都市なのにアナログ」「村なのにAI」という街も生まれる。
//
// ── 次の時代へ進む条件 = ヒット&ブロー ──
// 時代ごとに「隠れた正解」が 1 つある。
//
//     〈素材〉 × 〈場所〉 × 〈試す人の特性〉 × 〈時間帯〉    6 × 5 × 4 × 4 = 480 通り
//
// 住民は仮説を 1 つ選び、その場所へ歩いて、その時間帯に実験する。
// 結果は「いくつ当たっていたか (0〜4)」**だけ**が返り、掲示板に貼られる。
// どれが当たりかは教えない。4つ当たれば発明 = 次の時代。
//
// 特性の欄は**実験した本人の特性**で決まる。だから自分の特性では試せない仮説がある。
// 「僕はこの特性でここを確かめた、君はこの特性で確かめてみて」が
// 掲示板の依頼 (request) として自然に出てくる。
//
// ── 手応えを必ず返す理由 ──
// 0/1 (当たり・外れ) しか返さないと、480 通りのランダム探索になって何日も進まない。
// 当たり数を返すと、掲示板の結果と矛盾しない候補だけに絞り込める
// (1 回の実験でおおむね半分〜1/3 に減る = 二分探索に近い)。
//
// ── server.js に依存しない ──
// pastime.js / options.js と同じ。three も headless-gl も要らないので、
// tools/tech-sim.js (戦略の比較) と tools/tech-train.js (方策の学習) から
// **同じコード**を呼べる。学習と本番で特徴量の定義がズレるのを防ぐため。

'use strict';

// ═══ 時代 ═══════════════════════════════════════════════════════════════════
// year … その時代が始まる年。HUD の年号は「開始年 + 時代の中での進み具合」で出す。
//        カレンダーで進めないのは、発見が遅れたときに「1998年なのにPCが無い」
//        という矛盾を出さないため。
const ERAS = [
  { id: 'analog', ja: 'アナログ時代', en: 'Analog Age',     short: 'アナログ', year: 1980 },
  { id: 'pc',     ja: 'パソコン時代', en: 'PC Age',         short: 'パソコン', year: 1995 },
  { id: 'mobile', ja: 'スマホ時代',   en: 'Smartphone Age', short: 'スマホ',   year: 2008 },
  { id: 'ai',     ja: 'AI時代',       en: 'AI Age',         short: 'AI',       year: 2023 },
];
const END_YEAR = 2035;

// ═══ 特性 ═══════════════════════════════════════════════════════════════════
// 「試す人の特性」の語彙。住民はペルソナから 1〜2 個持つ。
const TRAITS = {
  science:  { ja: '理系',   en: 'science' },
  maker:    { ja: '職人',   en: 'maker' },
  social:   { ja: '社交家', en: 'people person' },
  founder:  { ja: '野心家', en: 'go-getter' },
  artist:   { ja: '芸術家', en: 'artist' },
  night:    { ja: '夜型',   en: 'night owl' },
  explorer: { ja: '探検家', en: 'explorer' },
};
const TRAIT_IDS = Object.keys(TRAITS);

// persona_pool.json の id → 特性。**無いペルソナは下の数値から推す** (traitsOf)。
const PERSONA_TRAITS = {
  'kid-rascal': ['explorer'], 'kid-bookish': ['science'], 'junior-club': ['explorer'],
  'junior-shy': ['artist'], 'high-athlete': ['explorer'], 'high-exam': ['science'],
  'high-dreamer': ['artist', 'founder'], 'uni-student': ['science', 'social'],
  'uni-founder': ['founder', 'science'], newgrad: ['science'], office: ['founder'],
  sales: ['social'], engineer: ['science', 'maker'], designer: ['artist'],
  freelancer: ['founder', 'artist'], cafe: ['social'], 'night-clerk': ['night'],
  ramen: ['founder', 'maker'], baker: ['maker'], florist: ['social'], bookshop: ['science'],
  watchmaker: ['maker'], barber: ['social'], courier: ['explorer'], taxi: ['explorer', 'night'],
  carpenter: ['maker'], electrician: ['maker', 'science'], mechanic: ['maker'],
  farmer: ['explorer'], nurse: ['social', 'night'], doctor: ['science'], pharmacist: ['science'],
  teacher: ['science', 'social'], librarian: ['science'], curator: ['artist', 'science'],
  guard: ['night'], firefighter: ['explorer', 'night'], reporter: ['explorer', 'social'],
  photographer: ['artist', 'explorer'], musician: ['artist', 'night'], painter: ['artist'],
  writer: ['artist', 'night'], fortune: ['social', 'night'], banker: ['founder'],
  realtor: ['founder', 'social'], jobseeker: ['explorer'], tourist: ['explorer'],
  retiree: ['maker'], elder: ['social'], toddler: [],
};
// 行動モデル (personas.json の id) からの推定。プールを使わない旧方式の住民用。
const POLICY_TRAITS = { A: 'explorer', B: 'maker', C: 'social', D: 'founder', E: 'explorer',
  F: 'explorer', G: 'maker', H: 'science', I: 'social', J: 'social', K: 'artist', L: null,
  M: 'artist', N: 'explorer', O: 'night' };

/** 住民の定義 (makeDef の戻り値) → 特性の配列。extra は後から身につけたもの。 */
function traitsOf(def, extra) {
  const d = def || {};
  let t = PERSONA_TRAITS[d.poolId];
  if (!t) {
    t = [];
    if ((d.enterprise || 0) >= 0.6) t.push('founder');
    if ((d.sociability || 0) >= 0.7) t.push('social');
    const p = POLICY_TRAITS[d.id];
    if (p && !t.includes(p)) t.push(p);
  }
  if (extra && extra.length) t = t.concat(extra.filter(x => !t.includes(x)));
  return t;
}

// ═══ 研究 (時代 k → k+1) ═══════════════════════════════════════════════════
// materials … 住民が街で**発見**しないと実験に使えない。正解の素材は必ずこの中にある。
// traits    … この研究で意味のある特性 4 つ。
// prereq    … 研究を始めるのに要る建物 (無ければ街が建てる。建てられなければ免除)。
// steps     … 1 つの時代に発明を 3 段重ねる (銅→スズ→青銅 のように)。段ごとに正解が変わり、
//             掲示板もまっさらになる。**最後の段が時代を変える発明。**
//             1 段だけだと研究が時代の 1/4 ほどで解けてしまい、残りが長い「普及待ち」になった
//             (実測: 60 日の時代の 15 日目に発明 → 21 日間なにも起きない)。
const step = (ja, en) => ({ ja, en });
const PLACES = [
  { id: 'home',  ja: '自宅のガレージ', en: 'a home garage' },
  { id: 'learn', ja: '学び舎',         en: 'a school' },
  { id: 'work',  ja: '仕事場',         en: 'a workplace' },
  { id: 'eat',   ja: '飲食店',         en: 'a diner' },
  { id: 'shop',  ja: '商店',           en: 'a shop' },
];
// 時間帯。夜は 22 時で切る — それ以降は睡眠が最優先で、誰も実験できないため。
const TIMES = [
  { id: 'morning', ja: '朝',   en: 'morning',   from: 6,  to: 10 },
  { id: 'noon',    ja: '昼',   en: 'midday',    from: 10, to: 14 },
  { id: 'evening', ja: '夕方', en: 'afternoon', from: 14, to: 18 },
  { id: 'night',   ja: '夜',   en: 'night',     from: 18, to: 22 },
];
const mat = (id, ja, en) => ({ id, ja, en });
const RESEARCH = [
  { to: 1, ja: 'パソコン', en: 'the personal computer',
    steps: [step('トランジスタ', 'the transistor'), step('マイコン', 'the microchip'), step('パソコン', 'the personal computer')],
    materials: [mat('silicon', 'シリコン', 'silicon'), mat('copper', '銅線', 'copper wire'),
      mat('magnet', '磁石', 'magnets'), mat('plastic', 'プラスチック', 'plastic'),
      mat('quartz', '水晶', 'quartz'), mat('battery', '乾電池', 'batteries')],
    traits: ['science', 'maker', 'founder', 'night'],
    prereq: { ja: '学び舎', en: 'a school',
      types: ['elementary', 'library', 'junior', 'school', 'high', 'university'] } },
  { to: 2, ja: 'スマートフォン', en: 'the smartphone',
    steps: [step('携帯電話', 'the mobile phone'), step('インターネット', 'the internet'), step('スマートフォン', 'the smartphone')],
    materials: [mat('lithium', 'リチウム', 'lithium'), mat('glass', '強化ガラス', 'tough glass'),
      mat('rareearth', 'レアアース', 'rare earths'), mat('antenna', 'アンテナ', 'antennas'),
      mat('lcd', '液晶', 'LCD panels'), mat('lens', '小型レンズ', 'tiny lenses')],
    traits: ['artist', 'social', 'founder', 'science'],
    prereq: { ja: '郵便局か駅', en: 'a post office or station',
      types: ['post', 'station', 'office', 'tower'] } },
  { to: 3, ja: '人工知能', en: 'artificial intelligence',
    steps: [step('検索エンジン', 'the search engine'), step('ディープラーニング', 'deep learning'), step('人工知能', 'artificial intelligence')],
    materials: [mat('gpu', 'GPU', 'GPUs'), mat('data', '大量のデータ', 'big data'),
      mat('power', '電力', 'electricity'), mat('fiber', '光ファイバー', 'optical fiber'),
      mat('paper', '論文', 'research papers'), mat('coolant', '冷却水', 'coolant')],
    traits: ['science', 'night', 'explorer', 'maker'],
    prereq: { ja: '図書館か大学', en: 'a library or university',
      types: ['library', 'university', 'high', 'school'] } },
  // AI 時代の研究。発明すると 1980 年へ戻り、文明の 2 周目が始まる (TECH_LOOP=0 なら研究しない)。
  // 最後の時代にも研究を置くのは、**何も起きない時代を作らない**ため (1 時代 = 実時間 18 時間ある)。
  { to: 0, ja: 'タイムマシン', en: 'a time machine', loop: true,
    steps: [step('量子コンピュータ', 'the quantum computer'), step('時空理論', 'a theory of spacetime'), step('タイムマシン', 'a time machine')],
    materials: [mat('clock', '古時計', 'an old clock'), mat('quantum', '量子チップ', 'quantum chips'),
      mat('lightning', '雷の電気', 'lightning'), mat('photo', '古い写真', 'old photos'),
      mat('magnet2', '超伝導磁石', 'superconducting magnets'), mat('diary', '1980年の日記', 'a diary from 1980')],
    traits: ['science', 'artist', 'night', 'founder'],
    prereq: { ja: '大学か図書館', en: 'a university or library',
      types: ['university', 'library', 'high', 'school', 'tower'] } },
];

// ═══ 仮説の符号化 ════════════════════════════════════════════════════════════
// h = ((m*NP + p)*NT + t)*NH + tm   (m=素材 p=場所 t=特性 tm=時間帯)
const NM = 6, NP = PLACES.length, NT = 4, NH = TIMES.length;
const NHYP = NM * NP * NT * NH;
const SLOTS = 4;
const enc = (m, p, t, tm) => ((m * NP + p) * NT + t) * NH + tm;
const dec = h => [Math.floor(h / (NP * NT * NH)), Math.floor(h / (NT * NH)) % NP,
                  Math.floor(h / NH) % NT, h % NH];
// 当たり数の表 (480×480)。起動時に 1 回だけ作る。230KB。
const HITS = new Uint8Array(NHYP * NHYP);
for (let i = 0; i < NHYP; i++) {
  const a = dec(i);
  for (let j = 0; j < NHYP; j++) {
    const b = dec(j);
    HITS[i * NHYP + j] = (a[0] === b[0]) + (a[1] === b[1]) + (a[2] === b[2]) + (a[3] === b[3]);
  }
}
const hits = (a, b) => HITS[a * NHYP + b];

// ═══ 知識 ════════════════════════════════════════════════════════════════════
// 掲示板の結果と矛盾しない仮説の一覧。posts = [{h, hits}]、hints = {slot: value}
function consistent(posts, hints) {
  const out = [];
  outer: for (let s = 0; s < NHYP; s++) {
    if (hints) {
      const d = dec(s);
      for (const k in hints) if (d[k] !== hints[k]) continue outer;
    }
    for (const p of posts) if (HITS[p.h * NHYP + s] !== p.hits) continue outer;
    out.push(s);
  }
  return out;
}

// ═══ 時代ごとの「情報の伝わり方」と「推論の強さ」 ════════════════════════
// **課題 (480 通り・3 段・素材 6 個) は全時代で同じ。** 変わるのは住民の側の道具だけ。
// ブロックチェーンの PoW と同じで、難易度は一定、解く側が速くなる。
//   share … gossip  すれ違った人とだけ知っていることを交換する (アナログ)
//           visit   掲示板の建物へ行けば全員の投稿が読める (PC)
//           live    どこでも読める (スマホ / AI)
//   infer … folk    民間の知恵: 試した組み合わせと「0個当たり」の要素を避け、
//                   当たりの多かった結果に似たものを試す (AI 以前)
//           logic   全結果と矛盾しない候補だけに論理的に絞る + 二分木 (AI)
const ERA_SHARE = ['gossip', 'visit', 'live', 'live'];
// 実測で決めた値 (tools/tech-sim.js, 1 段あたりの実験回数 アナログ 48 / PC 25 / スマホ 18 / AI 11)
let GOSSIP_P = 0.05, VISIT_P = 0.3, FOLK_NOISE = 4;
const tune = o => { if (o.gossipP != null) GOSSIP_P = o.gossipP; if (o.visitP != null) VISIT_P = o.visitP;
                    if (o.folkNoise != null) FOLK_NOISE = o.folkNoise; };
const ERA_INFER = ['folk', 'folk', 'folk', 'logic'];

// 民間の知恵で「まだ有りうる」と思っている候補。consistent より緩い (矛盾する候補も残る)。
function folkSet(posts, hints) {
  const tested = new Set(posts.map(p => p.h));
  const bad = [new Set(), new Set(), new Set(), new Set()];
  for (const p of posts) if (p.hits === 0) { const d = dec(p.h); for (let k = 0; k < SLOTS; k++) bad[k].add(d[k]); }
  const out = [];
  for (let s = 0; s < NHYP; s++) {
    if (tested.has(s)) continue;
    const d = dec(s);
    let ok = true;
    for (let k = 0; k < SLOTS && ok; k++) if (bad[k].has(d[k])) ok = false;
    if (ok && hints) for (const k in hints) if (d[k] !== hints[k]) { ok = false; break; }
    if (ok) out.push(s);
  }
  return out;
}
// 住民の頭の中の候補 (推論の強さで変わる)
const knowledgeSet = (posts, hints, infer) => infer === 'logic' ? consistent(posts, hints) : folkSet(posts, hints);

// 民間の知恵での選び方。当たりの多かった結果と要素を多く共有する仮説ほど良いと考える。
//   score = Σ (当たり数 - 1) × 共有する要素の数  … 2 個以上当たった結果に寄せ、1 個以下からは離れる
function chooseFolk(cands, k, rnd) {
  const R = rnd || _rnd;
  if (!cands.length) return null;
  const pri = cands.filter(c => (c.requested || c.viewer) && c.inS);
  if (pri.length) return pri[Math.floor(R() * pri.length)];
  const posts = k.posts || [];
  let best = null, bestSc = -Infinity;
  for (const c of cands) {
    const d = dec(c.h);
    let sc = 0;
    for (const p of posts) {
      const e = dec(p.h);
      const m = (d[0] === e[0]) + (d[1] === e[1]) + (d[2] === e[2]) + (d[3] === e[3]);
      sc += (p.hits - 1) * m;
    }
    sc += (c.inS ? 1 : -3) + R() * FOLK_NOISE - (c.cost || 0) * 1.5 - (c.wait || 0) * 4;
    if (sc > bestSc) { bestSc = sc; best = c; }
  }
  return best;
}

// 仮説 g を試したときの「結果の割れ方」。割れるほど情報が多い。
//   H     … 結果の分布のエントロピー (nat)。二分木の「どれだけ半分に割れるか」
//   worst … いちばん悪い結果のときに残る候補の割合 (ミニマックス)
const _cnt = new Float64Array(SLOTS + 1);
function partition(g, S) {
  _cnt.fill(0);
  for (const s of S) _cnt[HITS[g * NHYP + s]]++;
  const n = S.length || 1;
  let H = 0, worst = 0;
  for (let k = 0; k <= SLOTS; k++) {
    if (!_cnt[k]) continue;
    const p = _cnt[k] / n;
    H -= p * Math.log(p);
    if (p > worst) worst = p;
  }
  return { H, worst };
}

// ═══ 候補の特徴量 ═══════════════════════════════════════════════════════════
// **ロジックと方策が同じものを見る。** tools/tech-train.js もここを呼ぶ。
//   c = { h, inS, cost, wait, requested, viewer, triedM, triedP, triedT }
//   k = { S (一覧), era, known, board, traitBad, posts (知っている結果) }
const FEAT_DIM = 20;
const LOG5 = Math.log(5), LOGN = Math.log(NHYP);
function features(c, k, out) {
  const f = out || new Float32Array(FEAT_DIM);
  const n = k.S.length || 1;
  const pt = partition(c.h, k.S);
  f[0] = c.inS ? 1 : 0;
  f[1] = pt.H / LOG5;
  f[2] = pt.worst;
  f[3] = c.inS ? 1 / n : 0;                   // これが正解である確率
  f[4] = Math.log(n) / LOGN;
  f[5] = c.requested ? 1 : 0;                 // 誰かに「君の特性で」と頼まれた
  f[6] = c.viewer ? 1 : 0;                    // 視聴者のアイデア
  f[7] = Math.min(1, c.cost || 0);            // 歩く遠さ (0..1)
  f[8] = Math.min(1, c.wait || 0);            // 時間帯が来るまでの待ち (0..1)
  f[9] = Math.min(1, c.triedM || 0);          // この素材がどれだけ試されたか
  f[10] = Math.min(1, c.triedP || 0);
  f[11] = Math.min(1, c.triedT || 0);
  f[12] = k.traitBad ? 1 : 0;                 // 自分の特性は正解に無いと分かっている
  f[13] = k.era === 0 ? 1 : 0; f[14] = k.era === 1 ? 1 : 0;
  f[15] = k.era === 2 ? 1 : 0; f[16] = k.era === 3 ? 1 : 0;
  f[17] = k.board > 0 ? Math.min(1, k.known / k.board) : 1;   // 掲示板をどれだけ読めているか
  f[18] = 1;
  // 当たりの多かった結果との似かた (民間の知恵が使う手がかり)。Σ(当たり-1)×共有要素 を件数で割る
  let aff = 0;
  const ps = k.posts || [];
  if (ps.length) {
    const d = dec(c.h);
    for (const p of ps) {
      const e = dec(p.h);
      aff += (p.hits - 1) * ((d[0] === e[0]) + (d[1] === e[1]) + (d[2] === e[2]) + (d[3] === e[3]));
    }
    aff /= ps.length * 4;
  }
  f[19] = Math.max(-1, Math.min(1, aff));
  return f;
}

// ═══ 選び方 ═════════════════════════════════════════════════════════════════
let _rnd = Math.random;
const setRng = fn => { _rnd = fn || Math.random; };

// ロジック。smart=false は「矛盾しない候補からランダム」、true は二分木
// (結果が最もよく割れる仮説)。視聴者のアイデアと依頼は、矛盾しなければ先に取る。
//   ★ smart のときも**正解でありうる候補を少し優遇**する。割れ方だけで選ぶと、
//     候補が 2〜3 個に絞れた終盤で「当たる可能性の無い仮説」を選び続けることがある。
function chooseLogic(cands, k, smart, rnd) {
  const R = rnd || _rnd;
  if (!cands.length) return null;
  const pri = cands.filter(c => (c.requested || c.viewer) && c.inS);
  if (pri.length) return pri[Math.floor(R() * pri.length)];
  if (!smart) {
    const inS = cands.filter(c => c.inS);
    const pool = inS.length ? inS : cands;
    return pool[Math.floor(R() * pool.length)];
  }
  const n = k.S.length || 1;
  let best = [], bestSc = -Infinity;
  for (const c of cands) {
    const sc = partition(c.h, k.S).H + (c.inS ? 1 / n : 0) * 2 - (c.cost || 0) * 0.05;
    if (sc > bestSc + 1e-9) { bestSc = sc; best = [c]; }
    else if (Math.abs(sc - bestSc) <= 1e-9) best.push(c);
  }
  return best[Math.floor(R() * best.length)];
}

// 学習した方策 (小さな MLP)。重みは data/tech_policy.json。
//   score = W2 · tanh(W1 · f + b1) + b2 → softmax(score / temp) から引く。
// **配信で ONNX を回さない**制約があるので、推論は素の JS で済む大きさにしてある。
function mlpForward(W, f, hid) {
  const H = W.hidden, D = W.inDim;
  let s = W.b2;
  for (let i = 0; i < H; i++) {
    let z = W.b1[i];
    const row = i * D;
    for (let j = 0; j < D; j++) z += W.W1[row + j] * f[j];
    const a = Math.tanh(z);
    if (hid) hid[i] = a;
    s += W.W2[i] * a;
  }
  return s;
}
function choosePolicy(cands, k, W, temp, rnd) {
  const R = rnd || _rnd;
  if (!cands.length) return null;
  const f = new Float32Array(FEAT_DIM);
  const sc = cands.map(c => mlpForward(W, features(c, k, f)));
  const T = Math.max(1e-3, temp || 1);
  const mx = Math.max(...sc);
  const w = sc.map(s => Math.exp((s - mx) / T));
  let sum = 0; for (const x of w) sum += x;
  let r = R() * sum;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

// 一番よく割れる仮説のうち、**自分の特性では試せないもの**。
// 結果を貼るときに「次は ◯◯ の人に これを頼みたい」として一緒に出す。
function bestRequest(S, myTraits, usableM, usableP) {
  let best = null, bestSc = -Infinity;
  const n = S.length || 1;
  for (let m = 0; m < NM; m++) {
    if (usableM && !usableM[m]) continue;
    for (let p = 0; p < NP; p++) {
      if (usableP && !usableP[p]) continue;
      for (let t = 0; t < NT; t++) {
        if (myTraits.includes(t)) continue;
        for (let tm = 0; tm < NH; tm++) {
          const h = enc(m, p, t, tm);
          const inS = S.includes(h);
          const sc = partition(h, S).H + (inS ? 2 / n : 0);
          if (sc > bestSc) { bestSc = sc; best = h; }
        }
      }
    }
  }
  return best;
}

// ═══ 抽象シミュレーション ═══════════════════════════════════════════════════
// 絵も地図も無い街で「研究の 1 ラウンド」を回す。戦略の比較 (tools/tech-sim.js) と
// 方策の学習 (tools/tech-train.js) の両方がこれを使う。
//   agents  … [{traits:[0..3 の添字], dist:[場所ごとの移動時間(h)]}]
//   share   … 'none' 自分の結果しか知らない / 'visit' 掲示板を見に行ったときだけ /
//             'home' 家に帰れば読める / 'live' いつでも読める
//   choose  … (cands, k, agentIdx) → cand
// 返り値 { hours, exps, decisions:[{feats[], chosen}] (record=true のとき) }
function simulateRound(o) {
  const R = o.rnd || _rnd;
  const answer = o.answer != null ? o.answer : Math.floor(R() * NHYP);
  const A = o.agents;
  const share = o.share || 'live';
  const conc = Math.max(1, o.concurrent || 3);
  const posts = [];
  const known = A.map(() => []);           // 住民ごとに知っている結果の添字
  const hintsAt = o.hintsAt || [];         // [{at:時刻h, slot}] 行き詰まり対策の再現
  const hints = {};
  const tried = { m: new Float32Array(NM), p: new Float32Array(NP), t: new Float32Array(NT) };
  const running = [];                      // {agent, h, doneAt}
  const decisions = [];
  const busy = new Uint8Array(A.length);
  let now = 0, exps = 0;
  const maxExp = o.maxExp || 200;
  const infer = o.infer || 'logic';
  const sync = i => {
    if (share === 'live') { known[i] = posts.map((_, j) => j); return 0; }
    if (share === 'home' && R() < 0.8) { known[i] = posts.map((_, j) => j); return 0; }
    // PC: 掲示板の建物へ寄ってから行く。読めるが、寄り道のぶん時間がかかる
    if (share === 'visit') { if (R() < (o.visitP != null ? o.visitP : VISIT_P)) { known[i] = posts.map((_, j) => j); return 0.6; } return 0; }
    // アナログ: すれ違った誰か 1 人と、知っていることを交換する
    if (share === 'gossip' && A.length > 1 && R() < (o.gossipP != null ? o.gossipP : GOSSIP_P)) {
      const j = (i + 1 + Math.floor(R() * (A.length - 1))) % A.length;
      const u = new Set([...known[i], ...known[j]]);
      known[i] = [...u]; known[j] = [...u];
    }
    return 0;
  };
  const startOne = () => {
    const free = [];
    for (let i = 0; i < A.length; i++) if (!busy[i]) free.push(i);
    if (!free.length) return false;
    const i = free[Math.floor(R() * free.length)];
    const detour = sync(i);
    for (const hh of hintsAt) if (now >= hh.at) hints[hh.slot] = dec(answer)[hh.slot];
    const kp = known[i].map(j => posts[j]);
    const S = knowledgeSet(kp, hints, infer);
    const Sset = new Set(S);
    const myT = A[i].traits;
    const traitBad = !S.some(s => myT.includes(dec(s)[2]));
    const hour = now % 24;
    const cands = [];
    for (let m = 0; m < NM; m++) for (let p = 0; p < NP; p++) for (const t of myT)
      for (let tm = 0; tm < NH; tm++) {
        const h = enc(m, p, t, tm);
        const travel = A[i].dist[p];
        const arrive = (hour + travel) % 24;
        const T = TIMES[tm];
        const wait = arrive >= T.from && arrive < T.to ? 0 : ((T.from - arrive + 24) % 24);
        if (kp.some(p => p.h === h)) continue;                    // 自分が知っている結果は試さない
        if (share === 'live' && running.some(x => x.h === h)) continue;   // スマホ以降は「いま誰が何を試しているか」も見える
        cands.push({ h, inS: Sset.has(h), cost: travel / 3, wait: wait / 24, travel, waitH: wait,
          triedM: tried.m[m] / 6, triedP: tried.p[p] / 6, triedT: tried.t[t] / 6 });
      }
    const k = { S, era: o.era || 0, known: kp.length, board: posts.length, traitBad, posts: kp };
    if (!cands.length) { busy[i] = 1; running.push({ agent: i, h: -1, doneAt: now + 1 }); return true; }
    const c = o.choose(cands, k, i);
    if (o.record) decisions.push({ cands, k, chosen: cands.indexOf(c) });
    busy[i] = 1;
    running.push({ agent: i, h: c.h, doneAt: now + c.travel + c.waitH + 0.5 + detour });
    return true;
  };
  for (let s = 0; s < conc; s++) startOne();
  while (exps < maxExp && now < (o.maxHours || 4000)) {
    running.sort((a, b) => a.doneAt - b.doneAt);
    const r = running.shift();
    if (!r) break;
    now = r.doneAt;
    if (r.h < 0) { busy[r.agent] = 0; startOne(); continue; }   // 試せる仮説が無かった → 少し待ってまた考える
    exps++;
    const [m, p, t] = dec(r.h);
    tried.m[m]++; tried.p[p]++; tried.t[t]++;
    const hh = hits(r.h, answer);
    posts.push({ h: r.h, hits: hh, by: r.agent });
    known[r.agent].push(posts.length - 1);
    busy[r.agent] = 0;
    if (hh === SLOTS) return { hours: now, exps, decisions, solved: true };
    startOne();
  }
  return { hours: now, exps, decisions, solved: false };
}

// ═══ 表示の文字列 ═══════════════════════════════════════════════════════════
function hypLabel(k, h, ja) {
  const R = RESEARCH[k];
  const [m, p, t, tm] = dec(h);
  const M = R.materials[m], P = PLACES[p], T = TRAITS[R.traits[t]], H = TIMES[tm];
  return ja ? `${P.ja}×${M.ja}×${T.ja}×${H.ja}` : `${M.en} / ${P.en} / ${T.en} / ${H.en}`;
}
const hitsMark = (n, ja) => ja ? '●'.repeat(n) + '○'.repeat(SLOTS - n) : `${n}/${SLOTS}`;

module.exports = {
  ERAS, END_YEAR, TRAITS, TRAIT_IDS, PERSONA_TRAITS, RESEARCH, PLACES, TIMES,
  NM, NP, NT, NH, NHYP, SLOTS, enc, dec, hits, consistent, partition,
  ERA_SHARE, ERA_INFER, folkSet, knowledgeSet, chooseFolk, tune,
  FEAT_DIM, features, chooseLogic, choosePolicy, mlpForward, bestRequest,
  simulateRound, traitsOf, hypLabel, hitsMark, setRng,
};
