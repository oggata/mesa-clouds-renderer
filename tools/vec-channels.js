#!/usr/bin/env node
'use strict';
// vec-channels.js — 過ごし方の採点を因子分析して、「暮らし」のチャンネルを見つける。
//
//   node tools/vec-channels.js [--in=data/vec/activities.json] [--out=data/vec/factors.json]
//
// ── 手順 (性格の Big Five と同じ作り方) ──
//   ① 過ごし方 × 記述 の採点表 (data/vec/activities.json)
//   ② 記述どうしの相関行列
//   ③ 固有値分解 (ヤコビ法)。固有値 > 1 の因子を残す (カイザー基準)
//   ④ バリマックス回転 (各因子が少数の記述にだけ強く効くように回して、名前を付けやすくする)
//   ⑤ 因子ごとに負荷の大きい記述を並べ、vec.js のチャンネル定義と突き合わせる
//
// **軸は結果として見つかり、名前は後から付ける。** vec.js に書いた暮らしの 4 チャンネル
// (人と会う / 新しさ / 自然 / 体を動かす) は、この出力を見て決めた。「静けさ」も候補だったが因子として出なかったので外した。
// 採点を直したら回し直して、チャンネルが変わらないかを確かめること。

const fs = require('fs');
const path = require('path');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const IN = arg('in', path.join(__dirname, '..', 'data', 'vec', 'activities.json'));
const OUT = arg('out', path.join(__dirname, '..', 'data', 'vec', 'factors.json'));

const J = JSON.parse(fs.readFileSync(IN, 'utf8'));
const D = J.descriptors, X = J.activities.map(r => r[1]);
const n = X.length, p = D.length;

// ── 相関行列 ──
const mean = D.map((_, j) => X.reduce((s, r) => s + r[j], 0) / n);
const sd = D.map((_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / (n - 1)) || 1);
const Z = X.map(r => r.map((v, j) => (v - mean[j]) / sd[j]));
const R = D.map((_, i) => D.map((_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) / (n - 1)));

// ── ヤコビ法で対称行列の固有値分解 ──
function jacobi(A0) {
  const m = A0.length, A = A0.map(r => r.slice()), V = A.map((_, i) => A.map((_, j) => i === j ? 1 : 0));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) off += A[i][j] ** 2;
    if (off < 1e-12) break;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      if (Math.abs(A[i][j]) < 1e-15) continue;
      const th = (A[j][j] - A[i][i]) / (2 * A[i][j]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < m; k++) {
        const aki = A[k][i], akj = A[k][j];
        A[k][i] = c * aki - s * akj; A[k][j] = s * aki + c * akj;
      }
      for (let k = 0; k < m; k++) {
        const aik = A[i][k], ajk = A[j][k];
        A[i][k] = c * aik - s * ajk; A[j][k] = s * aik + c * ajk;
      }
      for (let k = 0; k < m; k++) {
        const vki = V[k][i], vkj = V[k][j];
        V[k][i] = c * vki - s * vkj; V[k][j] = s * vki + c * vkj;
      }
    }
  }
  return { vals: A.map((r, i) => r[i]), vecs: V };
}
const { vals, vecs } = jacobi(R);
const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
// --k で因子の数を固定できる (カイザー基準の境目にある因子を確かめるとき)
const K = +arg('k', 0) || order.filter(([v]) => v > 1).length;
// 負荷量 L (p × K) = 固有ベクトル × √固有値
let L = D.map((_, j) => order.slice(0, K).map(([v, i]) => vecs[j][i] * Math.sqrt(v)));

// ── バリマックス回転 ──
function varimax(L0, iters = 200) {
  const L = L0.map(r => r.slice()), k = L[0].length, pp = L.length;
  for (let it = 0; it < iters; it++) {
    let changed = 0;
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
      let A = 0, B = 0, C = 0, Dd = 0;
      for (let j = 0; j < pp; j++) {
        const x = L[j][a], y = L[j][b], u = x * x - y * y, v = 2 * x * y;
        A += u; B += v; C += u * u - v * v; Dd += 2 * u * v;
      }
      const num = Dd - 2 * A * B / pp, den = C - (A * A - B * B) / pp;
      const phi = Math.atan2(num, den) / 4;
      if (Math.abs(phi) < 1e-6) continue;
      changed++;
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let j = 0; j < pp; j++) {
        const x = L[j][a], y = L[j][b];
        L[j][a] = c * x + s * y; L[j][b] = -s * x + c * y;
      }
    }
    if (!changed) break;
  }
  return L;
}
L = varimax(L);

// ── 因子ごとに負荷の大きい記述 ──
// vec.js の暮らしのチャンネルと突き合わせるための「その軸らしい記述」
const EXPECT = {
  social:  ['人と話す', '大勢'],
  novelty: ['知らない場所', '初めての体験', '学べる', '非日常'],
  calm:    ['静か', 'くつろぐ', 'ひとり'],
  nature:  ['屋外', '緑や生き物'],
  active:  ['汗をかく', '体力を使う'],
};
const factors = [];
console.log(`過ごし方 ${n} 個 × 記述 ${p} 個 → 固有値 > 1 の因子 ${K} 個`);
console.log('固有値: ' + order.map(([v]) => v.toFixed(2)).join(' '));
for (let f = 0; f < K; f++) {
  let sign = 1;
  const col = D.map((d, j) => [d, L[j][f]]);
  if (col.reduce((s, [, v]) => s + v, 0) < 0) sign = -1;       // 向きを揃える (正の記述が多い側)
  const ranked = col.map(([d, v]) => [d, v * sign]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const top = ranked.filter(([, v]) => Math.abs(v) >= 0.5);
  // チャンネル候補: 期待する記述との重なりが最大のもの
  let bestCh = null, bestHit = 0;
  for (const ch in EXPECT) {
    const hit = EXPECT[ch].reduce((s, d) => { const r = ranked.find(x => x[0] === d); return s + (r && r[1] > 0.4 ? r[1] : 0); }, 0);
    if (hit > bestHit) { bestHit = hit; bestCh = ch; }
  }
  const scores = X.map((r, i) => [J.activities[i][0], Z[i].reduce((s, z, j) => s + z * L[j][f] * sign, 0)])
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
  factors.push({ factor: f + 1, channel: bestCh, loadings: Object.fromEntries(ranked.map(([d, v]) => [d, +v.toFixed(2)])), examples: scores });
  console.log(`\n因子${f + 1} → ${bestCh || '(対応なし)'}`);
  console.log('  強く効く記述: ' + top.map(([d, v]) => `${d}${v > 0 ? '+' : ''}${v.toFixed(2)}`).join('  '));
  console.log('  この因子が高い過ごし方: ' + scores.join(' / '));
}
const covered = new Set(factors.map(f => f.channel).filter(Boolean));
const missing = Object.keys(EXPECT).filter(c => !covered.has(c));
console.log('\nvec.js の暮らしのチャンネルとの対応: ' + [...covered].join(', ')
  + (missing.length ? `  / 因子として出なかった: ${missing.join(', ')}` : '  (期待した軸はすべて因子として出た)'));
fs.writeFileSync(OUT, JSON.stringify({ source: path.relative(path.join(__dirname, '..'), IN), n, descriptors: D,
  eigenvalues: order.map(([v]) => +v.toFixed(3)), factors, missing }, null, 1));
console.log(`→ ${path.relative(process.cwd(), OUT)}`);
