#!/usr/bin/env node
'use strict';
// tech-train.js — 研究の「どの仮説を試すか」を強化学習で学ぶ (ポリシーモード)。
//
//   node tools/tech-train.js [--episodes=3000] [--hidden=16] [--out=data/tech_policy.json]
//
// ── 何を学ぶか ──
// ロジックモードは「結果が最もよく割れる仮説」(二分木) を選ぶ。これは実験の**回数**を
// 減らすが、**歩く遠さと時間帯の待ち**をほとんど見ていない。街の中では、遠い店の朝を
// 狙って半日待つより、近くの店でいま試すほうが早く発明に届くことがある。
// 方策は tech.js の特徴量 (割れ方・遠さ・待ち・依頼・掲示板の既読…) から、
// **発明までの街の時間**が短くなる選び方を学ぶ。
//
// ── なぜ Colab ではなく Node なのか ──
// 方策は 19→16→1 の MLP で、推論は素の JS で回る (配信で ONNX を回さない制約)。
// 学習も同じ tech.js の環境を呼ぶので、**特徴量の定義が学習と本番で 1 本**になる。
// (階層方策で踏んだ「notebook と server の世界の不一致」をここでは起こさない。)
//
// ── 学習則 ──
// REINFORCE + Adam。報酬は 1 ラウンドの -時間 (チーム全体で共有)。ベースラインは
// 掲示板の共有モードごとの移動平均。候補の数が毎回違うので、各候補のスコアを
// softmax したものを方策とする (候補がいくつでも出力の形が変わらない)。
//
// ── 検証 ──
// 学習に使っていない種で、時代ごとに「その時代のロジック」と policy を比べる
// (課題は同じ。違うのは情報の伝わり方と推論の強さ)。**どこかの時代で policy のコストが
// ロジックより大きければ passed=false** になり、server.js が起動時に警告を出す。

const fs = require('fs');
const path = require('path');
const T = require('../tech.js');

const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const EPISODES = +arg('episodes', 3000), H = +arg('hidden', 16);
const LR = +arg('lr', 0.01), TEMP = +arg('temp', 0.5), NVAL = +arg('val', 300);
const OUT = arg('out', path.join(__dirname, '..', 'data', 'tech_policy.json'));
const D = T.FEAT_DIM;
// 報酬の「コスト」= 街の時間 + 実験 1 回ぶんの重み。server.js では 1 日に実験できる回数に上限
// (TECH_EXP_PER_DAY=2) があるので、**実験の回数そのものが一番きつい資源**になる。時間だけを
// 減らすように学習すると、実験を多く使って本番ではかえって遅くなった (実測)。
const EXP_H = +arg('exp-hours', 8);
const costOf = r => (r.hours + r.exps * EXP_H) * (r.solved ? 1 : 1.5);

