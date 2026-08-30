#!/usr/bin/env node
'use strict';
// make-road-atlas.js — 路面標示のオートタイル・アトラスを手続き的に描いて PNG に書く。
//
//   node tools/make-road-atlas.js            # textures/road/road_atlas.png と _preview.png
//   node tools/make-road-atlas.js out.png
//
// ── なぜアトラス (テクスチャ) で、ジオメトリでないのか ──
// 観測レンダラ (server.js renderFPImageCfg) はグリッドを DDA で歩く
// レイキャスタで、**ジオメトリは原理的に見えない**。当たったセルのテクスチャを
// 配列から引くことしかできない。路面標示をジオメトリで出すと、方策に見せたく
// なった時に「標示を描く処理」を 3D 側とレイキャスタ側に二重実装することになる。
// world.js の冒頭が戒めている、まさにその罠 (マップ生成の二重実装で学習と本番が
// ズレた) を踏む。テクスチャなら 3D もレイキャストも**同じアトラスを同じマスクで
// 引くだけ**で済む。
//
// ── レイヤー分担 ──
// 下地 (アスファルト/芝/土) は従来どおり **ワールド座標 UV の継ぎ目なしタイリング**
// のまま (server.js pushQuad の 1221 行のコメントが言う「粒の繰り返しを見せない」
// 設計を維持する)。このアトラスが持つのは**その上に重ねる標示レイヤーだけ**。
//   車道の内側 = 完全透明 (alpha 0) → 下地のアスファルトがそのまま見える
//   歩道       = 不透明の舗装
//   白線/黄線/横断歩道 = 不透明の塗料
// 標示や歩道の目地はもともと規則的な繰り返しなので、セル単位 UV でも破綻しない。
//
// ── 近傍マスク ──
//   mask = (N?1:0) | (E?2:0) | (S?4:0) | (W?8:0)
//     N = MAP[r-1][c]  E = MAP[r][c+1]  S = MAP[r+1][c]  W = MAP[r][c-1]
// 16 通りを**回転させずに全部焼く**。回転を実行時にやると、その回転処理を 3D 側と
// レイキャスタ側の両方に書くことになり、ここでもまた二重実装になる。枠は 64 あるので
// 16 枠を惜しむ理由が無い。
//
// ── スロット割り当て ──
// **枠割りとマスクのビット順は ../roads.js が唯一の定義**。ここは require して使う。
// 焼く側と引く側で別々に定数を書くと、片方だけ直したときに静かにズレる。
//   0..15   class 2 (二車線)  mask 0..15
//   16..31  class 1 (一通)    mask 0..15
//   32      class 0 (歩行者専用)
//   33..63  予備 (一通の向きビット / 2セル幅の大通り用 47-blob 拡張)
//
// ── 向き ──
// タイル画像の u = +列方向 (ワールド +x)、v = +行方向 (ワールド +y)。
// v は画像の上から下へ増える = N (行-1) がタイルの上端。
// server.js の loadGroundTexture は flipY=true なので、繋がらなければ UV の v を
// 反転する (1 行)。道が隣のセルと繋がらないので間違いはすぐ分かる。

const fs   = require('fs');
const path = require('path');
const RD   = require('../roads.js');
// 道路の断面 (車道の幅・隅の丸め・横断歩道の縞) は **roads.js が持つ**。
// アトラスを焼くだけならここにあってもよかったが、観測レンダラ (床キャスト) と
// 「いま足元が歩道か車道か」の判定が同じ形を必要とするので、共有側へ移した。
const { RW2, RW1, rIn, roadSDF, cornerCenter, crosswalk,
        XW_A, XW_B, XW_PITCH, XW_DUTY } = RD;
const popcount = RD.maskDegree;   // 次数の数え上げ (roads.js の名前は maskDegree)
const PNG  = require('./png.js');

// ── アトラスの寸法 ────────────────────────────────────────────────────────────
// **枠割りは roads.js が唯一の定義**。焼く側と引く側で別々に定数を持つと、
// 片方だけ直したときに静かにズレて、道が半セルずれた絵になる。
const { TILE, GUT, CONTENT, COLS, ROWS, ATLAS } = RD;
const SS = 4;                        // スーパーサンプル倍率 (アンチエイリアス)


