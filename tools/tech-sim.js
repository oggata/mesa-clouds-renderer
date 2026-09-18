#!/usr/bin/env node
'use strict';
// tech-sim.js — 時代ごとの「情報の伝わり方 × 推論の強さ」で、同じ課題がどれだけ速く解けるかを比べる。
//
//   node tools/tech-sim.js [--n=300] [--agents=6] [--concurrent=3] [--policy=data/tech_policy.json]
//
// **課題は全時代で同じ** (tech.js の 480 通り)。変わるのは住民の道具だけ:
//   アナログ  gossip × folk   すれ違った人とだけ交換 / 民間の知恵
//   PC        visit  × folk   掲示板の建物へ読みに行く / 民間の知恵
//   スマホ    live   × folk   いつでも読める / 民間の知恵
//   AI        live   × logic  いつでも読める / 論理的に絞る + 二分木
// 見るもの: 1 段の発明までの実験回数 (= 試した組み合わせ) と街の時間。

const path = require('path');
const fs = require('fs');
const T = require('../tech.js');

const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const N = +arg('n', 300), NA = +arg('agents', 6), CONC = +arg('concurrent', 3);
const polPath = arg('policy', path.join(__dirname, '..', 'data', 'tech_policy.json'));
const W = fs.existsSync(polPath) ? JSON.parse(fs.readFileSync(polPath, 'utf8')) : null;

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
const ERA_JA = ['アナログ', 'PC', 'スマホ', 'AI'];

function run(era, mode) {
  const share = T.ERA_SHARE[era], infer = T.ERA_INFER[era];
  let exps = 0, hours = 0, unsolved = 0;
  for (let e = 0; e < N; e++) {
    const R = mulberry(1000 + e);
    const agents = makeAgents(R, NA);
    const answer = Math.floor(R() * T.NHYP);
    const need = T.dec(answer)[2];
    if (!agents.some(a => a.traits.includes(need))) agents[0].traits.push(need);
    const choose = mode === 'policy' ? (c, k) => T.choosePolicy(c, k, W, W.temp || 0.5, R)
                 : infer === 'logic' ? (c, k) => T.chooseLogic(c, k, true, R)
                 : (c, k) => T.chooseFolk(c, k, R);
    const r = T.simulateRound({ rnd: R, agents, answer, share, infer, concurrent: CONC, era, choose, maxExp: 400 });
    exps += r.exps; hours += r.hours; if (!r.solved) unsolved++;
  }
  return { exps: +(exps / N).toFixed(1), hours: +(hours / N).toFixed(1), unsolved };
}

console.log(`時代ごとの研究の速さ (課題は同じ)  n=${N} 住民=${NA} 同時に実験=${CONC}`);
console.log('');
console.log('時代      共有    推論    | ロジック 実験/時間     | ポリシー 実験/時間');
const out = {};
for (let era = 0; era < 4; era++) {
  const lg = run(era, 'logic');
  const pl = W ? run(era, 'policy') : null;
  out[ERA_JA[era]] = { logic: lg, policy: pl };
  console.log(`${ERA_JA[era].padEnd(6)}  ${T.ERA_SHARE[era].padEnd(6)}  ${T.ERA_INFER[era].padEnd(5)}  |`
    + `  ${String(lg.exps).padStart(6)}回 ${String(lg.hours).padStart(7)}h 未解決${lg.unsolved}`
    + (pl ? `  |  ${String(pl.exps).padStart(6)}回 ${String(pl.hours).padStart(7)}h 未解決${pl.unsolved}` : ''));
}
console.log('\n[TechSimJSON] ' + JSON.stringify(out));
