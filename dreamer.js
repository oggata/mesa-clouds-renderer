// dreamer.js — 住民の「夜の振り返り」。経験の結果から性格を少しずつ動かす。
//
// ── なぜ要るか ──
// 住民の性格 (traitsOf の 8 軸) は生まれたときに決まり、一生変わらなかった。
// 300日生きた住民も 1日目の住民も同じ性格で、**経験が人を変えない**。
// ここでは Honcho (plastic-labs/honcho) の Dreamer に倣って、その日に溜まった
// 経験を夜にまとめて振り返り、性格のずれ (drift) を少しだけ更新する。
//
// ── いちばん大事な約束: 自分の選択からは学ばない ──
// 住民の選択は性格から作られている。選択を証拠にすると
//     性格 → 選択 → 「そういう性格だ」→ 性格が強まる → …
// の輪になり、サイコロの偏りが増幅されて全員が極端な性格へ流れる
// (tools/dream-sim.js で実際に確かめられる)。
// Honcho の自己学習が暴走しないのは、結論が必ず**ユーザーの発言まで遡れる**からで、
// Honcho が何を結論してもユーザーの次の発言は変わらない。mesa でそれに当たるのは
// **世界の側が決めた結果**だけ:
//     店が良かったか (混雑・集積は店の側で決まる)、財布が戻ってきたか (拾った人が決める)、
//     昇給したか、雨に降られたか、応援されたか (視聴者が決める)、友達ができたか。
// なので server.js からは「結果」だけを note() に渡すこと。**本人が正直さで分岐した
// 行動 (財布を届けた / 黙っていた) は渡さない** — それは本人の性格が選んだものだから。
//
// ── Honcho の Dreamer から借りた縛り ──
//   根拠を残す   … 変化にはその根拠になった経験 (id と一行) を必ず紐付ける
//   根拠 2 件以上 … 1回の偶然では性格を動かさない (Honcho の induction と同じ)
//   確信度       … 根拠の数で決める (2=low, 3-4=medium, 5+=high)
//   意外性優先   … 期待と結果のずれ (surprise) が大きい経験ほど強く効く
//   矛盾         … 同じ軸に良い結果と悪い結果が拮抗していたら動かさず、印だけ残す
//   土台        … 生まれつきの性格 (peer card に当たる) は変えない。ずれは別に持ち、
//                  毎晩少しずつ土台へ引き戻す (全員が同じ性格に収束するのも防ぐ)
//
// ── server.js に依存しない ──
// chronicle.js と同じ。乱数も引かない (決定性を壊さない)。

'use strict';

// traitsOf() の並びと一致させること (server.js の traitsOf)。
const AXES = ['curiosity', 'gourmet', 'sociability', 'diligence', 'thrift', 'enterprise', 'honesty', 'homebody'];
const AX = Object.fromEntries(AXES.map((k, i) => [k, i]));

// 動かす軸。enterprise / honesty は起業と犯罪が a.def から直接読んでいて、
// ここで動かしても traitsOf 経由の観測にしか効かず、見かけと中身がずれるので外す。
const EVOLVE = new Set(['curiosity', 'gourmet', 'sociability', 'diligence', 'thrift', 'homebody']);

const C = {
  lr:        0.06,   // 1晩で動く量の基準 (確信度 high・根拠が一方向に揃ったとき)
  maxDrift:  0.25,   // 土台からのずれの上限。性格が別人になるほどは動かさない
  pull:      0.03,   // 毎晩、ずれを土台へ戻す割合 (時間が経てば経験は薄れる)
  minSrc:    2,      // 1軸を動かすのに要る根拠の数
  contra:    0.6,    // 良い結果と悪い結果の比がこれを超えたら「矛盾」として動かさない
  surpMin:   0.15,   // これより小さい意外性の経験は証拠にしない (予想どおり = 情報が無い)
  keepDays:  3,      // 根拠が足りない軸の経験を何晩まで持ち越すか
  pendCap:   64,     // 持ち越す経験の上限
  insCap:    8,      // 覚えておく気づきの数
  rwRate:    0.2,    // 「いつもの外出はこれくらい」(来店の採点の移動平均) の追従の速さ
  band:      0.05,   // ずれがこの刻みを新しく越えた晩だけ来歴に一行残す (毎晩書くと来歴が埋まる)
};