const EDGE_IN = 0.014, EDGE_OUT = 0.036;   // 黄色い外側線 (車道の縁の内側に引く)
const CL_HALF = 0.011;                     // センターラインの半幅 (15cm 相当)
// 破線の周期と実線長。**周期は 1 セルに整数個入る値でなければならない** (1/4)。
// 割り切れないとセル境界で位相が飛び、破線が繋がらない。
const DASH_P  = 1/4, DASH_L = 0.14;
const CURB_W  = 0.030;                     // 縁石天端の見える幅 (歩道側)
// 歩道の目地の間隔と太さ。破線と同じ理由で **1 セルに整数個** (1/12 ≒ 58cm 角)。
// 0.085 にしていたときは 1 セルに 11.76 個で、セル境界で目地がズレた
// (継ぎ目検査で 512/512 不一致になった唯一の原因がこれ)。
const PAVE_P  = 1/12, PAVE_L = 0.010;

// ── 色 ────────────────────────────────────────────────────────────────────────
const C_PAVE   = [186,189,193,255];   // 歩道
const C_JOINT  = [166,169,174,255];   // 歩道の目地
const C_CURB   = [206,208,211,255];   // 縁石の天端
const C_CJOINT = [186,188,192,255];
const C_WHITE  = [238,238,232,255];   // 白線・横断歩道
const C_YELLOW = [214,176, 48,255];   // 外側線 (駐停車禁止)
const C_CLEAR  = [0,0,0,0];           // 車道 = 透明 (下地のアスファルトが出る)

// センターラインまでの距離と、線に沿った長さ (破線の位相に使う)。
function centerline(u,v,mask,RW){
  const lo=0.5-RW, hi=0.5+RW;
  const ds=[]; for(let i=0;i<4;i++) if(mask&(1<<i)) ds.push(i);
  const n=ds.length;
  if(n===0) return null;
  if(n===2 && (ds[1]-ds[0])===2){                       // 直線 (対向)
    return ds[0]===0 ? {d:Math.abs(u-0.5), t:v} : {d:Math.abs(v-0.5), t:u};
  }
  if(n===2){                                            // 曲がり角 → 車道と同心の円弧
    const [Cu,Cv]=cornerCenter(mask, RW), Rc=rIn(RW)+RW;
    const rr=Math.hypot(u-Cu, v-Cv);
    return {d:Math.abs(rr-Rc), t:Rc*Math.atan2(Math.abs(v-Cv), Math.abs(u-Cu))};
  }
  // 交差点 (n>=3) と行き止まり (n===1) は腕ごとの直線。交差点内では引かない。
  const inner = n>=3 ? lo : 0.5;
  let best=null;
  const seg=(d,t,ok)=>{ if(ok && (!best || d<best.d)) best={d,t}; };
  if(mask&1) seg(Math.abs(u-0.5), v,     v<=inner);
  if(mask&2) seg(Math.abs(v-0.5), 1-u,   u>=1-inner);
  if(mask&4) seg(Math.abs(u-0.5), 1-v,   v>=1-inner);
  if(mask&8) seg(Math.abs(v-0.5), u,     u<=inner);
  return best;
}
// 周期パターンの帯。**線はセルの境界の上に中心を置く**。
// 位相 0 から線を始めると、線がまるごと隣のセル側に入って境界で絵が飛ぶ
// (継ぎ目検査で歩道の目地が 512/512 不一致になった原因)。境界をまたいで
// 半分ずつ描けば、隣り合うセルの接する辺のピクセルが一致する。
function bandOn(t, period, width){
  const ph=(((t%period)+period)%period);
  return Math.min(ph, period-ph) < width/2;
}
const dashOn = t => bandOn(t, DASH_P, DASH_L);


// 歩道の舗装。sd を渡すと車道寄りを縁石の天端色にする。
function paving(u,v,sd){
  const joint = bandOn(u, PAVE_P, PAVE_L) || bandOn(v, PAVE_P, PAVE_L);
  if(sd!=null && sd<CURB_W) return joint ? C_CJOINT : C_CURB;
  return joint ? C_JOINT : C_PAVE;
}

