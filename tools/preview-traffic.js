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
// 4. **街の道をどれだけ使っているか (踏破率)**。最短経路だけで走らせると同じ
//    幹線しか通らず、道の大半に一度も車が来ない。--spread で重みの強さを変えて
//    踏破率を見比べられる (--spread=0 が従来の純粋な最短経路)。
// 5. **車間**。走行中の一番近い 2 台の中心間距離。車長 (既定 0.68) を下回ったら
//    車体が重なっている。

const fs=require('fs'), path=require('path');
const MW=require('../world.js'), RD=require('../roads.js'), TR=require('../traffic.js');
const PNG=require('./png.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const GRID=parseInt(arg('grid'))||30, SEED=parseInt(arg('seed'))||1234;
const SECS=parseFloat(arg('secs'))||120, MAXCARS=parseInt(arg('cars'))||24;
const PX=parseInt(arg('px'))||20, CELL=2.0, DT=1/20;
const SPREAD=arg('spread')!==null?parseFloat(arg('spread')):1.0;   // 0=最短経路のみ
const REROUTE=arg('reroute')!==null?parseFloat(arg('reroute')):14; // 引き直しの間隔(秒)。0=しない
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
// 街の中の行き止まり。ここも発着点に混ぜないと袋小路には永久に車が来ない。
const de=TR.deadEnds(MAP, roadClass, ROAD, 1);
const LOCAL=arg('local')!==null?parseFloat(arg('local')):0.35;   // 発着点が街の中になる割合
const pick=()=> (de.length && rnd()<LOCAL) ? de[(rnd()*de.length)|0] : gw[(rnd()*gw.length)|0];

// ── 走らせる ────────────────────────────────────────────────────────────────
let s2=(SEED*7919)>>>0; const rnd=()=>{ s2=(s2*1664525+1013904223)>>>0; return s2/0xffffffff; };
const LANE=0.165*CELL;
let cars=[], spawned=0, done=0, noRoute=0;
const trail=new Float32Array(GRID*PX*GRID*PX);      // どこを走ったかの濃淡
const steps=Math.round(SECS/DT);
// 走行可能な道と、そのうち実際に車が通ったセル (踏破率)
const drivable=[]; for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
  if(TR.drivable(MAP, roadClass, r, c, ROAD, 1)) drivable.push(r*GRID+c);
const visited=new Uint8Array(GRID*GRID);
// 経路の重み。server.js と同じ作り (最近通ったセルほど重い + 経路ごとのゆらぎ)。
const use=new Float32Array(GRID*GRID);
let seed=1; const cost=()=> SPREAD>0 ? TR.spreadCost(GRID, use, (seed=(seed*1103515245+12345)>>>0), SPREAD) : null;
const mark=p=>{ for(const [r,c] of p) use[r*GRID+c]=Math.min(1.5, use[r*GRID+c]+0.35); };
const line=p=>TR.laneLine(p, MAP, roadClass, ROAD, 1, CELL, LANE);
let minGap=Infinity, rerouted=0, spdSum=0, spdN=0, overlap=0, pairN=0;
let spawnCool=0;
for(let t=0;t<steps;t++){
  for(let i=0;i<use.length;i++) use[i]*=Math.exp(-DT/25);   // 通行の記憶を薄れさせる
  spawnCool-=DT;
  // 湧かせる。**間隔を空ける**。毎フレーム湧かせると湧き口で団子になる。
  if(cars.length<MAXCARS && spawnCool<=0){
    const a=pick(), b=pick();
    if(a.r!==b.r || a.c!==b.c){
      const p=TR.route(MAP, roadClass, a, b, ROAD, 1, {cost:cost()});
      if(!p||p.length<3) noRoute++;
      else{
        const L=line(p);
        // 湧き口に車が居るときは湧かせない (重なりの主犯)
        const clear=cars.every(c=>Math.hypot(c.x-L[0].x, c.y-L[0].y)>1.6);
        if(clear){
          mark(p);
          cars.push(TR.makeCar(L, 3.2+rnd()*1.4, (rnd()*3)|0));
          spawned++; spawnCool=0.7;
        }
      }
    }
  }
  // 定期的に経路を引き直す。同じ道ばかり通らせないための仕上げ。
  if(REROUTE>0) for(const c of cars){
    if((c.nextRoute=(c.nextRoute||REROUTE*(0.5+rnd()))-DT)>0) continue;
    c.nextRoute=REROUTE*(0.7+rnd()*0.6);
    const cur=c.line[c.idx]; if(!cur) continue;
    if((c.cum[c.idx]||0) < 8) continue;                    // 終点間際は引き直さない
    const b=pick();
    const back=c.line[c.idx-1];
    const p=TR.route(MAP, roadClass, {r:cur.r,c:cur.c}, b, ROAD, 1,
                     {cost:cost(), ban:back?[back.r,back.c]:null});
    if(p && p.length>=2 && TR.retarget(c, line(p))){ mark(p); rerouted++; }
  }
  const before=cars.length;
  cars=TR.stepCars(cars, DT);
  done+=before-cars.length;
  // 踏破は**いま走っている経路のセル**で数える。車のワールド座標を割り算すると、
  // 車線のぶん寄っているせいで隣のセルに入ってしまい、脇を通り過ぎただけの
  // 袋小路まで「走った」ことになる (それで踏破率が 100% に見えていた)。
  for(const c of cars){ const w=c.line[c.idx-1]; if(w) visited[w.r*GRID+w.c]=1; }
  // 走った跡を残す (最後の 1/3 だけ。序盤の湧き位置に偏らせない)
  if(t>steps*0.66) for(const c of cars){
    const px=Math.round(c.x/CELL*PX), py=Math.round(c.y/CELL*PX);
    if(px>=0&&px<GRID*PX&&py>=0&&py<GRID*PX) trail[py*GRID*PX+px]+=1;
  }
  // 「前の車との距離」の最小値。**自分の真後ろに付いている車**との距離だけを見る。
  //   ・向きが 60 度以上違う組  … 交差点で流れが交わっているだけ
  //   ・横に 0.30 以上ずれた組  … 隣/対向の車線。一通の車線間隔は 0.40 しか無いので
  //                              混ぜると常にそちらが最小になり、追従の良し悪しが
  //                              まったく測れない (最初これで測っていて誤読した)
  if(t>steps*0.2) for(let i=0;i<cars.length;i++)for(let j=i+1;j<cars.length;j++){
    const a=cars[i], b=cars[j];
    if(Math.cos(a.th-b.th)<0.5) continue;
    const ox=b.x-a.x, oy=b.y-a.y, ct=Math.cos(a.th), st2=Math.sin(a.th);
    if(Math.abs(-ox*st2+oy*ct)>0.30) continue;
    const d=Math.abs(ox*ct+oy*st2);
    if(d<minGap) minGap=d;
    if(d<0.68) overlap++;                                  // 車長を下回った = めり込んでいる
    pairN++;
  }
  if(t>steps*0.2){ for(const c of cars){ spdSum+=c.v; spdN++; } }
}
// 止まったままの車 = デッドロックの疑い
const stuck=cars.filter(c=>c.v<0.05).length;
const cover=drivable.filter(i=>visited[i]).length/Math.max(1,drivable.length);

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
          + ` / 経路なし ${noRoute} / 止まったまま ${stuck} / 引き直し ${rerouted}`);
console.log(`[Traffic] 完走率 ${(done/Math.max(1,spawned-cars.length)*100).toFixed(0)}%`
          + `  ${stuck>MAXCARS*0.3?'← 詰まっている疑い':''}`);
console.log(`[Traffic] 踏破率 ${(cover*100).toFixed(0)}% (走行可能な道 ${drivable.length}セル`
          + ` / うち行き止まり ${de.length})`);
console.log(`[Traffic] spread=${SPREAD} reroute=${REROUTE}s local=${LOCAL}`);
console.log(`[Traffic] 最小車間 ${minGap===Infinity?'-':minGap.toFixed(2)} (同じ車線で前後に並んだ2台の中心間)`
          + `  ${minGap<0.68?'← 車体が重なっている':''}`);
console.log(`[Traffic] めり込み ${overlap} / 前後に並んだ組 ${pairN}`
          + ` (${(overlap/Math.max(1,pairN)*100).toFixed(1)}%)`);
console.log(`[Traffic] 平均速度 ${(spdSum/Math.max(1,spdN)).toFixed(2)} (上限 3.2〜4.6)`);
