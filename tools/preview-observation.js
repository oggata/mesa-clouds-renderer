#!/usr/bin/env node
'use strict';
// preview-observation.js — 方策が見る観測画像の**床の部分**を描いて確かめる。
//
//   node tools/preview-observation.js [out.png] [--grid=30] [--seed=1234] [--fov=60]
//
// server.js は three と headless-gl が要るので動かせない。壁 (建物) のレイキャスト
// はそちらにあるが、今回足した**床キャスト**は roads.js の floorDist と
// bakeFloorBank だけで再現できるので、ここで絵にして遠近と歩道の位置を確かめる。
//
// ループの形は server.js renderFPImageCfg の床パスと同じ。距離の式と縮小規則は
// roads.js を呼んでいるので、そこがズレることはない。

const fs=require('fs'), path=require('path');
const MW=require('../world.js'), RD=require('../roads.js'), TR=require('../traffic.js');
const PNG=require('./png.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const GRID=parseInt(arg('grid'))||30, SEED=parseInt(arg('seed'))||1234;
const FOV=(parseFloat(arg('fov'))||60)*Math.PI/180;
const W=224, H=224;
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','docs','observation-floor.png');

// ── 街を作る ────────────────────────────────────────────────────────────────
const MAP=MW.makeMap(GRID,SEED), { ROAD }=MW;
const roadUse=new Int32Array(GRID*GRID);
{
  const cells=[]; for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++) if(MAP[r][c]===ROAD) cells.push([r,c]);
  let s=SEED>>>0; const rng=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xffffffff; };
  const all=new Int8Array(GRID*GRID).fill(9);
  for(let i=0;i<400;i++){ const a=cells[(rng()*cells.length)|0], b=cells[(rng()*cells.length)|0];
    const p=TR.route(MAP, all, {r:a[0],c:a[1]}, {r:b[0],c:b[1]}, ROAD, 0);
    if(p) for(const [r,c] of p) roadUse[r*GRID+c]++; }
}
const roadClass=RD.classifyRoads(MAP, roadUse, null, ROAD);

// ── 床テクスチャを焼く (server.js と同じ roads.js の規則) ────────────────────
const ap=PNG.decode(fs.readFileSync(path.join(__dirname,'..','textures','road','road_atlas.png')));
const rgba=new Uint8Array(ap.w*ap.h*4);
for(let y=0;y<ap.h;y++)for(let x=0;x<ap.w;x++){ const c=ap.px(x,y), o=(y*ap.w+x)*4;
  rgba[o]=c[0]; rgba[o+1]=c[1]; rgba[o+2]=c[2]; rgba[o+3]=c[3]; }
const bank=RD.bakeFloorBank(rgba, ap.w);
const slot=new Int16Array(GRID*GRID).fill(-1);
for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
  if(MAP[r][c]===ROAD) slot[r*GRID+c]=RD.atlasSlot(roadClass[r*GRID+c], RD.roadMask(MAP,r,c,ROAD));

function sample(r,c,fr,fc){
  const t=MAP[r][c];
  if(t===MW.TREE) return RD.FLOOR_RGB.GRASS;
  if(t===MW.OTHER) return RD.FLOOR_RGB.DIRT;
  const s=slot[r*GRID+c];
  if(s<0) return RD.FLOOR_RGB.ASPHALT;
  const i=Math.min(RD.RC_FW-1, Math.max(0,(fc*RD.RC_FW)|0));
  const j=Math.min(RD.RC_FW-1, Math.max(0,(fr*RD.RC_FW)|0));
  const k=(s*RD.RC_FW*RD.RC_FW + j*RD.RC_FW + i)*3;
  return [bank[k], bank[k+1], bank[k+2]];
}