// ── 1 点の色を決める ──────────────────────────────────────────────────────────
function shade(u,v,mask,cls){
  if(cls===0) return paving(u,v,null);            // 歩行者専用 = 全面が舗装
  const RW = cls===2 ? RW2 : RW1;
  const sd = roadSDF(u,v,mask,RW);
  if(sd>0) return paving(u,v,sd);                 // 歩道側
  if(popcount(mask)>=3 && crosswalk(u,v,mask,RW)) return C_WHITE;
  if(sd>-EDGE_OUT && sd<-EDGE_IN) return C_YELLOW;
  if(cls===2){
    const cl=centerline(u,v,mask,RW);
    if(cl && cl.d<CL_HALF && dashOn(cl.t)) return C_WHITE;
  }
  return C_CLEAR;                                 // 車道 = 透明
}

// ── タイルを SS 倍で描いて縮小 ────────────────────────────────────────────────
function renderTile(mask, cls){
  const N=CONTENT*SS, out=new Uint8Array(CONTENT*CONTENT*4);
  const big=new Uint8Array(N*N*4);
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    const c=shade((x+0.5)/N, (y+0.5)/N, mask, cls), o=(y*N+x)*4;
    big[o]=c[0]; big[o+1]=c[1]; big[o+2]=c[2]; big[o+3]=c[3];
  }
  // ボックスフィルタで縮小。色はアルファで重み付け (premultiply) してから戻す。
  for(let y=0;y<CONTENT;y++)for(let x=0;x<CONTENT;x++){
    let r=0,g=0,b=0,a=0;
    for(let j=0;j<SS;j++)for(let i=0;i<SS;i++){
      const o=(((y*SS+j)*N)+(x*SS+i))*4, aa=big[o+3]/255;
      r+=big[o]*aa; g+=big[o+1]*aa; b+=big[o+2]*aa; a+=big[o+3];
    }
    const n=SS*SS, av=a/n, o=(y*CONTENT+x)*4;
    if(av>0){ const k=n*(av/255); out[o]=r/k|0; out[o+1]=g/k|0; out[o+2]=b/k|0; }
    out[o+3]=av|0;
  }
  return out;
}

// ── アトラスへ配置 (ガターは端のピクセルを複製して埋める) ─────────────────────
function place(atlas, tile, slot){
  const col=slot%COLS, row=(slot/COLS)|0;
  const ox=col*TILE, oy=row*TILE;
  for(let y=0;y<TILE;y++)for(let x=0;x<TILE;x++){
    const sx=Math.min(CONTENT-1, Math.max(0, x-GUT));   // ガター = 端の複製
    const sy=Math.min(CONTENT-1, Math.max(0, y-GUT));
    const s=(sy*CONTENT+sx)*4, d=(((oy+y)*ATLAS)+(ox+x))*4;
    atlas[d]=tile[s]; atlas[d+1]=tile[s+1]; atlas[d+2]=tile[s+2]; atlas[d+3]=tile[s+3];
  }
}

// ── 組み立て ──────────────────────────────────────────────────────────────────
const SHAPE=['孤立','行止','行止','曲り','行止','直線','曲り','T字',
             '行止','曲り','直線','T字','曲り','T字','T字','十字'];