// ── 経験 → 性格の軸 ─────────────────────────────────────────────────────────
// 値は「良い結果だったときにその軸がどちらへ動くか」。
// 出来事 (events.js) は**本人に降ってきたもの**だけを並べる。
const EVENT_AXES = {
  raise:       { diligence: +1 },
  praised:     { diligence: +1 },
  work_win:    { diligence: +1 },
  work_fail:   { diligence: -1 },
  wallet_lost: { thrift: +1 },
  scam:        { thrift: +1 },
  bonus:       { thrift: -1 },
  found_coin:  { thrift: -0.5 },
  nice_walk:   { homebody: -1 },
  stars_night: { homebody: -1 },
  cat_met:     { homebody: -0.5 },
  soaked:      { homebody: +1 },
  bike_flat:   { homebody: +0.5 },
  closed_shop: { homebody: +0.5 },
  bad_meal:    { gourmet: -1 },
  free_sample: { gourmet: +0.5 },
  helped:      { sociability: +1 },
  reunion:     { sociability: +1 },
  treated:     { sociability: +1 },
  argument:    { sociability: -1 },
  // 連鎖の「返ってきた側」(backGood)。拾った人・助けた人が決めたこと = 本人の外の結果
  wallet_back: { sociability: +1 },
  helped_back: { sociability: +1 },
};

// 気づきの言い回し (来歴に残す一行)。[上がったとき, 下がったとき]
const PHRASE = {
  curiosity:   [['新しい店を開拓するのが楽しくなってきた', 'is enjoying trying new places'],
                ['新しい店にはあまり期待しなくなった', 'expects less from new places']],
  gourmet:     [['食べることがますます好きになった', 'is getting more into food'],
                ['食事にはこだわらなくなってきた', 'cares less about food lately']],
  sociability: [['人と過ごすのが前より好きになった', 'is warming up to people'],
                ['人付き合いに少し慎重になった', 'is more guarded with people']],
  diligence:   [['仕事に張り合いが出てきた', 'feels motivated at work'],
                ['仕事への熱が少し冷めた', 'is losing steam at work']],
  thrift:      [['お金に慎重になった', 'is more careful with money'],
                ['お金に少しおおらかになった', 'is looser with money']],
  homebody:    [['家で過ごすほうが落ち着くようになった', 'is happier staying home'],
                ['外に出るのが前より好きになった', 'is enjoying going out more']],
};

// ── 状態 ────────────────────────────────────────────────────────────────────
function state(a) {
  return a.dx || (a.dx = { drift: new Array(AXES.length).fill(0), band: new Array(AXES.length).fill(0),
                           pend: [], ins: [], seq: 0 });
}

/** traitsOf の土台に足すずれ (無ければ null)。 */
function driftOf(a) { return a.dx ? a.dx.drift : null; }

/**
 * 経験を 1 件積む。**判断はしない** (夜の dream() がまとめて行う)。
 *   ev = { kind, day, label, ... }
 *     kind='visit' : { first, food, reward }  来店の結果 (reward は世界が決めた採点)
 *                    期待はその人の「いつもの外出」の移動平均。expect を渡せば上書きできる
 *     kind='event' : { id }                           events.js の出来事 (本人に降ってきたもの)
 *     kind='friend' / 'feud' / 'cheer' / 'repaid'     人づきあいの結果
 * 戻り値: 積んだ経験 (証拠にならないものは null)
 */
