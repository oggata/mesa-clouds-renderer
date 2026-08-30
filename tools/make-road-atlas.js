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
// ── スロット割り当て (8x8 = 64 枠) ──
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
const zlib = require('zlib');

// ── アトラスの寸法 ────────────────────────────────────────────────────────────
const TILE    = 128;                 // 1 枠 (px)
const GUT     = 8;                   // ガター (px)。ミップマップのにじみ防止
const CONTENT = TILE - GUT*2;        // 実際に絵が入る領域 = 112
const COLS = 8, ROWS = 8;
const ATLAS = TILE * COLS;           // 1024 (2の冪 — WebGL1 の繰り返し要件)
const SS    = 4;                     // スーパーサンプル倍率 (アンチエイリアス)

// ── 街の寸法 (正規化 0..1 = 1セル ≒ 7m) ───────────────────────────────────────
const RW2   = 0.33;   // 二車線: 車道の半幅 → 車道 4.6m / 歩道 1.2m x2
const RW1   = 0.24;   // 一通:   車道の半幅 → 車道 3.4m / 歩道 1.8m x2
// 曲がり角の内側の縁石の半径。**歩道の幅に連動させる**。
// 固定値にすると、歩道が広い一通 (class 1) で角の歩道が円形の島に潰れる。
// 角の歩道がセルの角と繋がる条件は R >= 歩道幅 * sqrt(2)/(1+sqrt(2)) = 0.586 倍
// (角 (1,0) から曲率中心までの距離 = (歩道幅-R)*sqrt(2) <= R より)。0.85 倍で余裕を取る。
const RIN_K = 0.85;
const rIn = RW => RIN_K*(0.5-RW);
// 外側の縁石は rIn + 車道幅 の**同心円**になる (実際の道路と同じ)。

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
const XW_A = 0.012, XW_B = 0.014;          // 横断歩道の帯の前後マージン
const XW_P = 0.055, XW_T = 0.032;          // 横断歩道の縞の周期と太さ

// ── 色 ────────────────────────────────────────────────────────────────────────
const C_PAVE   = [186,189,193,255];   // 歩道
const C_JOINT  = [166,169,174,255];   // 歩道の目地
const C_CURB   = [206,208,211,255];   // 縁石の天端
const C_CJOINT = [186,188,192,255];
const C_WHITE  = [238,238,232,255];   // 白線・横断歩道
const C_YELLOW = [214,176, 48,255];   // 外側線 (駐停車禁止)
const C_CLEAR  = [0,0,0,0];           // 車道 = 透明 (下地のアスファルトが出る)

// ── SDF ヘルパ ────────────────────────────────────────────────────────────────
// 矩形の符号付き距離。負 = 内側。
function sdBox(px,py, x0,y0,x1,y1){
  const cx=(x0+x1)/2, cy=(y0+y1)/2, hx=(x1-x0)/2, hy=(y1-y0)/2;
  const dx=Math.abs(px-cx)-hx, dy=Math.abs(py-cy)-hy;
  return Math.hypot(Math.max(dx,0), Math.max(dy,0)) + Math.min(Math.max(dx,dy), 0);
}
const popcount = m => ((m&1)?1:0)+((m&2)?1:0)+((m&4)?1:0)+((m&8)?1:0);

// 隅の象限。q は「dir q と dir q+1 の間」。P = セル中心にいちばん近い角、
// (su,sv) = そこから象限の内側へ向かう符号。
//   q=0 NE(N&E)  q=1 SE(E&S)  q=2 SW(S&W)  q=3 NW(W&N)
function quadrants(lo, hi){
  return [
    {a:0,b:1, box:[hi, 0, 1, lo], pu:hi, pv:lo, su:+1, sv:-1},
    {a:1,b:2, box:[hi,hi, 1,  1], pu:hi, pv:hi, su:+1, sv:+1},
    {a:2,b:3, box:[ 0,hi,lo,  1], pu:lo, pv:hi, su:-1, sv:+1},
    {a:3,b:0, box:[ 0, 0,lo, lo], pu:lo, pv:lo, su:-1, sv:-1},
  ];
}

// 車道領域の SDF。負 = 車道の内側。
//   腕 (arm) の和 ∪ 隅のフィレット。
//   隣り合う2方向がどちらも道 → 内側の角を rIn(RW) で丸める (車道が歩道側へ膨らむ)
//   隣り合う2方向だけが道 (= 曲がり角) は腕の和では作らず、**同心の円環**にする。
//     内側の縁石 = 半径 rIn(RW) / 外側の縁石 = 半径 rIn(RW) + 車道幅、中心は共通。
//     こうすると内外のカーブが実際の道路と同じ同心円になり、腕の和 + 角の面取り
//     では出せない滑らかさが出る (面取り方式だと外側に三角形の破片が残った)。
function roadSDF(u,v,mask,RW){
  const lo=0.5-RW, hi=0.5+RW;
  if(popcount(mask)===2 && mask!==5 && mask!==10) return cornerSDF(u,v,mask,RW);
  let d=1e9;
  if(mask&1) d=Math.min(d, sdBox(u,v,  lo,-0.5,  hi, hi));   // N
  if(mask&2) d=Math.min(d, sdBox(u,v,  lo,  lo, 1.5, hi));   // E
  if(mask&4) d=Math.min(d, sdBox(u,v,  lo,  lo,  hi,1.5));   // S
  if(mask&8) d=Math.min(d, sdBox(u,v,-0.5,  lo,  hi, hi));   // W
  const r=rIn(RW);
  for(const q of quadrants(lo,hi)){
    const ca=!!(mask&(1<<q.a)), cb=!!(mask&(1<<q.b));
    if(!(ca&&cb)) continue;                    // 両側が道の隅だけ丸める
    const Cu=q.pu+q.su*r, Cv=q.pv+q.sv*r;
    d=Math.min(d, Math.max(sdBox(u,v,...q.box), r-Math.hypot(u-Cu, v-Cv)));
  }
  return d;
}

