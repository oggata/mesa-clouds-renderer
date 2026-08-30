#!/usr/bin/env node
'use strict';
// preview-city-roads.js — 実際のマップ生成から路面標示レイヤーまでを通して絵にする。
//
//   node tools/preview-city-roads.js [out.png] [--grid=30] [--seed=1234]
//
// ── なぜ要るか ──
// server.js は three と headless-gl を要求するので、この環境では動かせない。
// けれど確かめたいのは three の描画そのものではなく、その手前の
//     makeMap (world.js) → classifyRoads / roadMask / atlasSlot / atlasUV (roads.js)
//     → アトラスの UV サンプリング
// という**server.js が通るのと同じ経路**が正しいかどうか。ここを別実装で
// 描くと検証にならないので、server.js と同じモジュールを同じ順に呼ぶ。
//
// とくに UV の v の向き (flipY) はここでしか確かめられない。間違っていれば
// 道が隣のセルと繋がらないので、出力を一目見れば分かる。

const fs=require('fs'), path=require('path');
const MW=require('../world.js');
const RD=require('../roads.js');
const PNG=require('./png.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const GRID=parseInt(arg('grid'))||30;
const SEED=parseInt(arg('seed'))||1234;
const TRIPS=parseInt(arg('trips'))||400;
const CURB_DEBUG=arg('curb')==='debug';
const PX=parseInt(arg('px'))||24;                // 1 セルの出力サイズ (px)
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','textures','road','city_preview.png');

// ── 1) 街を作る (server.js と同じ makeMap) ──────────────────────────────────
const MAP=MW.makeMap(GRID, SEED);
const { ROAD }=MW;

// ── 2) 通行量をでっち上げる ────────────────────────────────────────────────
// 保存された街 (data/city_state.json) があればその実データを使う。無ければ
// 道の上をランダムな 2 点間で往復させて数える。式で作った重みより、実際の
// 経路が集まる場所 = 幹線、という形になるので分類器の入力として素直。
const roadUse=new Int32Array(GRID*GRID);
const save=path.join(__dirname,'..','data','city_state.json');
let useSrc='合成 (最短経路 '+TRIPS+' 往復)';
if(fs.existsSync(save)){
  try{
    const j=JSON.parse(fs.readFileSync(save,'utf8'));
    if(j.roadUse && j.roadUse.length===GRID*GRID && j.grid===GRID){
      roadUse.set(j.roadUse); useSrc='data/city_state.json の実データ';
    }
  }catch(e){ /* 壊れていれば合成にフォールバック */ }
}
if(useSrc.startsWith('合成')){
  const cells=[];
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++) if(MAP[r][c]===ROAD) cells.push(r*GRID+c);
  let s=SEED>>>0; const rng=()=>{ s=(s*1664525+1013904223)>>>0; return s/0xffffffff; };
  const bfs=(from,to)=>{                       // 道の上だけを通る最短経路
    const prev=new Int32Array(GRID*GRID).fill(-1); prev[from]=from;
    const q=[from];
    for(let h=0; h<q.length; h++){
      const u=q[h]; if(u===to) break;
      const r=(u/GRID)|0, c=u%GRID;
      for(const [dr,dc] of MW.D4){
        const nr=r+dr, nc=c+dc;
        if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
        const v=nr*GRID+nc;
        if(prev[v]>=0 || MAP[nr][nc]!==ROAD) continue;
        prev[v]=u; q.push(v);
      }
    }
    if(prev[to]<0) return null;
    const p=[]; for(let v=to; v!==from; v=prev[v]) p.push(v);
    p.push(from); return p;
  };
  for(let i=0;i<TRIPS && cells.length>1;i++){
    const a=cells[(rng()*cells.length)|0], b=cells[(rng()*cells.length)|0];
    if(a===b) continue;
    const p=bfs(a,b); if(!p) continue;
    for(const v of p) roadUse[v]++;
  }
}

// ── 3) 道の格を決める (server.js の reclassRoads と同じ呼び方) ──────────────
const roadClass=RD.classifyRoads(MAP, roadUse, null, ROAD);