function note(a, ev) {
  if (!a || !ev) return null;
  const S = state(a);
  if (ev.kind === 'visit') {
    // ★ 期待は**本人のいつもの外出**と比べる。固定値 (0.5) と比べると、採点の平均が
    //   0.5 より低い街では初めての店が全員にとって「外れ」になり、全員の好奇心が
    //   下がり出不精が上がった (早送り40日で実測: 好奇心は全員マイナス、出不精は全員プラス)。
    //   本人の平均と比べれば意外性は人ごとに平均 0 になり、動くのは街が本当に
    //   変わったとき (良くなった/悪くなった) と、本当に当たり外れを引いたときだけ。
    const r = +ev.reward || 0;
    if (ev.expect == null) ev = { ...ev, expect: S.rw == null ? r : S.rw };
    S.rw = S.rw == null ? r : S.rw + C.rwRate * (r - S.rw);
  }
  const w = weights(ev);
  if (!w) return null;
  const e = { id: ++S.seq, day: ev.day | 0, label: String(ev.label || ev.kind).slice(0, 40), w };
  S.pend.push(e);
  while (S.pend.length > C.pendCap) S.pend.shift();
  return e;
}

// 経験 → { 軸: 符号付きの強さ }。意外性の小さい経験は null (証拠にしない)。
function weights(ev) {
  const out = {};
  const add = (k, v) => { if (EVOLVE.has(k) && v) out[k] = (out[k] || 0) + v; };
  switch (ev.kind) {
    case 'visit': {
      // 意外性 = 結果 − 期待。予想どおりの外出は情報が無いので証拠にしない。
      const s = (+ev.reward || 0) - (+ev.expect || 0);
      if (Math.abs(s) < C.surpMin) return null;
      if (ev.first) add('curiosity', s);
      if (ev.food) add('gourmet', s);
      add('homebody', -0.5 * s);             // 良い外出は出不精を和らげる
      break;
    }
    case 'event': {
      const m = EVENT_AXES[ev.id];
      if (!m) return null;
      for (const k in m) add(k, m[k]);
      break;
    }
    // 友達・応援は「何人目か」で割る。できたばかりの街では誰もが1日に何人も
    // 友達を作るので、そのまま数えると**全員の社交性が上限へ揃って**しまう
    // (早送り20日で実測: 平均 +0.09 / 3日)。最初の友達は大きな出来事、10人目は日常。
    case 'friend': add('sociability', 1 / (1 + Math.max(0, ev.had | 0))); break;
    case 'feud':   add('sociability', -1); break;
    case 'cheer':  add('sociability', 0.5 / (1 + Math.max(0, ev.had | 0))); break;   // 視聴者に応援された
    case 'repaid': add('sociability', +0.5); break;   // 貸したお金が返ってきた
    default: return null;
  }
  return Object.keys(out).length ? out : null;
}

const confOf = n => n >= 5 ? ['high', 1] : n >= 3 ? ['medium', 0.75] : ['low', 0.5];

/**
 * 夜の振り返り。1 人ぶん。
 * 戻り値: { changed:[{axis, delta, conf, src}], contra:[axis], notes:[{ja,en}] }
 */