function main(){
  const outArg=process.argv[2];
  const outPng=outArg ? path.resolve(outArg)
                      : path.join(__dirname,'..','textures','road','road_atlas.png');
  fs.mkdirSync(path.dirname(outPng), {recursive:true});
  const atlas=new Uint8Array(ATLAS*ATLAS*4);
  const slots=[];
  for(const cls of [RD.TWOLANE, RD.ONEWAY]) for(let m=0;m<16;m++){
    const s=RD.atlasSlot(cls,m); place(atlas, renderTile(m,cls), s); slots.push([s, cls, m]);
  }
  { const s=RD.atlasSlot(RD.PATH,0); place(atlas, renderTile(0,RD.PATH), s); slots.push([s, RD.PATH, 0]); }
  fs.writeFileSync(outPng, PNG.encode(atlas, ATLAS, ATLAS));

  // プレビュー: 透明部 (車道) に下地のアスファルト色を敷き、枠線を引く
  const prev=new Uint8Array(ATLAS*ATLAS*4);
  for(let i=0;i<ATLAS*ATLAS;i++){
    const a=atlas[i*4+3]/255, o=i*4;
    const bx=(i%ATLAS), by=(i/ATLAS)|0;
    const used=((by/TILE|0)*COLS + (bx/TILE|0)) <= 32;
    const bg = used ? [64,65,68] : [24,24,26];               // 未使用枠は暗く
    for(let k=0;k<3;k++) prev[o+k]=atlas[o+k]*a + bg[k]*(1-a);
    prev[o+3]=255;
    if(bx%TILE===0 || by%TILE===0){ prev[o]=90; prev[o+1]=150; prev[o+2]=200; }
  }
  const prevPng=outPng.replace(/\.png$/, '_preview.png');
  fs.writeFileSync(prevPng, PNG.encode(prev, ATLAS, ATLAS));

  console.log(`[RoadAtlas] ${path.relative(process.cwd(),outPng)}  ${ATLAS}x${ATLAS} `
            + `(${TILE}px/枠 内容${CONTENT}+ガター${GUT} / ${slots.length}枠使用 / 64枠中)`);
  console.log(`[RoadAtlas] ${path.relative(process.cwd(),prevPng)} (確認用)`);

  // ── デモ: 小さな街を実際に並べて、隣のセルと繋がるかを確認する ──
  // タイルセットの本当のテストはこれ。端の車道幅・歩道幅・黄線の位置が全タイルで
  // 揃っていないと、ここで継ぎ目がズレて一目で分かる。
  // 縁石の輪郭。server.js はこれを読んで縦の面に立ち上げる (SDF を持たずに済む)。
  const curbs={version:1,
    note:'正規化タイル座標の折れ線。頂点は [x,y,nx,ny]。x=+列(東) y=+行(南)、'
       + '(nx,ny)=車道から歩道へ向かう単位法線。tools/make-road-atlas.js が生成。',
    tile:{rw:{2:RW2, 1:RW1}}, slots:{}};
  let vtx=0, lines=0;
  for(const cls of [RD.TWOLANE, RD.ONEWAY]) for(let m=0;m<16;m++){
    const cs=contoursFor(m, cls);
    if(!cs.length) continue;
    curbs.slots[RD.atlasSlot(cls,m)]=cs;
    lines+=cs.length; for(const c of cs) vtx+=c.length;
  }
  const curbFile=outPng.replace(/[^/\\]*\.png$/, 'road_curbs.json');
  fs.writeFileSync(curbFile, JSON.stringify(curbs));
  console.log(`[RoadAtlas] ${path.relative(process.cwd(),curbFile)} `
            + `(縁石の輪郭 ${lines}本 / 頂点${vtx})`);

  const demoPng=outPng.replace(/\.png$/, "_demo.png");
  fs.writeFileSync(demoPng, PNG.encode(...renderDemo(atlas)));
  console.log(`[RoadAtlas] ${path.relative(process.cwd(),demoPng)} (並べて繋がるかの確認)`);
  console.log('  slot  class          mask  N E S W  形');
  for(const [s,c,m] of slots){
    const cn = c===2?'2 二車線':(c===1?'1 一通  ':'0 歩行者');
    const nb = [(m&1)?'N':'-', (m&2)?'E':'-', (m&4)?'S':'-', (m&8)?'W':'-'].join(' ');
    console.log(`  ${String(s).padStart(4)}  ${cn}  ${String(m).padStart(4)}  ${nb}  ${c===0?'全面舗装':SHAPE[m]}`);
  }
}

// ── 縁石の輪郭を取り出す ────────────────────────────────────────────────────
// 参考画像の「歩道が一段上がっている」感じは平らなテクスチャでは出ない。
// けれど輪郭を server.js 側で描き直すと、この SDF の二重実装になる。
// **PNG と一緒に輪郭線も書き出して、server.js にはそれを読ませる。**
//
// 出力は正規化タイル座標 [0,1] の折れ線。頂点は [x, y, nx, ny] で、
//   x = +列方向 (東)  y = +行方向 (南)   … タイル画像と同じ向き
//   (nx,ny) = SDF の勾配 = **車道から歩道へ向かう単位ベクトル**
// 法線を持たせるのは、折れ線の巻き方から向きを導くと、その導出が
// server.js 側にもう一度必要になるから (= また二重実装になる)。