// ── 4) アトラスを読んで、シェーダと同じ引き方でサンプリングする ─────────────
const atlasFile=path.join(__dirname,'..','textures','road','road_atlas.png');
if(!fs.existsSync(atlasFile)){ console.error('先に node tools/make-road-atlas.js を実行してください'); process.exit(1); }
const atlas=PNG.decode(fs.readFileSync(atlasFile));

// three の DataTexture は flipY=true で読むので、UNPACK_FLIP_Y_WEBGL により
// **画像の上端が V=1** になる。つまり (U,V) で引くと画像の (U*W, (1-V)*H)。
// server.js は RD.atlasUV(slot, true) が返す vN/vS をそのまま頂点に載せるので、
// ここでも同じ値を使って同じ式で引く。
const sample=(U,V)=>{
  const x=Math.min(atlas.w-1, Math.max(0, Math.round(U*atlas.w-0.5)));
  const y=Math.min(atlas.h-1, Math.max(0, Math.round((1-V)*atlas.h-0.5)));
  return atlas.px(x,y);
};

const W=GRID*PX, img=new Uint8Array(W*W*4);
const BASE={                                   // 下地 (server.js の quadMesh の色に近づけた)
  [MW.ROAD]:[86,88,92], [MW.OTHER]:[164,162,132], [MW.BUILDING]:[120,116,110], [MW.TREE]:[108,140,80],
};
const count=[0,0,0];
for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
  const t=MAP[r][c];
  let uv=null;
  if(t===ROAD){
    const cls=roadClass[r*GRID+c];
    count[cls]++;
    uv=RD.atlasUV(RD.atlasSlot(cls, RD.roadMask(MAP,r,c,ROAD)), true);
  }
  for(let y=0;y<PX;y++)for(let x=0;x<PX;x++){
    const o=(((r*PX+y)*W)+(c*PX+x))*4;
    const bg=BASE[t]||[40,40,40];
    let col=bg;
    if(uv){
      // セル内の位置。x は東 (+列) 方向、y は南 (+行) 方向 = pushMarkQuad と同じ対応。
      const fu=(x+0.5)/PX, fv=(y+0.5)/PX;
      const s=sample(uv.u0+fu*(uv.u1-uv.u0), uv.vN+fv*(uv.vS-uv.vN));
      const a=s[3]/255;
      col=[s[0]*a+bg[0]*(1-a), s[1]*a+bg[1]*(1-a), s[2]*a+bg[2]*(1-a)];
    }
    img[o]=col[0]; img[o+1]=col[1]; img[o+2]=col[2]; img[o+3]=255;
  }
}
// ── 4b) 縁石の立体を上から重ねる ────────────────────────────────────────────
// three が無いので陰影だけの簡易ラスタライズ。縦の面は真上から見ると潰れるので、
// 見えるのは面取り (天端から歩道面へ落ちる帯) だけ。**その帯がテクスチャの
// 明るい縁石帯とぴったり重なっていれば、輪郭と絵が同じ場所を指している**。
const curbFile=path.join(__dirname,'..','textures','road','road_curbs.json');
let curbTris=0;
if(fs.existsSync(curbFile)){
  const J=JSON.parse(fs.readFileSync(curbFile,'utf8')).slots;
  // server.js の CURB_PROFILE と同じ寸法を、この絵のピクセル単位に直す。
  // 位置は 1 セル = PX ピクセル、server.js は 1 セル = CELL(2.0) ワールド単位なので
  // 倍率は PX/CELL。**z と面取り幅を同じ単位に揃えないと陰影の傾きが狂う**
  // (最初これを混ぜてしまい、面取りが 0.03 ピクセル幅になって見えなかった)。
  const CELL=2.0, K=PX/CELL;
  const P={zRoad:0.008*K, zTop:0.060*K, zWalk:0.014*K, chamfer:0.030*CELL*K};
  const Lx=-0.42, Ly=-0.53, Lz=0.74;                               // 光の向き
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(MAP[r][c]!==ROAD) continue;
    const slot=RD.atlasSlot(roadClass[r*GRID+c], RD.roadMask(MAP,r,c,ROAD));
    const lines=J[slot]; if(!lines) continue;
    const pos=[], nrm=[];
    RD.pushCurb(pos, nrm, lines, c*PX, r*PX, PX, P);
    for(let t=0;t*9<pos.length;t++){
      const X=[0,1,2].map(i=>pos[t*9+i*3]), Y=[0,1,2].map(i=>pos[t*9+i*3+1]);
      const area=(X[1]-X[0])*(Y[2]-Y[0])-(X[2]-X[0])*(Y[1]-Y[0]);
      if(Math.abs(area)<0.25) continue;                            // 縦の面は潰れる
      const n=[0,1,2].map(k=>(nrm[t*9+k]+nrm[t*9+3+k]+nrm[t*9+6+k])/3);
      const nl=Math.hypot(...n)||1;
      const lam=Math.max(0.30, (n[0]*Lx+n[1]*Ly+n[2]*Lz)/nl);
      // 既定はコンクリート色。設計どおりなら**テクスチャの縁石帯とぴったり重なる**
      // ので、真上から見ると見分けが付かない (それが正しい状態)。位置を目で確かめたい
      // ときは --curb=debug で色を変える。ズレていれば車道や歩道の奥にはみ出して見える。
      const col = CURB_DEBUG ? [235*lam, 70*lam, 190*lam]
                             : [198*lam+40, 200*lam+40, 204*lam+40];
      curbTris++;
      const x0=Math.max(0,Math.floor(Math.min(...X))), x1=Math.min(W-1,Math.ceil(Math.max(...X)));
      const y0=Math.max(0,Math.floor(Math.min(...Y))), y1=Math.min(W-1,Math.ceil(Math.max(...Y)));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const px2=x+0.5, py=y+0.5;
        const w0=((X[1]-X[0])*(py-Y[0])-(Y[1]-Y[0])*(px2-X[0]))/area;
        const w1=((X[2]-X[1])*(py-Y[1])-(Y[2]-Y[1])*(px2-X[1]))/area;
        const w2=((X[0]-X[2])*(py-Y[2])-(Y[0]-Y[2])*(px2-X[2]))/area;
        if(w0<0||w1<0||w2<0) continue;
        const o=((y*W)+x)*4;
        img[o]=Math.min(255,col[0]); img[o+1]=Math.min(255,col[1]); img[o+2]=Math.min(255,col[2]);
      }
    }
  }
}

