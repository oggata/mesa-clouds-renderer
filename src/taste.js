// taste.js — 住民の「好み」を、建物の見た目と同じ空間 (MobileCLIP-S0) で持つ。
//
// pref (server.js) は「あの店 (r_c)」という**個々の場所**の評価で、行ったことのある店にしか
// 付かない。taste はその手前の「どういう見た目の店が好きか」で、**行ったことの無い店にも効く**。
// ラーメン屋で良い思いをした人は、初めて見る牛丼屋にも少し惹かれる (見た目が近いから)。
//
// ── 推論はしない ────────────────────────────────────────────────────────────
// 埋め込みは tools/clip/embed.mjs が事前に作った data/clip_emb.json を読むだけ。
// 実行時にやるのは 512 次元の内積を種類の数 (≒30) だけ。three も ONNX も要らない。
//
// ── 好みの持ち方 ────────────────────────────────────────────────────────────
//   taste = normalize( 人柄の文の埋め込み  +  Σ_t w[t] · 建物 t の見た目 )
// 住民が持つのは w (種類ごとの重み、高々30個) だけ。512 次元を丸ごと持たないので
// 保存が小さく、「この人はラーメン屋に +0.4」と中身が読める。
//
// ── 中心化 (modality gap) ───────────────────────────────────────────────────
// CLIP の画像と文の埋め込みは、それぞれ別の円錐に固まっている。生のまま内積を取ると
// どの組でも 0.2 前後になり差が出ない。**種類 (写真/文) ごとに平均を引いてから**
// 正規化すると、「建物どうしの違い」「人どうしの違い」だけが残る。
// それでも絶対値の大きさは当てにならないので、最後に種類の間で z 値にして使う。

'use strict';

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
function meanOf(vecs, dim) {
  const m = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) m[i] += v[i] / vecs.length;
  return m;
}
const centered = (v, m) => normalize(Float32Array.from(v, (x, i) => x - m[i]));
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * json      … data/clip_emb.json
 * typeNames … server.js の BLDG_TYPES の name を typeIdx の順に
 * among     … z 値をとる種類の name (省略で全部)。住民が実際に選び合う場所だけに絞る。
 *              家や学校まで混ぜると、選びもしない種類との比較で z がずれる。
 * cfg       … { learn, wMax, decay }
 */
function createState(json, typeNames, among, cfg) {
  const dim = json.dim;
  const img = [], txt = [];
  for (const n in json.types) (json.types[n].src === 'image' ? img : txt).push(json.types[n].v);
  // 文で代用した種類 (公園など) は、建物の文 (labels) の平均で中心化する
  const mImg = meanOf(img, dim);
  const mTxt = meanOf(txt.length ? Object.values(json.labels) : img, dim);
  const emb = typeNames.map(n => {
    const t = json.types[n];
    return t ? centered(t.v, t.src === 'image' ? mImg : mTxt) : null;
  });
  const people = [...Object.values(json.pool || {}), ...Object.values(json.policy || {})];
  const mPeople = meanOf(people, dim);
  const base = {};
  for (const k in (json.pool || {}))   base['pool:' + k]   = centered(json.pool[k], mPeople);
  for (const k in (json.policy || {})) base['policy:' + k] = centered(json.policy[k], mPeople);
  const inZ = typeNames.map(n => !!json.types[n] && (!among || among.includes(n)));
  return {
    dim, emb, typeNames, base, inZ,
    cfg: Object.assign({ learn: 0.15, wMax: 2, decay: 0.98 }, cfg || {}),
    model: json.model,
  };
}

// 住民の人柄の文。プールの住民は poolId、旧方式の住民は行動モデルの id で引く。
function baseKeyOf(def) {
  if (!def) return null;
  if (def.poolId != null) return 'pool:' + def.poolId;
  return 'policy:' + def.id;
}

// 住民ごとの状態。w だけが本体で、残りは計算の使い回し。
function ensure(S, a) {
  if (!a.taste) a.taste = { w: {} };
  if (!a._tasteBase) a._tasteBase = S.base[baseKeyOf(a.def)] || null;
  return a.taste;
}

/**
 * 種類ごとの「好みの強さ」を z 値で返す (Float32Array, typeIdx 順)。
 * 埋め込みの無い種類は 0。w が変わるまで結果を使い回す。
 */
function scores(S, a) {
  const T = ensure(S, a);
  if (a._tasteZ && a._tasteZ.ver === T.ver) return a._tasteZ.z;
  const v = new Float32Array(S.dim);
  if (a._tasteBase) v.set(a._tasteBase);
  for (const n in T.w) {
    const e = S.emb[S.typeNames.indexOf(n)];
    if (e) for (let i = 0; i < S.dim; i++) v[i] += T.w[n] * e[i];
  }
  normalize(v);
  const raw = S.emb.map(e => (e ? dot(v, e) : NaN));
  const ok = raw.filter((x, i) => S.inZ[i]);
  const mu = ok.reduce((s, x) => s + x, 0) / ok.length;
  const sd = Math.sqrt(ok.reduce((s, x) => s + (x - mu) ** 2, 0) / ok.length) || 1;
  const z = Float32Array.from(raw, x => (Number.isFinite(x) ? (x - mu) / sd : 0));
  a._tasteZ = { ver: T.ver, z };
  return z;
}

/** 行ってみた結果で好みを動かす。reward は learnFromVisit と同じ尺度 (0.5 が「普通」)。 */
function learn(S, a, typeIdx, reward) {
  const n = S.typeNames[typeIdx];
  if (!n || !S.emb[typeIdx]) return;
  const T = ensure(S, a), c = S.cfg;
  const w = (T.w[n] || 0) + c.learn * (reward - 0.5);
  T.w[n] = Math.max(-c.wMax, Math.min(c.wMax, w));
  T.ver = (T.ver || 0) + 1;
}

/** 1日1回。経験で付いた重みを人柄へ少しずつ戻す (pref の PREF_DECAY と同じ役割)。 */
function decay(S, a) {
  const T = a.taste;
  if (!T) return;
  for (const n in T.w) {
    T.w[n] *= S.cfg.decay;
    if (Math.abs(T.w[n]) < 0.01) delete T.w[n];
  }
  T.ver = (T.ver || 0) + 1;
}

/** 好きな種類 / 苦手な種類 (説明用)。only を渡すとその typeIdx だけから選ぶ。 */
function top(S, a, n, only) {
  const z = scores(S, a);
  // ★ z は Float32Array。z.map で添字を作ると結果も型付き配列になり、後の .map(pick) が
  //   オブジェクトを数値に潰して NaN になる。普通の配列で作ること。
  const idx = (only || Array.from(z, (_, i) => i)).filter(i => S.inZ[i]);
  idx.sort((p, q) => z[q] - z[p]);
  const pick = i => ({ name: S.typeNames[i], z: +z[i].toFixed(2) });
  return { like: idx.slice(0, n).map(pick), dislike: idx.slice(-n).reverse().map(pick) };
}

// 保存は w だけ (小数2桁)。人柄の文は data/clip_emb.json から毎回作り直せる。
const serialize = a => (a.taste && Object.keys(a.taste.w).length
  ? Object.fromEntries(Object.entries(a.taste.w).map(([k, v]) => [k, +v.toFixed(2)])) : undefined);
function restore(a, w) {
  a.taste = { w: Object.assign({}, w || {}), ver: 1 };
  a._tasteZ = null;
}

module.exports = { createState, baseKeyOf, scores, learn, decay, top, serialize, restore, normalize, dot };
