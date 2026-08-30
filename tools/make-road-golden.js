#!/usr/bin/env node
'use strict';
// make-road-golden.js — roads.js の答えをゴールデンベクタとして書き出す。
//
//   node tools/make-road-golden.js [out.json]
//
// ── なぜ要るか ──
// 観測に床を入れると、**同じ判定を Python (学習env) と JS (本番) の両方が持つ**
// ことになる。world.js / world.py が既に同じ関係にあり、その二重実装で
// 「学習 0.25〜0.50 / 本番 0.30〜0.55」というズレが実際に起きた。マップは
// データとして渡せるので golden vector で検出できなかった、というのが world.js
// 冒頭の反省。今度は最初から突き合わせられるようにしておく。
//
// 出力は学習ノートブックのセルが読み、Python 側の実装と 1 件ずつ照合する。

const fs=require('fs'), path=require('path');
const MW=require('../world.js'), RD=require('../roads.js'), TR=require('../traffic.js');
const PNG=require('./png.js');

const out=process.argv[2] || path.join(__dirname,'..','data','road_golden.json');
const GRID=30, SEED=1234;

// ── 1) 固定マップと通行量 ──────────────────────────────────────────────────
const MAP=MW.makeMap(GRID,SEED), { ROAD }=MW;
const roadUse=new Int32Array(GRID*GRID);
{
  const cells=[]; for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++) if(MAP[r][c]===ROAD) cells.push([r,c]);
  let s=SEED>>>0; const rng=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xffffffff; };
  const all=new Int8Array(GRID*GRID).fill(9);
  for(let i=0;i<400;i++){
    const a=cells[(rng()*cells.length)|0], b=cells[(rng()*cells.length)|0];
    const p=TR.route(MAP, all, {r:a[0],c:a[1]}, {r:b[0],c:b[1]}, ROAD, 0);
    if(p) for(const [r,c] of p) roadUse[r*GRID+c]++;
  }
}
const roadClass=RD.classifyRoads(MAP, roadUse, null, ROAD);

// ── 2) セルごとのマスクと枠 ────────────────────────────────────────────────
const mask=[], slot=[];
for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
  if(MAP[r][c]!==ROAD){ mask.push(-1); slot.push(-1); continue; }
  const m=RD.roadMask(MAP,r,c,ROAD);
  mask.push(m); slot.push(RD.atlasSlot(roadClass[r*GRID+c], m));
}

// ── 3) 足元の判定 ──────────────────────────────────────────────────────────
// 全クラス x 全マスク x 格子状の点。境目も含めて全部入れる (Python 側が
// 同じ式なら境目も一致するはず。ズレていればそこに出る)。
const N=11, gk=[];
for(const cls of [RD.PATH, RD.ONEWAY, RD.TWOLANE])
  for(let m=0;m<16;m++)
    for(let j=0;j<N;j++) for(let i=0;i<N;i++){
      const fu=(i+0.5)/N, fv=(j+0.5)/N;
      gk.push([cls, m, +fu.toFixed(6), +fv.toFixed(6),
               RD.groundKind(MW.ROAD, cls, m, fu, fv, MW)]);
    }

// ── 4) 床までの距離 ────────────────────────────────────────────────────────
const fd=[];
for(const H of [224, 128]) for(let y=Math.floor(H/2)+1; y<H; y+=7)
  fd.push([y, H, +RD.floorDist(y,H).toFixed(9)]);

// ── 5) 床テクスチャ (全部は大きいので、要約と抜き取り) ─────────────────────
const ap=PNG.decode(fs.readFileSync(path.join(__dirname,'..','textures','road','road_atlas.png')));
const rgba=new Uint8Array(ap.w*ap.h*4);
for(let y=0;y<ap.h;y++)for(let x=0;x<ap.w;x++){ const c=ap.px(x,y), o=(y*ap.w+x)*4;
  rgba[o]=c[0]; rgba[o+1]=c[1]; rgba[o+2]=c[2]; rgba[o+3]=c[3]; }
const bank=RD.bakeFloorBank(rgba, ap.w);
let sum=0; for(let i=0;i<bank.length;i++) sum+=bank[i];
const bankSamples=[];
for(const s of [0,5,7,15,21,32]) for(const [i,j] of [[2,2],[12,12],[21,5],[6,18]]){
  const k=(s*RD.RC_FW*RD.RC_FW + j*RD.RC_FW + i)*3;
  bankSamples.push([s,i,j, +bank[k].toFixed(6), +bank[k+1].toFixed(6), +bank[k+2].toFixed(6)]);
}

const J={
  version:1,
  note:'roads.js の答え。学習ノートブックの Python 実装をこれと突き合わせる。'
     + 'tools/make-road-golden.js が生成。roads.js を変えたら焼き直すこと。',
  grid:GRID, seed:SEED,
  consts:{ RW2:RD.RW2, RW1:RD.RW1, RIN_K:RD.RIN_K,
           XW_A:RD.XW_A, XW_B:RD.XW_B, XW_PITCH:RD.XW_PITCH, XW_DUTY:RD.XW_DUTY,
           CLASS_HI:RD.CLASS_HI, CLASS_LO:RD.CLASS_LO, PATH_MAX_DEGREE:RD.PATH_MAX_DEGREE,
           TILE:RD.TILE, GUT:RD.GUT, CONTENT:RD.CONTENT, COLS:RD.COLS, ROWS:RD.ROWS,
           ATLAS:RD.ATLAS, RC_FW:RD.RC_FW, FLOOR_EYE:RD.FLOOR_EYE, FLOOR_MAX:RD.FLOOR_MAX,
           SLOT_BASE:RD.SLOT_BASE, FLOOR_RGB:RD.FLOOR_RGB, GROUND:RD.GROUND },
  map: MAP.map(row=>row.join('')),
  roadUse: Array.from(roadUse),
  roadClass: Array.from(roadClass),
  mask, slot,
  groundKind: gk,
  floorDist: fd,
  floorBank: { sum:+sum.toFixed(4), len:bank.length, samples:bankSamples },
};
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, JSON.stringify(J));
const kb=(fs.statSync(out).size/1024).toFixed(0);
console.log(`[Golden] ${path.relative(process.cwd(),out)}  ${kb}KB`);
console.log(`[Golden] マップ ${GRID}x${GRID} / 道の格 ${roadClass.filter(v=>v>0).length} セル`);
console.log(`[Golden] 足元の判定 ${gk.length} 件 / 床の距離 ${fd.length} 件`);
console.log(`[Golden] 床バンク ${bank.length} float 合計 ${sum.toFixed(4)} / 抜き取り ${bankSamples.length} 点`);