function dream(a, day) {
  const S = state(a);
  const res = { changed: [], contra: [], notes: [] };
  // 軸ごとに根拠を集める
  const by = {};
  for (const e of S.pend) for (const k in e.w) (by[k] || (by[k] = [])).push(e);
  const used = new Set();
  for (const k in by) {
    const L = by[k];
    if (L.length < C.minSrc) continue;               // 1回の偶然では動かさない
    let pos = 0, neg = 0;
    for (const e of L) { const v = e.w[k]; if (v > 0) pos += v; else neg -= v; }
    for (const e of L) used.add(e);
    const big = Math.max(pos, neg), small = Math.min(pos, neg);
    if (big <= 0) continue;
    if (small / big > C.contra) {                    // 良い結果と悪い結果が拮抗 → 動かさない
      res.contra.push(k);
      pushIns(S, { day, axis: k, delta: 0, conf: 'contradiction', src: L.map(srcOf) });
      continue;
    }
    const [conf, cw] = confOf(L.length);
    const i = AX[k];
    const before = S.drift[i];
    const delta = C.lr * cw * Math.tanh(pos - neg);
    S.drift[i] = Math.max(-C.maxDrift, Math.min(C.maxDrift, before + delta));
    const d = S.drift[i] - before;
    if (!d) continue;
    res.changed.push({ axis: k, delta: d, conf, src: L.map(srcOf) });
    pushIns(S, { day, axis: k, delta: +d.toFixed(4), conf, src: L.map(srcOf) });
  }
  // 使った経験は捨てる。根拠が足りなかった経験は keepDays まで持ち越す
  S.pend = S.pend.filter(e => !used.has(e) && day - e.day < C.keepDays);
  // 土台へ少し戻す
  for (let i = 0; i < S.drift.length; i++) S.drift[i] *= (1 - C.pull);
  // 来歴に残す一行。ずれが新しい刻み (band) を越えた軸のうち、いちばん大きいものだけ。
  //   刻みを戻ったときは黙って下げる (「元に戻った」は物語として弱いので書かない)。
  let top = null;
  for (let i = 0; i < S.drift.length; i++) {
    const b = Math.trunc(S.drift[i] / C.band);
    if (Math.abs(b) > Math.abs(S.band[i]) && PHRASE[AXES[i]]) {
      if (!top || Math.abs(S.drift[i]) > Math.abs(S.drift[top])) top = i;
    }
    if (Math.abs(b) < Math.abs(S.band[i]) || Math.sign(b) !== Math.sign(S.band[i])) S.band[i] = b;
  }
  if (top != null) {
    S.band[top] = Math.trunc(S.drift[top] / C.band);
    const [ja, en] = PHRASE[AXES[top]][S.drift[top] > 0 ? 0 : 1];
    res.notes.push({ ja, en, axis: AXES[top] });
  }
  return res;
}
const srcOf = e => ({ id: e.id, day: e.day, label: e.label });
function pushIns(S, x) { S.ins.push(x); while (S.ins.length > C.insCap) S.ins.shift(); }

/** 表示用: いまのずれと最近の気づき。 */
function describe(a) {
  const S = a.dx;
  if (!S) return { drift: {}, pending: 0, insights: [] };
  const drift = {};
  AXES.forEach((k, i) => { if (Math.abs(S.drift[i]) >= 0.005) drift[k] = +S.drift[i].toFixed(3); });
  return { drift, pending: S.pend.length, insights: S.ins.slice().reverse() };
}

// ── 保存 ────────────────────────────────────────────────────────────────────
// ずれと気づきだけ残す。持ち越し中の経験は数日で消えるものなので保存しない。
function serialize(a) {
  const S = a.dx;
  if (!S || !S.drift.some(v => Math.abs(v) >= 0.001)) return undefined;
  return { d: S.drift.map(v => +v.toFixed(4)), b: S.band, i: S.ins.length ? S.ins : undefined, s: S.seq,
           rw: S.rw == null ? undefined : +S.rw.toFixed(3) };
}
function restore(a, sv) {
  if (!sv || !Array.isArray(sv.d)) return;
  const S = state(a);
  sv.d.forEach((v, i) => { if (i < S.drift.length && Number.isFinite(+v)) S.drift[i] = +v; });
  if (Array.isArray(sv.b)) sv.b.forEach((v, i) => { if (i < S.band.length) S.band[i] = v | 0; });
  if (Array.isArray(sv.i)) S.ins = sv.i.slice(-C.insCap);
  S.seq = sv.s | 0;
  if (Number.isFinite(+sv.rw)) S.rw = +sv.rw;
}

module.exports = { AXES, EVOLVE, C, EVENT_AXES, note, weights, dream, driftOf, describe, serialize, restore };
