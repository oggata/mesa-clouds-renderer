#!/usr/bin/env node
'use strict';
// pop-curve.js — 景気の波に対して人口が実際に増減するかを、周期を通して計算する。
//
//   node tools/pop-curve.js [--amp=0.35] [--p=3.0] [--out=0.22]
//
// **なぜ要るか。** growPopulation / shrinkPopulation のつまみは、街を何日も
// 走らせないと効果が分からない (1日 = 実時間24分)。一度これを怠って
// MOVEIN_BOOM_P=2.6 / MOVEOUT_BOOM=0.09 を入れたところ、**どん底でも +2.1%/日**で
// 人口は一度も減らなかった。増減率は式だけで出せるので、ここで先に確かめる。
//
// 出るのは「1日あたり人口の何 % が動くか」。減る局面が無い設定は、街を何日
// 走らせても「増えて住居の定員で頭打ち」にしかならない。

const arg=(k,d)=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?parseFloat(a.split('=')[1]):d; };
const AMP     = arg('amp', 0.35);    // BOOM_AMP
const GROWTH  = arg('growth', 0.15); // POP_GROWTH
const P       = arg('p', 3.0);       // MOVEIN_BOOM_P
const OUT     = arg('out', 0.22);    // MOVEOUT_BOOM
const BUST_AT = arg('bustAt', 0.95); // MOVEOUT_BUST_AT
const MAXFRAC = arg('maxFrac', 0.10);// MOVE_MAX_FRAC

const rows=[];
for(let i=0;i<24;i++){
  const w=Math.cos(i/24*Math.PI*2);
  const bf=1+AMP*w;
  const inR =Math.min(MAXFRAC, GROWTH*Math.pow(bf,P));
  const bust=Math.max(0,(BUST_AT-bf)/BUST_AT);
  const outR=Math.min(MAXFRAC, OUT*bust);
  rows.push({bf, inR, outR, net:inR-outR});
}
const minNet=Math.min(...rows.map(r=>r.net)), maxNet=Math.max(...rows.map(r=>r.net));
console.log(`BOOM_AMP=${AMP} POP_GROWTH=${GROWTH} MOVEIN_BOOM_P=${P} MOVEOUT_BOOM=${OUT}`);
console.log('景気   転入%/日  転出%/日  増減%/日');
for(const r of rows)
  console.log(`${r.bf.toFixed(2)}   ${(r.inR*100).toFixed(1).padStart(6)}  ${(r.outR*100).toFixed(1).padStart(7)}`
    + `  ${(r.net*100>=0?'+':'')}${(r.net*100).toFixed(1).padStart(6)}`
    + (r.net<0?'  ← 減る':''));
console.log(`\n1日の増減: ${(minNet*100).toFixed(1)}% 〜 +${(maxNet*100).toFixed(1)}%`);
if(minNet>=0){
  console.log('✘ どの局面でも増える設定です。人口は住居の定員で頭打ちになり、波は画に出ません。');
  console.log('  MOVEOUT_BOOM を上げるか、MOVEIN_BOOM_P を上げて不況の転入をもっと絞ってください。');
  process.exitCode=1;
}else console.log('✔ 減る局面があります。');
