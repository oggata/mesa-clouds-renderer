#!/usr/bin/env node
'use strict';
// event-report.js — 良いこと・悪いことの一覧と、実際の発生率を出す。
//
//   node tools/event-report.js [--mean=25] [--n=400000]
//
// **いちばん確かめたいのは病気の発症率。** 発症は元々 stepNeeds の中に
// SICK_PROB = 1/(60*90) (平均90分に1回・疲労で最大2倍) と書かれていた。
// events.js へ移すときにここがズレると、病院の需要が変わって街の育ち方まで
// 変わってしまう。重みから逆算した発症間隔をここで突き合わせる。

const EV = require('../events.js');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? parseFloat(a.split('=')[1]) : d; };
const MEAN = arg('mean', 25);      // イベントが起きる平均間隔 (分/人)
const N    = arg('n', 400000);
const SICK_PROB = 1 / (60 * 90);   // 元の実装

const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)));
console.log(`イベント ${EV.EVENTS.length} 種類 (良い ${EV.EVENTS.filter(e => e.good).length} / 悪い ${EV.EVENTS.filter(e => !e.good).length})`);
console.log(w('id', 14) + w('内容', 26) + w('良悪', 6) + w('重み', 6) + w('条件', 22) + '見出し');
for (const E of EV.EVENTS)
  console.log(w(E.id, 14) + w(E.ja, 26) + w(E.good ? '良' : '悪', 6) + w(E.w, 6)
    + w(E.req.join(',') || '-', 22) + (E.news ? 'あり' : ''));

// いろいろな状況を混ぜて抽選し、各イベントの出現率を測る
const count = {}; let none = 0;
for (let i = 0; i < N; i++) {
  const indoors = Math.random() < 0.35;
  const E = EV.pick({
    job: Math.random() < 0.7, home: Math.random() < 0.9,
    indoors, sick: Math.random() < 0.08, mate: Math.random() < 0.4,
    cash: Math.random() < 0.8, raining: Math.random() < 0.2,
    hour: Math.random() * 24, fatigue: Math.random(),
  });
  if (!E) { none++; continue; }
  count[E.id] = (count[E.id] || 0) + 1;
}
const missing = EV.EVENTS.filter(e => !count[e.id]);
console.log(`\n${N.toLocaleString()} 回の抽選: ${Object.keys(count).length}/${EV.EVENTS.length} 種類が出現 / 候補なし ${none}`);

// 病気の発症率を元の実装と突き合わせる
const sickIds = EV.EVENTS.filter(e => e.sickly).map(e => e.id);
const sickHits = sickIds.reduce((n, id) => n + (count[id] || 0), 0);
const sickFrac = sickHits / (N - none);
const sickMeanMin = MEAN / sickFrac;
const origMeanMin = 1 / SICK_PROB / 60;
console.log(`\n病気 (${sickIds.join('/')}) の割合: ${(sickFrac * 100).toFixed(1)}%`);
console.log(`  イベントが平均 ${MEAN} 分に1回なら → 発症は平均 ${sickMeanMin.toFixed(0)} 分に1回`);
console.log(`  元の実装 (SICK_PROB)              → 平均 ${origMeanMin.toFixed(0)} 分に1回 (疲労0のとき)`);
const off = Math.abs(sickMeanMin - origMeanMin) / origMeanMin;
if (off > 0.35) {
  console.log(`✘ ${(off * 100).toFixed(0)}% ずれています。病気の重み (w) か --mean を調整してください。`);
  process.exitCode = 1;
} else console.log(`✔ 元の発症率と ${(off * 100).toFixed(0)}% 以内で一致しています。`);

if (missing.length) {
  console.log('✘ 一度も起きない項目: ' + missing.map(e => e.id).join(', '));
  process.exitCode = 1;
}