const CONTOUR_N   = 64;      // マーチングスクエアの分割数
const CONTOUR_EPS = 0.001;   // 間引きの許容誤差 (正規化。0.001 ≒ 7mm)

// SDF の勾配 (中心差分) を正規化して返す。負の側が車道なので、+勾配が歩道向き。
function sdfNormal(u,v,mask,cls){
  const RW = cls===2 ? RW2 : RW1, h=0.0015;
  const gx=roadSDF(u+h,v,mask,RW)-roadSDF(u-h,v,mask,RW);
  const gy=roadSDF(u,v+h,mask,RW)-roadSDF(u,v-h,mask,RW);
  const L=Math.hypot(gx,gy)||1;
  return [gx/L, gy/L];
}

// マーチングスクエアで sdf=0 の線分を集める。
function marchSegments(mask,cls){
  const RW = cls===2 ? RW2 : RW1, N=CONTOUR_N;
  const g=new Float64Array((N+1)*(N+1));
  for(let j=0;j<=N;j++)for(let i=0;i<=N;i++) g[j*(N+1)+i]=roadSDF(i/N, j/N, mask, RW);
  const at=(i,j)=>g[j*(N+1)+i];
  const segs=[];
  // 辺の上の零点を線形補間で求める
  const lerp=(a,b)=> a===b ? 0.5 : a/(a-b);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    const d0=at(i,j), d1=at(i+1,j), d2=at(i+1,j+1), d3=at(i,j+1);
    const k=(d0<0?1:0)|(d1<0?2:0)|(d2<0?4:0)|(d3<0?8:0);
    if(k===0||k===15) continue;
    const x0=i/N, x1=(i+1)/N, y0=j/N, y1=(j+1)/N;
    const T=()=>[x0+(x1-x0)*lerp(d0,d1), y0];          // 上辺
    const R=()=>[x1, y0+(y1-y0)*lerp(d1,d2)];          // 右辺
    const B=()=>[x0+(x1-x0)*lerp(d3,d2), y1];          // 下辺
    const L=()=>[x0, y0+(y1-y0)*lerp(d0,d3)];          // 左辺
    const push=(a,b)=>segs.push([a,b]);
    switch(k){
      case 1: case 14: push(L(),T()); break;
      case 2: case 13: push(T(),R()); break;
      case 3: case 12: push(L(),R()); break;
      case 4: case 11: push(R(),B()); break;
      case 6: case  9: push(T(),B()); break;
      case 7: case  8: push(L(),B()); break;
      // 鞍点。中央の符号で 2 本の線分の繋ぎ方を決める
      case 5: case 10: {
        const mid=roadSDF((x0+x1)/2,(y0+y1)/2,mask,RW);
        if((k===5) === (mid<0)){ push(L(),T()); push(R(),B()); }
        else                   { push(T(),R()); push(L(),B()); }
        break;
      }
    }
  }
  return segs;
}

// 線分を折れ線に繋ぐ。端点が一致するものを辿るだけ (格子から出るので誤差は無い)。
function stitch(segs){
  const key=p=>p[0].toFixed(5)+','+p[1].toFixed(5);
  const ends=new Map();
  segs.forEach((sg,i)=>{ for(const p of sg){ const k=key(p);
    (ends.get(k)||ends.set(k,[]).get(k)).push(i); } });
  const used=new Array(segs.length).fill(false);
  const lines=[];
  const walk=(i,from)=>{                       // from 側から反対の端へ伸ばしていく
    const pts=[from];
    let cur=i, at=from;
    while(true){
      used[cur]=true;
      const nx = key(segs[cur][0])===key(at) ? segs[cur][1] : segs[cur][0];
      pts.push(nx); at=nx;
      const cand=(ends.get(key(at))||[]).filter(j=>!used[j]);
      if(cand.length!==1) break;               // 分岐 or 行き止まり
      cur=cand[0];
    }
    return pts;
  };
  // まず端 (片側にしか繋がらない点) から。開いた線を先に拾う
  for(let i=0;i<segs.length;i++){
    if(used[i]) continue;
    for(const p of segs[i]){
      if((ends.get(key(p))||[]).length===1){ lines.push(walk(i,p)); break; }
    }
  }
  for(let i=0;i<segs.length;i++) if(!used[i]) lines.push(walk(i, segs[i][0]));   // 閉じた輪
  return lines.filter(l=>l.length>=2);
}

