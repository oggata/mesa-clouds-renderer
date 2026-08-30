#!/usr/bin/env node
'use strict';
// preview-traffic.js — 車を頭出しで走らせて、詰まらずに街を抜けるかを見る。
//
//   node tools/preview-traffic.js [out.png] [--grid=30] [--seed=1234] [--secs=120] [--cars=24]
//
// ── 何を確かめるか ──
// 1. 出入口が街の外周にちゃんと見つかるか
// 2. 出入口どうしの経路が引けるか
// 3. **走り切れるか**。traffic.js は「他の車が居るセルには入らない」で交差点に
//    列を作るが、交差点で互いに待ち合うとデッドロックする。頭出しで回して
//    完走率を測らないと、実機で「車が全部止まった街」になって初めて気付く。

const fs=require('fs'), path=require('path');
const MW=require('../world.js'), RD=require('../roads.js'), TR=require('../traffic.js');
const PNG=require('./png.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const GRID=parseInt(arg('grid'))||30, SEED=parseInt(arg('seed'))||1234;
const SECS=parseFloat(arg('secs'))||120, MAXCARS=parseInt(arg('cars'))||24;
const PX=parseInt(arg('px'))||20, CELL=2.0, DT=1/20;
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','docs','traffic-preview.png');

const MAP=MW.makeMap(GRID,SEED);
const { ROAD }=MW;

// 通行量は preview-city-roads と同じ作り方 (道の上の最短経路を往復させて数える)
const roadUse=new Int32Array(GRID*GRID);
{
  const cells=[];
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++) if(MAP[r][c]===ROAD) cells.push(r*GRID+c);
  let s=SEED>>>0; const rng=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xffffffff; };
  for(let i=0;i<400 && cells.length>1;i++){
    const a=cells[(rng()*cells.length)|0], b=cells[(rng()*cells.length)|0];
    if(a===b) continue;
    const p=TR.route(MAP, new Int8Array(GRID*GRID).fill(9), {r:(a/GRID)|0,c:a%GRID},
                     {r:(b/GRID)|0,c:b%GRID}, ROAD, 0);
    if(p) for(const [r,c] of p) roadUse[r*GRID+c]++;
  }
}
const roadClass=RD.classifyRoads(MAP, roadUse, null, ROAD);
const gw=TR.gateways(MAP, roadClass, ROAD, 99);
if(!gw.length){ console.error('[Traffic] 出入口が見つかりません'); process.exit(1); }

// ── 走らせる ────────────────────────────────────────────────────────────────
let s2=(SEED*7919)>>>0; const rnd=()=>{ s2=(s2*1664525+1013904223)>>>0; return s2/0xffffffff; };
const LANE=0.165*CELL;
let cars=[], spawned=0, done=0, noRoute=0;
const trail=new Float32Array(GRID*PX*GRID*PX);      // どこを走ったかの濃淡
const steps=Math.round(SECS/DT);
for(let t=0;t<steps;t++){
  while(cars.length<MAXCARS){
    const a=gw[(rnd()*gw.length)|0], b=gw[(rnd()*gw.length)|0];
    if(a===b) break;
    const p=TR.route(MAP, roadClass, a, b, ROAD);
    if(!p||p.length<3){ noRoute++; break; }
    cars.push(TR.makeCar(TR.laneLine(p, MAP, roadClass, ROAD, 1, CELL, LANE), 3.2+rnd()*1.4, (rnd()*3)|0));
    spawned++;
  }
  const before=cars.length;
  cars=TR.stepCars(cars, DT);
  done+=before-cars.length;
  // 走った跡を残す (最後の 1/3 だけ。序盤の湧き位置に偏らせない)
  if(t>steps*0.66) for(const c of cars){
    const px=Math.round(c.x/CELL*PX), py=Math.round(c.y/CELL*PX);
    if(px>=0&&px<GRID*PX&&py>=0&&py<GRID*PX) trail[py*GRID*PX+px]+=1;
  }
}
// 止まったままの車 = デッドロックの疑い
const stuck=cars.filter(c=>c.v<0.05).length;

// ── 絵にする ────────────────────────────────────────────────────────────────
const W=GRID*PX, img=new Uint8Array(W*W*4);
const BASE={ [MW.ROAD]:[70,72,76], [MW.OTHER]:[150,148,120], [MW.BUILDING]:[104,100,96], [MW.TREE]:[92,124,68] };
for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
  const t=MAP[r][c];
  let col=BASE[t]||[30,30,32];
  if(t===ROAD){                                    // 格で明るさを変える
    const k=[0.72,0.92,1.15][roadClass[r*GRID+c]]||1;
    col=[col[0]*k, col[1]*k, col[2]*k];
  }
  for(let y=0;y<PX;y++)for(let x=0;x<PX;x++){
    const o=(((r*PX+y)*W)+(c*PX+x))*4;
    img[o]=col[0]; img[o+1]=col[1]; img[o+2]=col[2]; img[o+3]=255;
  }
}
// 走行の跡 (青緑)
let tmax=0; for(const v of trail) if(v>tmax) tmax=v;
if(tmax>0) for(let i=0;i<trail.length;i++){
  if(!trail[i]) continue;
  const a=Math.min(1, trail[i]/tmax*3), o=i*4;
  img[o]=img[o]*(1-a)+40*a; img[o+1]=img[o+1]*(1-a)+210*a; img[o+2]=img[o+2]*(1-a)+200*a;
}
// 出入口 (黄)
for(const g of gw){
  for(let y=0;y<PX;y++)for(let x=0;x<PX;x++){
    if(x>2&&x<PX-3&&y>2&&y<PX-3) continue;         // 枠だけ
    const o=(((g.r*PX+y)*W)+(g.c*PX+x))*4;
    img[o]=240; img[o+1]=200; img[o+2]=60;
  }
}
// 車 (赤)。向きを見せるため進行方向を長くした矩形で描く
for(const c of cars){
  const cx=c.x/CELL*PX, cy=c.y/CELL*PX, ca=Math.cos(c.th), sa=Math.sin(c.th);
  for(let u=-PX*0.28;u<=PX*0.28;u+=0.4)for(let v=-PX*0.12;v<=PX*0.12;v+=0.4){
    const px=Math.round(cx+u*ca-v*sa), py=Math.round(cy+u*sa+v*ca);
    if(px<0||px>=W||py<0||py>=W) continue;
    const o=(py*W+px)*4;
    img[o]=245; img[o+1]=80; img[o+2]=70;
  }
}
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, PNG.encode(img,W,W));
console.log(`[Traffic] ${path.relative(process.cwd(),out)}  ${W}x${W}  GRID=${GRID} seed=${SEED}`);
console.log(`[Traffic] 出入口 ${gw.length}箇所 / ${SECS}秒ぶん走行`);
console.log(`[Traffic] 湧いた ${spawned} / 抜けた ${done} / 走行中 ${cars.length}`
          + ` / 経路なし ${noRoute} / 止まったまま ${stuck}`);
console.log(`[Traffic] 完走率 ${(done/Math.max(1,spawned-cars.length)*100).toFixed(0)}%`
          + `  ${stuck>MAXCARS*0.3?'← 詰まっている疑い':''}`);