// 曲がり角の曲率中心。内側の縁石が「N/S 側の腕の側面」と「E/W 側の腕の側面」の
// 両方に接する点として一意に決まる (接する条件から C = 側面 ± rIn(RW))。
function cornerCenter(mask, RW){
  const lo=0.5-RW, hi=0.5+RW, r=rIn(RW);
  return [ (mask&2) ? hi+r : lo-r,            // E が道なら右寄り、W なら左寄り
           (mask&4) ? hi+r : lo-r ];          // S が道なら下寄り、N なら上寄り
}
// 曲がり角の車道 = 同心円環。中心が必ずセルの角に来るので、単位セル内に現れるのは
// ちょうど四半分だけ = 余計なクリップが要らない。
function cornerSDF(u,v,mask,RW){
  const [Cu,Cv]=cornerCenter(mask, RW), r=rIn(RW);
  const d=Math.hypot(u-Cu, v-Cv);
  return Math.max(d-(2*RW+r), r-d);
}

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

// 横断歩道。交差点 (n>=3) の各腕の、セル端と交差点ボックスの間の帯に縞を引く。
// 縞は進行方向に直交して伸び、進行方向に沿って繰り返す (アビーロード式)。
function crosswalk(u,v,mask,RW){
  const lo=0.5-RW, hi=0.5+RW;
  const arms=[[1, v,   u], [2, 1-u, v], [4, 1-v, u], [8, u,   v]];
  for(const [bit, s, w] of arms){
    if(!(mask&bit)) continue;
    if(w<lo || w>hi) continue;                 // その腕の車道幅の中だけ
    if(s<XW_A || s>lo-XW_B) continue;
    if((((s-XW_A)/XW_P)%1)*XW_P < XW_T) return true;
  }
  return false;
}

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

// ── PNG エンコーダ (依存パッケージ無し) ───────────────────────────────────────
const CRC_T=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;
  for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c;}return t;})();
function crc32(buf){let c=-1;for(let i=0;i<buf.length;i++)c=CRC_T[(c^buf[i])&0xFF]^(c>>>8);return (c^-1)>>>0;}
function chunk(type, data){
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length,0);
  const td=Buffer.concat([Buffer.from(type,'ascii'), data]);
  const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(td),0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h){
  const raw=Buffer.alloc(h*(w*4+1));
  for(let y=0;y<h;y++){ raw[y*(w*4+1)]=0;                       // filter 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset+y*w*4, w*4).copy(raw, y*(w*4+1)+1); }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;     // 8bit RGBA
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR',ihdr), chunk('IDAT',zlib.deflateSync(raw,{level:9})), chunk('IEND',Buffer.alloc(0))]);
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
  for(let m=0;m<16;m++){ place(atlas, renderTile(m,2), m);    slots.push([m, 2, m]); }
  for(let m=0;m<16;m++){ place(atlas, renderTile(m,1), 16+m); slots.push([16+m, 1, m]); }
  place(atlas, renderTile(0,0), 32); slots.push([32, 0, 0]);
  fs.writeFileSync(outPng, encodePNG(atlas, ATLAS, ATLAS));

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
  fs.writeFileSync(prevPng, encodePNG(prev, ATLAS, ATLAS));

  console.log(`[RoadAtlas] ${path.relative(process.cwd(),outPng)}  ${ATLAS}x${ATLAS} `
            + `(${TILE}px/枠 内容${CONTENT}+ガター${GUT} / ${slots.length}枠使用 / 64枠中)`);
  console.log(`[RoadAtlas] ${path.relative(process.cwd(),prevPng)} (確認用)`);

  // ── デモ: 小さな街を実際に並べて、隣のセルと繋がるかを確認する ──
  // タイルセットの本当のテストはこれ。端の車道幅・歩道幅・黄線の位置が全タイルで
  // 揃っていないと、ここで継ぎ目がズレて一目で分かる。
  const demoPng=outPng.replace(/\.png$/, "_demo.png");
  fs.writeFileSync(demoPng, encodePNG(...renderDemo(atlas)));
  console.log(`[RoadAtlas] ${path.relative(process.cwd(),demoPng)} (並べて繋がるかの確認)`);
  console.log('  slot  class          mask  N E S W  形');
  for(const [s,c,m] of slots){
    const cn = c===2?'2 二車線':(c===1?'1 一通  ':'0 歩行者');
    const nb = [(m&1)?'N':'-', (m&2)?'E':'-', (m&4)?'S':'-', (m&8)?'W':'-'].join(' ');
    console.log(`  ${String(s).padStart(4)}  ${cn}  ${String(m).padStart(4)}  ${nb}  ${c===0?'全面舗装':SHAPE[m]}`);
  }
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
    const mask=(isRoad(r-1,c)?1:0)|(isRoad(r,c+1)?2:0)|(isRoad(r+1,c)?4:0)|(isRoad(r,c-1)?8:0);
    const slot = cls===0 ? 32 : (cls===2?0:16)+mask;
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

main();