// ── 視点を選ぶ: 二車線の道の歩道の上に立ち、道に沿って向く ──────────────────
// --at=street (既定) … 二車線の直線の歩道に立ち、道に沿って向く
// --at=cross       … 交差点の手前の歩道に立ち、横断歩道の方を向く
const AT=arg('at')||'street';
const M=Math.max(4, Math.floor(GRID*0.2));              // 端から離す (端は VOID で絵にならない)
let px=0, py=0, th=0, found=false;
for(let r=M;r<GRID-M && !found;r++)for(let c=M;c<GRID-M && !found;c++){
  if(MAP[r][c]!==ROAD || roadClass[r*GRID+c]<RD.TWOLANE) continue;
  const m=RD.roadMask(MAP,r,c,ROAD);
  if(AT==='cross'){
    if(RD.maskDegree(m)<3) continue;                     // 交差点
    // 交差点の 1 つ北の歩道に立ち、南 (交差点) を向く。
    // 向きの規約: th=0 が +行 (南)、th=PI/2 が +列 (東)。server.js と同じ。
    if(MAP[r-1][c]!==ROAD) continue;
    px=r-1+0.5; py=c+0.5-RD.sidewalkOffset(RD.TWOLANE); th=0; found=true;
  }else{
    if(m!==5) continue;                                  // 南北の直線
    // 歩道 (西側) に立ち、北を向く。x=行 / y=列 の対応は server.js と同じ。
    px=r+0.5; py=c+0.5-RD.sidewalkOffset(RD.TWOLANE); th=Math.PI; found=true;   // 北を向く
  }
}
if(!found){ console.error('条件に合う場所が見つかりません'); process.exit(1); }

// ── 床キャスト (server.js renderFPImageCfg の床パスと同じ形) ────────────────
const img=new Uint8Array(W*H*4);
for(let i=0;i<W*H;i++){ img[i*4]=16; img[i*4+1]=26; img[i*4+2]=46; img[i*4+3]=255; }  // 空
const dirX=Math.cos(th), dirY=Math.sin(th);
const pl=Math.tan(FOV/2), planeX=-dirY*pl, planeY=dirX*pl;
let painted=0;
for(let yi=Math.floor(H/2)+1; yi<H; yi++){
  const perp=RD.floorDist(yi,H);
  if(perp>RD.FLOOR_MAX) continue;
  const br=Math.min(1.0, Math.max(0.35, 1.0-perp/9));
  for(let xi=0;xi<W;xi++){
    const cam=2*xi/W-1;
    const fx=px+(dirX+planeX*cam)*perp, fy=py+(dirY+planeY*cam)*perp;
    const r=Math.floor(fx), c=Math.floor(fy);
    if(r<0||r>=GRID||c<0||c>=GRID) continue;
    const col=sample(r,c,fx-r,fy-c), o=(yi*W+xi)*4;
    img[o]=col[0]*br*255; img[o+1]=col[1]*br*255; img[o+2]=col[2]*br*255;
    painted++;
  }
}
fs.mkdirSync(path.dirname(out),{recursive:true});
// --scale で拡大して書き出す (224px だと目視しづらいため。中身は変えない)
const SC=Math.max(1, parseInt(arg('scale'))||1);
if(SC===1){ fs.writeFileSync(out, PNG.encode(img,W,H)); }
else{
  const bw=W*SC, bh=H*SC, big=new Uint8Array(bw*bh*4);
  for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){
    const so=(((y/SC)|0)*W+((x/SC)|0))*4, o=(y*bw+x)*4;
    big[o]=img[so]; big[o+1]=img[so+1]; big[o+2]=img[so+2]; big[o+3]=255;
  }
  fs.writeFileSync(out, PNG.encode(big,bw,bh));
}
console.log(`[Obs] ${path.relative(process.cwd(),out)}  ${W}x${H}`);
console.log(`[Obs] 視点: 行${px.toFixed(2)} 列${py.toFixed(2)} 向き${(th*180/Math.PI).toFixed(0)}度 (二車線の歩道の上)`);
console.log(`[Obs] 床を塗った画素: ${painted} / ${W*Math.floor(H/2)}`);
console.log(`[Obs] 足元の判定: ${Object.keys(RD.GROUND).find(k=>RD.GROUND[k]===
  RD.groundKind(MW.ROAD, roadClass[Math.floor(px)*GRID+Math.floor(py)],
    RD.roadMask(MAP,Math.floor(px),Math.floor(py),ROAD), py-Math.floor(py), px-Math.floor(px), MW))}`);