function mulberry(seed) {
  let s = seed | 0;
  return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function makeAgents(R, n) {
  const A = [];
  for (let i = 0; i < n; i++) {
    const t = [Math.floor(R() * 4)];
    if (R() < 0.35) { const u = Math.floor(R() * 4); if (u !== t[0]) t.push(u); }
    A.push({ traits: t, dist: [0.2, ...[0, 0, 0, 0].map(() => 0.3 + R() * 2.2)] });
  }
  return A;
}
// 1 ラウンドの設定。掲示板の共有モードと時代は対応させる (アナログ=見に行く …)。
function setupOf(R) {
  const agents = makeAgents(R, 3 + Math.floor(R() * 6));
  const answer = Math.floor(R() * T.NHYP);
  const need = T.dec(answer)[2];
  if (!agents.some(a => a.traits.includes(need))) agents[0].traits.push(need);
  // 時代ごとの「情報の伝わり方 × 推論の強さ」(tech.js の ERA_SHARE / ERA_INFER)。課題は同じ
  const era = Math.floor(R() * 4);
  return { agents, answer, era, share: T.ERA_SHARE[era], infer: T.ERA_INFER[era],
           concurrent: 1 + Math.floor(R() * 3), maxExp: 400 };
}

// ── 重み ──
const initR = mulberry(7);
const W = { inDim: D, hidden: H, temp: TEMP,
  W1: Array.from({ length: H * D }, () => (initR() * 2 - 1) * 0.3),
  b1: new Array(H).fill(0),
  W2: Array.from({ length: H }, () => (initR() * 2 - 1) * 0.3),
  b2: 0 };
const KEYS = ['W1', 'b1', 'W2'];
const m1 = {}, m2 = {};
for (const k of KEYS) { m1[k] = new Float64Array(W[k].length); m2[k] = new Float64Array(W[k].length); }
let adamT = 0;
function adam(grad) {
  adamT++;
  const b1 = 0.9, b2 = 0.999;
  for (const k of KEYS) {
    const g = grad[k], w = W[k];
    for (let i = 0; i < w.length; i++) {
      m1[k][i] = b1 * m1[k][i] + (1 - b1) * g[i];
      m2[k][i] = b2 * m2[k][i] + (1 - b2) * g[i] * g[i];
      const mh = m1[k][i] / (1 - b1 ** adamT), vh = m2[k][i] / (1 - b2 ** adamT);
      w[i] += LR * mh / (Math.sqrt(vh) + 1e-8);      // 勾配**上昇** (報酬を増やす向き)
    }
  }
}

// 1 決定ぶんの ∇ log π(chosen) を grad に足し込む (係数 coef をかけて)
const hid = new Float64Array(H);
function accumulate(dcs, coef, grad) {
  const { cands, k, chosen } = dcs;
  const n = cands.length;
  const F = cands.map(c => T.features(c, k));
  const S = new Float64Array(n), Hs = [];
  for (let i = 0; i < n; i++) {
    S[i] = T.mlpForward(W, F[i], hid);
    Hs.push(Float64Array.from(hid));
  }
  let mx = -Infinity; for (const s of S) if (s > mx) mx = s;
  let z = 0; const pi = new Float64Array(n);
  for (let i = 0; i < n; i++) { pi[i] = Math.exp((S[i] - mx) / TEMP); z += pi[i]; }
  for (let i = 0; i < n; i++) pi[i] /= z;
  // d logπ / d s_i = (1[i=chosen] - π_i) / T
  for (let i = 0; i < n; i++) {
    const ds = ((i === chosen ? 1 : 0) - pi[i]) / TEMP * coef;
    if (Math.abs(ds) < 1e-7) continue;
    const h = Hs[i], f = F[i];
    for (let a = 0; a < H; a++) {
      grad.W2[a] += ds * h[a];
      const dz = ds * W.W2[a] * (1 - h[a] * h[a]);
      grad.b1[a] += dz;
      const row = a * D;
      for (let j = 0; j < D; j++) grad.W1[row + j] += dz * f[j];
    }
  }
}

// ── ① 模倣 (その時代のロジックの選び方を真似る) ──
//   REINFORCE をゼロから始めると、民間の知恵にすら届かないところで止まった (実測: アナログで
//   コスト 673 vs ロジック 429)。まずロジックを真似て同じ所まで来てから、② で強化する。
//   「住民が経験からポリシーを強化していく」形にもなる。
const BC = +arg('bc', 1500);
const t0 = Date.now();
const logicChooser = (era, R) => T.ERA_INFER[era] === 'logic'
  ? (c, k) => T.chooseLogic(c, k, true, R) : (c, k) => T.chooseFolk(c, k, R);
for (let ep = 1; ep <= BC; ep++) {
  const R = mulberry(500000 + ep);
  const setup = setupOf(R);
  const res = T.simulateRound({ rnd: R, ...setup, record: true, choose: logicChooser(setup.era, R) });
  const grad = { W1: new Float64Array(H * D), b1: new Float64Array(H), W2: new Float64Array(H) };
  const coef = 1 / Math.max(1, res.decisions.length);
  for (const d of res.decisions) if (d.chosen >= 0) accumulate(d, coef, grad);
  adam(grad);
  if (ep % 500 === 0) console.log(`模倣 ${ep}/${BC}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ── ② 強化 ──
const base = {};
let win = [];
for (let ep = 1; ep <= EPISODES; ep++) {
  const R = mulberry(100000 + ep);
  const setup = setupOf(R);
  const res = T.simulateRound({ rnd: R, ...setup, record: true,
    choose: (c, k) => T.choosePolicy(c, k, W, TEMP, R) });
  const cost = costOf(res);                                 // 解けなかった回は重く罰する
  const key = 'e' + setup.era;
  if (base[key] == null) { base[key] = cost; continue; }
  const adv = (base[key] - cost) / 40;
  base[key] = base[key] * 0.98 + cost * 0.02;
  const grad = { W1: new Float64Array(H * D), b1: new Float64Array(H), W2: new Float64Array(H) };
  const coef = adv / Math.max(1, res.decisions.length);
  for (const d of res.decisions) accumulate(d, coef, grad);
  adam(grad);
  win.push(cost);
  if (ep % 250 === 0) {
    const avg = win.reduce((a, x) => a + x, 0) / win.length;
    console.log(`ep ${String(ep).padStart(5)}  直近の平均 ${avg.toFixed(1)}h  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    win = [];
  }
}

// ── 検証 (学習に使っていない種) ──
function evaluate(name, era) {
  let hours = 0, exps = 0, uns = 0, cost = 0;
  for (let e = 0; e < NVAL; e++) {
    const R = mulberry(900000 + e);
    const setup = setupOf(R);
    setup.era = era; setup.share = T.ERA_SHARE[era]; setup.infer = T.ERA_INFER[era];
    // logic = その時代のロジックモード (AI 以前は民間の知恵、AI は二分木)
    const ch = name === 'logic' ? (T.ERA_INFER[era] === 'logic' ? (c, k) => T.chooseLogic(c, k, true, R)
                                                               : (c, k) => T.chooseFolk(c, k, R))
             : (c, k) => T.choosePolicy(c, k, W, TEMP, R);
    const r = T.simulateRound({ rnd: R, ...setup, choose: ch });
    hours += r.hours; exps += r.exps; cost += costOf(r); if (!r.solved) uns++;
  }
  return { hours: +(hours / NVAL).toFixed(1), exps: +(exps / NVAL).toFixed(1), cost: +(cost / NVAL).toFixed(1), unsolved: uns };
}
const validation = {};
const ERA_NAME = ['analog', 'pc', 'mobile', 'ai'];
console.log('\n検証 (学習に使っていない種)   時間(h) / 実験回数');
for (let era = 0; era < 4; era++) {
  const v = validation[ERA_NAME[era]] = { share: T.ERA_SHARE[era], infer: T.ERA_INFER[era] };
  for (const name of ['logic', 'policy']) v[name] = evaluate(name, era);
  console.log(`  ${ERA_NAME[era].padEnd(7)} ${v.share.padEnd(6)} ${v.infer.padEnd(5)}  logic ${v.logic.exps}回/${v.logic.hours}h (コスト${v.logic.cost})  policy ${v.policy.exps}回/${v.policy.hours}h (コスト${v.policy.cost})`);
}
const passed = ERA_NAME.every(e => validation[e].policy.cost <= validation[e].logic.cost);
console.log(passed ? '\n✅ policy はすべての時代でロジック以下の時間で発明に届いた'
                   : '\n⚠ policy がロジックより遅い時代がある (passed=false)');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  kind: 'tech-policy', version: 2, features: D, inDim: D, hidden: H, temp: TEMP, expHours: EXP_H,
  W1: W.W1.map(v => +v.toFixed(5)), b1: W.b1.map(v => +v.toFixed(5)),
  W2: W.W2.map(v => +v.toFixed(5)), b2: 0,
  trainedEpisodes: EPISODES, trainedAt: new Date().toISOString(),
  validation: Object.assign({ passed }, validation),
}, null, 1));
console.log(`→ ${path.relative(process.cwd(), OUT)}`);