// 書き出しは**すべての描画が終わってから**。縁石を img に描くより前に
// 書いてしまい、縁石が入らない絵が出ていた。
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, PNG.encode(img, W, W));

// ── 5) 車が通れる網 (格>=1) が連結しているか ─────────────────────────────────
// 将来 車を走らせるとき、これが割れていると「出口に辿り着けない車」が出る。
// 歩行者専用のセルで幹線が寸断されていないかの見張りでもある。
function carNetwork(){
  const seen=new Int8Array(GRID*GRID);
  const drivable=i=>MAP[(i/GRID)|0][i%GRID]===ROAD && roadClass[i]>=RD.ONEWAY;
  let total=0; for(let i=0;i<seen.length;i++) if(drivable(i)) total++;
  let best=0, comps=0;
  for(let i0=0;i0<seen.length;i0++){
    if(!drivable(i0)||seen[i0]) continue;
    comps++; const q=[i0]; seen[i0]=1; let cnt=1;
    for(let h=0;h<q.length;h++){
      const u=q[h], r=(u/GRID)|0, c=u%GRID;
      for(const [dr,dc] of MW.D4){
        const nr=r+dr, nc=c+dc;
        if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
        const v=nr*GRID+nc;
        if(seen[v]||!drivable(v)) continue;
        seen[v]=1; cnt++; q.push(v);
      }
    }
    if(cnt>best) best=cnt;
  }
  return {total, best, comps};
}
const net=carNetwork();

const tot=count[0]+count[1]+count[2];
console.log(`[Preview] ${path.relative(process.cwd(),out)}  ${W}x${W}  GRID=${GRID} seed=${SEED}`);
console.log(`[Preview] 通行量: ${useSrc}`);
console.log(`[Preview] 道 ${tot} セル — 歩行者専用 ${count[0]} / 一通 ${count[1]} / 二車線 ${count[2]}`);
console.log(`[Preview] 縁石: 三角形 ${curbTris} (面取りの帯だけが真上から見える)`);
console.log(`[Preview] 車が通れる網: ${net.total} セル / 最大連結成分 ${net.best} `
  + `(${(net.best/Math.max(1,net.total)*100).toFixed(0)}%) / 分断 ${net.comps} 個`);
