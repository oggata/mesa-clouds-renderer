#!/usr/bin/env node
'use strict';
// preview-walk.js — 住民の歩行サイクルを絵にする。
//
//   node tools/preview-walk.js [out.png] [--frames=5] [--amp=1] [--view=side|front|iso]
//
// server.js は three と headless-gl が要るのでテスト環境で動かせない。
// けれど確かめたいのは three の描画ではなく **skeleton.js のポーズの式**で、
// それは頂点シェーダが実行するのとまったく同じもの。ここで絵にしておけば、
// 実機に載せる前に歩き方の良し悪しが分かる。
//
// 添付された姿勢推定オーバーレイと同じ並べ方 (横に 1 周期ぶん) で出す。

const fs=require('fs'), path=require('path');
const SK=require('../skeleton.js');
const PNG=require('./png.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const FRAMES=parseInt(arg('frames'))||5;
const AMP=arg('amp')!=null?parseFloat(arg('amp')):1;
const VIEW=arg('view')||'side';
const CW=200, CH=280, PAD=6;                       // 1 コマの大きさ
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','textures','road','walk_preview.png');

const W=CW*FRAMES, H=CH;
const img=new Uint8Array(W*H*4);
for(let i=0;i<W*H;i++){ img[i*4]=8; img[i*4+1]=8; img[i*4+2]=10; img[i*4+3]=255; }

// 身長 1.0 を CH の 0.86 倍に収める
const S=CH*0.86, X0=CW*0.5, Y0=CH*0.94;
// 投影。奥行き (x) は視点ごとに使い分ける。戻り値の d は奥行き (大きいほど手前)。
function project(p, view){
  if(view==='front') return { u:  p.x*S, v: -p.z*S, d:  p.y };
  if(view==='iso'){                                   // 斜め 35 度
    const c=Math.cos(0.61), s=Math.sin(0.61);
    return { u: (p.y*c - p.x*s)*S, v: -p.z*S, d: p.y*s + p.x*c };
  }
  return { u: p.y*S, v: -p.z*S, d: p.x };             // 側面 (矢状面)
}

// 奥にあるものを暗くして左右を見分けられるようにする。二値で切ると、体の中心に
// ある胴や頭 (奥行きがほぼ 0) がどちら側に転ぶかで急に暗くなるので、なだらかに。
// これはプレビューの見やすさのためだけで、本番は three のライティングが当たる。
function shade(col, d){
  const t=Math.max(0, Math.min(1, (d+0.16)/0.32));
  const k=0.50+0.50*t;
  return [((col>>16)&255)*k, ((col>>8)&255)*k, (col&255)*k];
}
function put(cx, x, y, c){
  const px=Math.round(cx+x), py=Math.round(y);
  if(px<0||px>=W||py<0||py>=H) return;
  const o=(py*W+px)*4;
  img[o]=Math.min(255,c[0]); img[o+1]=Math.min(255,c[1]); img[o+2]=Math.min(255,c[2]);
}
// 太い線分 (端は丸く)
function line(cx, ax, ay, bx, by, r, c){
  const x0=Math.floor(Math.min(ax,bx)-r-1), x1=Math.ceil(Math.max(ax,bx)+r+1);
  const y0=Math.floor(Math.min(ay,by)-r-1), y1=Math.ceil(Math.max(ay,by)+r+1);
  const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    let t = L2<1e-9 ? 0 : ((x-ax)*dx+(y-ay)*dy)/L2;
    t=Math.max(0,Math.min(1,t));
    const qx=ax+dx*t, qy=ay+dy*t;
    if(Math.hypot(x-qx,y-qy)<=r) put(cx,x,y,c);
  }
}
function dot(cx, x, y, r, c){
  for(let dy=-Math.ceil(r);dy<=Math.ceil(r);dy++)for(let dx=-Math.ceil(r);dx<=Math.ceil(r);dx++)
    if(Math.hypot(dx,dy)<=r) put(cx,x+dx,y+dy,c);
}

const bones=SK.boneSegments(), joints=SK.jointSpheres();
for(let f=0;f<FRAMES;f++){
  const phase=(f/FRAMES)*Math.PI*2;
  const cx=f*CW+X0;
  // 奥のものから描く (簡易な奥行き順)
  const items=[];
  for(const b of bones){
    const a=project(SK.poseVertex(b.a, b.bone, phase, AMP), VIEW);
    const c=project(SK.poseVertex(b.b, b.bone, phase, AMP), VIEW);
    items.push({d:(a.d+c.d)/2, draw:()=>line(cx, a.u, Y0+a.v, c.u, Y0+c.v, b.r*S, shade(b.col,(a.d+c.d)/2))});
  }
  for(const s of joints){
    const p=project(SK.poseVertex(s.p, s.bone, phase, AMP), VIEW);
    items.push({d:p.d, draw:()=>dot(cx, p.u, Y0+p.v, s.r*S, shade(s.col,p.d))});
  }
  items.sort((a,b)=>a.d-b.d).forEach(it=>it.draw());
  // コマの区切り
  if(f) for(let y=0;y<H;y++) put(0, f*CW, y, [40,40,46]);
}
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, PNG.encode(img,W,H));
console.log(`[Walk] ${path.relative(process.cwd(),out)}  ${W}x${H}  ${FRAMES}コマ / 振幅${AMP} / ${VIEW}`);
console.log(`[Walk] 骨 ${bones.length}本 / 関節 ${joints.length}個`);
