#!/usr/bin/env node
// tools/dream-sim.js — 「自分の選択から学ぶ」と「経験の結果から学ぶ」を並べて比べる。
//
// dreamer.js の一番大事な約束 (選択を証拠にしない) が、本当に要るのかを確かめる。
// server.js も three も要らない。好奇心の 1 軸だけを取り出した小さな世界:
//
//   住民 N 人。毎日 K 回出かけ、好奇心 p の確率で「初めての店」、1-p で「いつもの店」。
//   初めての店の良し悪しは**店の側で決まる** (0..1 の一様乱数)。いつもの店は予想どおり。
//
//   naive  … 選んだこと自体を証拠にする。初めての店を選んだ → 好奇心 +、いつもの店 → −
//   dream  … dreamer.js をそのまま使う。初めての店の「結果と期待のずれ」だけが証拠
//
// 使い方:  node tools/dream-sim.js [--days 200] [--n 200] [--seed 1]

'use strict';
const DR = require('../dreamer.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const DAYS = arg('days', 200), N = arg('n', 200), K = arg('k', 6), SEED = arg('seed', 1);

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const CUR = DR.AXES.indexOf('curiosity');
const clamp01 = v => Math.max(0, Math.min(1, v));

function run(mode) {
  const R = mulberry32(SEED);
  const pop = [];
  for (let i = 0; i < N; i++) pop.push({ base: 0.3 + 0.4 * R(), naive: 0 });
  for (let day = 0; day < DAYS; day++) {
    for (const a of pop) {
      const drift = mode === 'naive' ? a.naive : (DR.driftOf(a) ? DR.driftOf(a)[CUR] : 0);
      const p = clamp01(a.base + drift);
      let fresh = 0, usual = 0;
      for (let k = 0; k < K; k++) {
        if (R() < p) {
          fresh++;
          // 店の良し悪しは店の側が決める (期待は dreamer.js が本人の平均から作る)
          if (mode === 'dream') DR.note(a, { kind: 'visit', day, first: true, food: false, reward: R() });
        } else {
          usual++;
          // いつもの店はだいたい予想どおり
          if (mode === 'dream') DR.note(a, { kind: 'visit', day, first: false, food: false, reward: 0.5 + 0.1 * (R() - 0.5) });
        }
      }
      if (mode === 'naive') {
        // dreamer.js と同じ学習率・上限・引き戻しで、証拠だけを「自分の選択」に差し替える
        const n = fresh + usual;
        if (n >= DR.C.minSrc) a.naive += DR.C.lr * Math.tanh(fresh - usual);
        a.naive = Math.max(-DR.C.maxDrift, Math.min(DR.C.maxDrift, a.naive)) * (1 - DR.C.pull);
      } else {
        DR.dream(a, day);
      }
    }
  }
  return pop.map(a => ({ base: a.base, drift: mode === 'naive' ? a.naive : (DR.driftOf(a) ? DR.driftOf(a)[CUR] : 0) }));
}

function report(name, rows) {
  const eff = rows.map(r => clamp01(r.base + r.drift));
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const sd = v => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
  const b = rows.map(r => r.base), d = rows.map(r => r.drift);
  const mb = mean(b), md = mean(d);
  const cov = mean(rows.map(r => (r.base - mb) * (r.drift - md)));
  const corr = sd(d) > 1e-9 ? cov / (sd(b) * sd(d)) : 0;
  const pinned = rows.filter(r => Math.abs(r.drift) >= DR.C.maxDrift * (1 - DR.C.pull) - 1e-3).length / rows.length;
  console.log(`${name.padEnd(6)}  平均|ずれ| ${mean(d.map(Math.abs)).toFixed(3)}  上限に張り付き ${(pinned * 100).toFixed(0).padStart(3)}%`
    + `  土台とずれの相関 ${corr.toFixed(2).padStart(5)}  好奇心のばらつき ${sd(b).toFixed(3)} → ${sd(eff).toFixed(3)}`);
  return { pinned, corr };
}

console.log(`住民${N}人 × ${DAYS}日 × 1日${K}回の外出 (seed ${SEED})\n`);
const n = report('naive', run('naive'));
const d = report('dream', run('dream'));
console.log(`
読み方:
  上限に張り付き … 性格のずれが上限 (±${DR.C.maxDrift}) に貼り付いた人の割合。多いほど暴走している
  土台とずれの相関 … 正なら「もともと好奇心が強い人ほどさらに強くなる」= 自己強化 (偏りの増幅)
  ばらつき       … 増えすぎたら二極化、0 に近づいたら全員が同じ性格に収束`);
if (n.corr > 0.5 && d.corr < 0.3) console.log('\n→ 選択から学ぶと自己強化で二極化し、結果から学ぶとそれが起きない。');
