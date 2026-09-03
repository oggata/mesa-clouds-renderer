#!/usr/bin/env node
'use strict';
// pastime-report.js — 暇な時間の娯楽の一覧と、選ばれ方の偏りを出す。
//
//   node tools/pastime-report.js [--n=200000]
//
// **なぜ要るか。** 娯楽は条件 (時刻・天気・屋内屋外・自宅か・相手の人数) で
// 絞り込まれるので、条件を書き間違えると**一度も選ばれない項目**ができる。
// 街を眺めていても気づけないので、選択ロジックだけをここで回して確かめる。

const PT = require('../pastime.js');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? parseFloat(a.split('=')[1]) : d; };
const N = arg('n', 200000);

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)));

console.log(`娯楽 ${PT.ACTS.length} 種類`);
console.log(pad('id', 12) + pad('名前', 24) + pad('場所', 8) + pad('人数', 6) + pad('時間帯', 8) + '長さ(秒)');
for (const A of PT.ACTS)
  console.log(pad(A.id, 12) + pad(A.ja, 24) + pad(A.where, 8) + pad(A.group, 6)
    + pad(A.when || (A.wx ? A.wx : '-'), 8) + `${A.secs[0]}-${A.secs[1]}`);

// いろいろな状況を混ぜて抽選し、全項目が出てくるかを見る
const count = {};
let none = 0;
for (let i = 0; i < N; i++) {
  const indoors = Math.random() < 0.35;
  const A = PT.pick({
    hour: Math.random() * 24, raining: Math.random() < 0.2, indoors,
    atHome: indoors && Math.random() < 0.5,
    mates: Math.random() < 0.4 ? 1 + ((Math.random() * 2) | 0) : 0,
  });
  if (!A) { none++; continue; }
  count[A.id] = (count[A.id] || 0) + 1;
}
const missing = PT.ACTS.filter(a => !count[a.id]);
console.log(`\n${N.toLocaleString()} 回の抽選: ${Object.keys(count).length}/${PT.ACTS.length} 種類が出現 / 候補なし ${none}`);
const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
console.log('多い: ' + sorted.slice(0, 4).map(([k, v]) => `${k} ${(v / N * 100).toFixed(1)}%`).join(' / '));
console.log('少ない: ' + sorted.slice(-4).map(([k, v]) => `${k} ${(v / N * 100).toFixed(2)}%`).join(' / '));
if (missing.length) {
  console.log('✘ 一度も選ばれない項目があります: ' + missing.map(a => a.id).join(', '));
  console.log('  条件 (where / when / wx / group) が厳しすぎないか確かめてください。');
  process.exitCode = 1;
} else console.log('✔ すべての項目が選ばれます。');
