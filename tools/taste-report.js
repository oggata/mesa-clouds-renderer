#!/usr/bin/env node
// taste-report.js — data/clip_emb.json が「意味のある好み」になっているかの検算。
//
//   node tools/taste-report.js
//
// ① 写真 → 言葉 の当てっこ。ファサード写真の埋め込みが、どの建物の文に一番近いか。
//    ここが外れていると「見た目で好む」が成り立たない (写真が何の店か分かっていない)。
// ② 住民ごとの好き / 苦手 (学習前 = 人柄の文だけ)。
// ③ 学習の広がり。ラーメン屋で良い思いを重ねると、行っていない種類がどう動くか。
//    見た目の近い店 (牛丼・弁当) が一緒に上がれば、新しい店にも効く根拠になる。

const fs = require('fs');
const path = require('path');
const TASTE = require('../src/taste.js');

const J = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'clip_emb.json'), 'utf8'));
const names = Object.keys(J.types);
const VEC = require('../src/vec.js');
const PUBLIC = Object.keys(VEC.PLACE).filter(k => VEC.PLACE[k].public !== false);   // server.js と同じ絞り方
const S = TASTE.createState(J, names, PUBLIC);
const unit = v => TASTE.normalize(Float32Array.from(v));

// ① 当てっこ (CLIP 本来の使い方なので中心化しない生の埋め込みで)
const lab = names.map(n => unit(J.labels[n]));
let hit = 0, n = 0;
const miss = [];
for (const nm of names) {
  if (J.types[nm].src !== 'image') continue;
  const v = unit(J.types[nm].v);
  const sc = lab.map(l => TASTE.dot(v, l));
  const best = names[sc.indexOf(Math.max(...sc))];
  n++;
  if (best === nm) hit++; else miss.push(`${nm}→${best}`);
}
console.log(`① 写真→言葉: ${hit}/${n} 正解 (偶然なら ${(n / names.length).toFixed(1)})`);
if (miss.length) console.log(`   外れ: ${miss.join(', ')}`);

// ② 人柄だけの好み
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'persona_pool.json'), 'utf8')).personas;
const fmt = l => l.map(x => `${x.name}(${x.z > 0 ? '+' : ''}${x.z})`).join(' ');
console.log(`\n② 人柄の文だけの好み (z 値)`);
for (const p of pool.filter((_, i) => i % 4 === 0)) {
  const a = { def: { poolId: p.id } };
  const t = TASTE.top(S, a, 3);
  console.log(`  ${(p.titleJa + '(' + p.job + ')').padEnd(28)} 好き: ${fmt(t.like).padEnd(48)} 苦手: ${fmt(t.dislike)}`);
}

// ③ 学習の広がり
const a = { def: { poolId: pool[Math.floor(pool.length / 2)].id } };
const watch = ['ramen', 'gyudon', 'bento', 'kiosk', 'cafe', 'bank', 'museum', 'hospital'];
const zOf = () => { const z = TASTE.scores(S, a); return watch.map(w => z[names.indexOf(w)]); };
const before = zOf();
for (let i = 0; i < 8; i++) TASTE.learn(S, a, names.indexOf('ramen'), 0.9);
const after = zOf();
console.log(`\n③ ラーメン屋で良い経験を8回 (${pool[Math.floor(pool.length / 2)].job})`);
watch.forEach((w, i) => console.log(`  ${w.padEnd(9)} ${before[i].toFixed(2).padStart(6)} → ${after[i].toFixed(2).padStart(6)}`
  + `  (${after[i] - before[i] >= 0 ? '+' : ''}${(after[i] - before[i]).toFixed(2)})${w === 'ramen' ? '  ← 行った店' : ''}`));