// Douglas-Peucker。直線は 2 点に潰れ、円弧は許容誤差ぶんの細かさで残る。
function simplify(pts, eps){
  if(pts.length<3) return pts;
  let mi=0, md=0;
  const [ax,ay]=pts[0], [bx,by]=pts[pts.length-1];
  const dx=bx-ax, dy=by-ay, L=Math.hypot(dx,dy);
  for(let i=1;i<pts.length-1;i++){
    const [px,py]=pts[i];
    const d = L<1e-9 ? Math.hypot(px-ax,py-ay)
                     : Math.abs(dy*px - dx*py + bx*ay - by*ax)/L;
    if(d>md){ md=d; mi=i; }
  }
  if(md<=eps) return [pts[0], pts[pts.length-1]];
  return simplify(pts.slice(0,mi+1), eps).slice(0,-1).concat(simplify(pts.slice(mi), eps));
}

function contoursFor(mask, cls){
  if(cls===RD.PATH) return [];                 // 歩行者専用は全面が舗装 = 縁石が無い
  return stitch(marchSegments(mask,cls)).map(l=>{
    return simplify(l, CONTOUR_EPS).map(([x,y])=>{
      const [nx,ny]=sdfNormal(x,y,mask,cls);
      return [ +x.toFixed(4), +y.toFixed(4), +nx.toFixed(3), +ny.toFixed(3) ];
    });
  });
}

// ── デモの街 ────────────────────────────────────────────────────────────────
// 2 = 二車線 / 1 = 一通 / 0 = 歩行者専用 / . = 道でない
// 直線・曲がり角・T字・十字・行き止まり・クラスの切り替わりが全部入るように組む。
const DEMO = [
  "..2.......",
  "..2....222",
  "2222222..2",
  "..2....2..",
  "..2....2..",
  "..22201112",
  "..1....1..",
  "..1....1..",
  "..1111111.",
  "..1.......",
];
function renderDemo(atlas){
  const N=DEMO.length, PX=64, W=N*PX;
  const img=new Uint8Array(W*W*4);
  const at=(r,c)=> (r<0||r>=N||c<0||c>=N) ? "." : DEMO[r][c];
  const isRoad=(r,c)=> at(r,c)!==".";
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    const ch=at(r,c);
    // 道でないセルは芝の色で塗る
    if(ch==="."){
      for(let y=0;y<PX;y++)for(let x=0;x<PX;x++){
        const o=(((r*PX+y)*W)+(c*PX+x))*4;
        img[o]=124; img[o+1]=150; img[o+2]=92; img[o+3]=255;
      }
      continue;
    }
    const cls=+ch;
    // マスクは roads.js の実装をそのまま使う (server.js と同じ経路を通して検証する)
    const mask=RD.roadMask(DEMO.map(row=>row.split("").map(ch=>ch==="."?0:1)), r, c, 1);
    const slot = RD.atlasSlot(cls, mask);
    const sc=slot%COLS, sr=(slot/COLS)|0;
    for(let y=0;y<PX;y++)for(let x=0;x<PX;x++){
      // アトラスの「内容領域」(ガターの内側) から引く。実行時の UV と同じ計算。
      const ax=sc*TILE+GUT+Math.min(CONTENT-1,(x*CONTENT/PX)|0);
      const ay=sr*TILE+GUT+Math.min(CONTENT-1,(y*CONTENT/PX)|0);
      const s=((ay*ATLAS)+ax)*4, a=atlas[s+3]/255;
      const o=(((r*PX+y)*W)+(c*PX+x))*4;
      // 透明部 = 車道 → 下地のアスファルトが出る (本番と同じ重ね方)
      const bg=[68,69,72];
      for(let k=0;k<3;k++) img[o+k]=atlas[s+k]*a + bg[k]*(1-a);
      img[o+3]=255;
    }
  }
  return [img, W, W];
}

if(require.main===module) main();
module.exports={roadSDF, contoursFor, RW2, RW1, sdfNormal};
