#!/usr/bin/env node
'use strict';
// make-building-glb.js — 街のビルの GLB (glTF 2.0 バイナリ) を組み立てて glb/building.glb に書く。
//
//   node tools/make-building-glb.js            # glb/building.glb を作る
//   node tools/make-building-glb.js out.glb    # 出力先を変える
//
// ── 何を3Dで作り、何をテクスチャに任せるか ──
// 壁には従来どおり textures/v4/*.jpg (業種ごとのファサード写真) を貼る。
// あれは窓・入り口・看板・のれんまで描き込まれた「建物の顔」で、
// 同じものをポリゴンで作り直しても情報は増えず、写真の窓と二重になるだけだった。
// なので**このファイルが作るのは、平らなテクスチャでは絶対に出せないものだけ**:
//     ・袖看板   … ファサードから前へ突き出す縦看板。真横から近づいても見える
//     ・屋上看板 … 屋根の上に立つ大きな板。遠景でどのビルか分かる
//     ・屋上まわり … パラペット・塔屋・貯水槽。箱の「平らな頭」を崩す
//     ・ベランダ … 階ごとに前へ張り出すスラブと手すり。**3階建て以上にだけ付く**
//                  (屋台やラーメン屋にベランダは変なので server.js 側で階数を見て判断)
// 夜の窓の明かりは、テクスチャから「まわりより明るい所」だけを抜いた emissive マップで
// 出す (server.js の nightMaskFrom)。写真に描かれた窓・看板・のれんがそのまま光る。
//
// ── なぜ「1軒まるごと」ではなく**モジュール**なのか ──
// 建物の高さは BLDG_TYPES で 0.7〜3.3 セルとバラバラ (屋台からタワーまで)。
//     土台 (base) + 繰り返す1フロア (floor) + ベランダ (balcony) + 屋上 (roof)
// に分けておけば、server.js が**必要な階数ぶん積む**だけで全部の高さに対応できる。
//
// ── パーツ分け (マテリアル名) ──
// server.js はマテリアル名を見てジオメトリを4つのグループに振り分ける。
// Blender で作り直すときも、この名前さえ守れば server.js は無変更で読める。
//     facade … 壁。**業種テクスチャが貼られる面**。UV は server.js が
//              建物の実寸から箱状に貼り直すので、ここで UV を作る必要はない
//     trim   … コンクリートの単色パーツ (ベランダ・パラペット・階段・塔屋・貯水槽)
//     roof   … 屋根材。三角屋根の面。業種ごとに瓦色/スレート色が振られる
//     sign   … 看板。業種色で塗られ、夜に光る
// 上のどれにも当てはまらない名前は trim (単色) 扱いになる。
//
// ── バリエーション ──
// 全部の建物が「陸屋根 + 屋上看板 + 袖看板 + 正面が同じ向き」だと、街全体が
// コピーに見える。看板や屋根や階段は**別ノードに切り出して**、どれを積むかを
// server.js が業種と場所から決める (structVariant)。ここは部品を並べるだけ。
//
//   fp{1,2}_base        1階の躯体
//   fp{1,2}_floor       繰り返す基準階の躯体
//   fp{1,2}_balcony     ベランダ1層ぶん (フロアと同じ原点に重ねる)
//   fp{1,2}_exstair_base 外階段の1本目 (地面から2階へ。段差が H_BASE ぶん)
//   fp{1,2}_exstair      外階段2本目以降 (1層ぶん。低層の集合住宅にだけ付く)
//   fp{1,2}_roof        陸屋根 (パラペット・塔屋・貯水槽)
//   fp{1,2}_roof_gable  三角屋根 (低層の住宅・学校・寺社など)
//   fp{1,2}_sign_roof   屋上看板 (陸屋根のパラペットに跨がる)
//   fp{1,2}_sign_blade  袖看板 (1階から前へ突き出す)
//   fp{1,2}_stair       入り口の上がり階段
//
// 看板は **屋上か袖のどちらか一方**しか積まれない (両方だとしつこい)。
// 住宅・学校・警察署のように看板が要らない業種には、どちらも積まれない。
//
// 座標系は glTF そのまま (Y が上、-Z が正面)。Z-up への変換は server.js がやる。
// 建物の向き (正面をどの道路に向けるか) も server.js が回して決める。
// 単位はワールド単位そのまま (CELL=2.0 前提。1x1 の建物の幅 = 2.0*0.8 = 1.6)。

const fs = require('fs');
const path = require('path');

// ── 寸法 (ワールド単位) ──────────────────────────────────────────────────────
const CELL   = 2.0;
const WIDTH  = fp => fp * CELL * 0.8;   // addStructMesh の bw と同じ式
const H_BASE = 0.85;                    // 土台 (1階) の高さ
const H_FLR  = 0.55;                    // 1フロアの高さ

// ── ジオメトリ組み立て ───────────────────────────────────────────────────────
// mod = { マテリアル名: {pos:[], nrm:[]} }。インデックス無しの三角形で持つ。
const bucket = (m, mat) => m[mat] || (m[mat] = { pos: [], nrm: [], raw: [] });

// box() / ramp() の中で立てるフラグ。この2つの巻き順は検算済みなので、
// 自己検査 (checkWinding) は**手書きの面だけ**を見る。凹んだ形の内側の面まで
// 拾うと警告だらけになって、本物の裏返りが埋もれる。
let _trusted = 0;

function tri(m, mat, a, b, c){
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  let n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const l = Math.hypot(n[0],n[1],n[2]) || 1;
  n = [n[0]/l, n[1]/l, n[2]/l];
  const t = bucket(m, mat);
  for(const p of [a,b,c]){ t.pos.push(p[0],p[1],p[2]); t.nrm.push(n[0],n[1],n[2]); }
  t.raw.push(_trusted === 0);
}
const quad = (m,mat,a,b,c,d) => { tri(m,mat,a,b,c); tri(m,mat,a,c,d); };

// (z0,y0) から (z1,y1) へ斜めに架かる板。x は x0..x1、厚み t は縦方向。
// 階段のささら桁と斜めの手すりに使う (箱を並べるだけでは斜めの線が作れない)。
function ramp(m, mat, x0,x1, z0,y0, z1,y1, t){
  _trusted++;
  const a0=[x0,y0,z0], b0=[x1,y0,z0], a1=[x0,y1,z1], b1=[x1,y1,z1];
  const A0=[x0,y0+t,z0], B0=[x1,y0+t,z0], A1=[x0,y1+t,z1], B1=[x1,y1+t,z1];
  quad(m,mat, A0,B0,B1,A1);   // 上面
  quad(m,mat, a1,b1,b0,a0);   // 下面
  quad(m,mat, a0,b0,B0,A0);   // z0 側の小口
  quad(m,mat, b1,a1,A1,B1);   // z1 側の小口
  quad(m,mat, a1,a0,A0,A1);   // x0 側面
  quad(m,mat, b0,b1,B1,B0);   // x1 側面
  _trusted--;
}

// 直方体。faces で描く面を選ぶ (積み上げて隠れる面は省いて三角形を減らす)。
//   小文字 = 負の面 / 大文字 = 正の面
function box(m, mat, x0,x1, y0,y1, z0,z1, faces){
  _trusted++;
  const f = faces || 'xXyYzZ';
  if(f.includes('X')) quad(m,mat, [x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]);
  if(f.includes('x')) quad(m,mat, [x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]);
  if(f.includes('Y')) quad(m,mat, [x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]);
  if(f.includes('y')) quad(m,mat, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]);
  if(f.includes('Z')) quad(m,mat, [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]);
  if(f.includes('z')) quad(m,mat, [x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]);
  _trusted--;
}

// ── 土台 (1階) ───────────────────────────────────────────────────────────────
// 躯体だけ。入り口・ショーウィンドウ・軒先の看板はテクスチャが描いている。
function makeBase(fp){
  const m = {}, h = WIDTH(fp)/2;
  box(m,'facade', -h,h, 0,H_BASE, -h,h, 'xXzZ');   // 上下の面は隣で隠れる
  return m;
}

// ── 繰り返す1フロア ─────────────────────────────────────────────────────────
function makeFloor(fp){
  const m = {}, h = WIDTH(fp)/2;
  box(m,'facade', -h,h, 0,H_FLR, -h,h, 'xXzZ');
  return m;
}

// ── ベランダ (1フロアぶん) ──────────────────────────────────────────────────
// 張り出しは控えめにし、スラブを厚くして中央に間仕切りを入れる。
// 深く薄い一枚板だと、写真の壁の前に灰色の板が**浮いている**ようにしか見えなかった。
function makeBalcony(fp){
  const m = {}, W = WIDTH(fp), h = W/2, bw = W*0.42, d = 0.16;
  box(m,'trim', -bw, bw, 0.07, 0.135, -h-d, -h);              // 床スラブ (厚め)
  box(m,'trim', -bw, bw, 0.135, 0.30, -h-d, -h-d+0.04);       // 手すり壁
  box(m,'trim', -bw, -bw+0.04, 0.135, 0.29, -h-d, -h);        // 左の袖壁
  box(m,'trim',  bw-0.04, bw,  0.135, 0.29, -h-d, -h);        // 右の袖壁
  box(m,'trim', -0.02, 0.02,  0.135, 0.29, -h-d, -h);         // 中央の間仕切り (2戸に見せる)
  return m;
}

// ── 外階段 (1本ぶん) ────────────────────────────────────────────────────────
// 低層の集合住宅に付く「外階段 + 外廊下」。左側面 (-X) を背面 (+Z) から正面 (-Z) へ上り、
// 上りきった高さに廊下を1本通す。次のモジュールがその上からまた上り始めるので段が繋がる。
//
// ★ 段は**下まで詰まった塊**にすること。踏面だけを浮かせて作ったら、
//   壁に灰色の板が散らばっているようにしか見えなかった (階段に見えない)。
//   1階ぶんだけ段差 (H_BASE) が違うので、上る高さを引数で受ける。
function makeExStairRun(fp, total){
  // 側面いっぱいに広げない。幅を取りすぎると「灰色の格子で覆われた建物」になる。
  const m = {}, W = WIDTH(fp), h = W/2, dx = Math.min(0.26, W*0.17), p = h*0.64;
  const N = 5, rise = total/N, run = (2*p)/N;
  const x0 = -h-dx, x1 = -h;
  // 斜めのささら桁。**これが無いと踏面が宙に浮いて見える** (最初はこれを忘れて、
  // 壁に灰色の板が散らばっているようにしか見えなかった)。かといって段を下まで
  // 詰まった塊にすると、側面まるごとが灰色の壁になってしまう。桁 + 薄い踏面が正解。
  ramp(m,'trim', x0, x1, p, -0.03, -p, total-rise-0.03, 0.07);
  for(let i=0;i<N;i++){                                   // 踏面
    const z1 = p - i*run, z0 = p - (i+1)*run;
    box(m,'trim', x0, x1, (i+1)*rise-0.045, (i+1)*rise, z0, z1, 'xXYzZ');
  }
  ramp(m,'trim', x0, x0+0.045, p, 0.30, -p, total+0.28, 0.24);        // 斜めの手すり
  box(m,'trim', x0, x1, total-0.07, total, -p, p, 'xyYzZ');           // 上の外廊下
  box(m,'trim', x0, x0+0.045, total, total+0.22, -p, p, 'xXYzZ');     // 廊下の手すり
  return m;
}

// ── 入り口の上がり階段 ──────────────────────────────────────────────────────
// 正面 (-Z) の扉の前に3段。テクスチャの扉がそのぶん高い位置に見えるようになる。
function makeStair(fp){
  const m = {}, W = WIDTH(fp), h = W/2, sw = Math.min(W*0.20, 0.42), r = 0.057, d = 0.075;
  for(let i=0;i<3;i++)
    box(m,'trim', -sw, sw, 0, (3-i)*r, -h-d*(i+1), -h-d*i, 'xXYz');
  box(m,'trim', -sw-0.04, -sw, 0, 3*r+0.05, -h-d*3, -h);   // 左の側壁
  box(m,'trim',  sw, sw+0.04, 0, 3*r+0.05, -h-d*3, -h);    // 右の側壁
  return m;
}

// ── 陸屋根 ──────────────────────────────────────────────────────────────────
// パラペット・塔屋・貯水槽。箱の「平らな頭」を崩してシルエットを作る。
function makeRoof(fp){
  const m = {}, W = WIDTH(fp), h = W/2;
  box(m,'trim', -h-0.03,h+0.03, 0,0.13, -h-0.03,h+0.03, 'xXYzZ');       // パラペット
  box(m,'trim', -W*0.17, W*0.17, 0.13, 0.30, -W*0.02, W*0.30, 'xXYzZ'); // 塔屋
  const tx = W*0.26;
  box(m,'trim', tx-0.06, tx+0.06, 0.13, 0.19, -W*0.22, -W*0.10);        // 貯水槽の脚
  box(m,'trim', tx-0.10, tx+0.10, 0.19, 0.31, -W*0.26, -W*0.06);        // 貯水槽
  return m;
}

// ── 三角屋根 ────────────────────────────────────────────────────────────────
// 棟は X 方向 (正面 -Z から見ると三角に見えない = 妻側が左右)。
// 軒を壁より外へ出す。出さないと「箱に三角の帽子を載せた」ようにしか見えない。
function makeGable(fp){
  const m = {}, W = WIDTH(fp), h = W/2, e = Math.min(0.12, W*0.075);
  const o = h + e, y0 = 0.05, y1 = 0.05 + W*0.30;
  box(m,'trim', -o, o, 0, y0, -o, o, 'xXyzZ');                     // 軒の見切り (鼻隠し)
  // ★ 巻き順は「外から見て反時計回り」。逆にすると背面カリングで手前の面が消え、
  //   奥の面だけが透けて見える (最初これで4面とも裏返っていた)。
  //   下の checkWinding() が、法線がモジュールの内側を向いている面を叩いてくれる。
  quad(m,'roof', [-o,y0,-o],[-o,y1, 0],[ o,y1, 0],[ o,y0,-o]);     // 前の屋根面 (法線 上+前)
  quad(m,'roof', [ o,y0, o],[ o,y1, 0],[-o,y1, 0],[-o,y0, o]);     // 後ろの屋根面 (法線 上+後)
  tri (m,'roof', [ o,y0,-o],[ o,y1, 0],[ o,y0, o]);                // 右の妻 (法線 +X)
  tri (m,'roof', [-o,y0,-o],[-o,y0, o],[-o,y1, 0]);                // 左の妻 (法線 -X)
  const cw = W*0.09, cz = W*0.16;                                  // 煙突。棟の線を1か所崩す
  box(m,'trim', -cw*2.2, -cw*0.4, y0, y1*0.92, cz-cw, cz+cw);
  return m;
}

// ── 屋上看板 ────────────────────────────────────────────────────────────────
// **正面のパラペットに跨がせて載せる**。
//   以前は屋上の中央に自立させていたが、パラペットより上には建物が無いので、
//   どの角度から見ても「屋根の上に板が浮いている」ようにしか見えなかった
//   (支柱を入れてはいたが細すぎて何も支えていないように見える)。
//   下端を最上階の壁の前まで下ろすと、建物と地続きの色帯になる。
// 高さは頭打ちにする — 2x2 で幅なりに大きくすると「屋根に蓋」に見えた。
// 寄棟屋根。切妻と違って四方に流れるので、棟の線が短くなり印象が変わる。
// 低層の住宅・寺社・学校が並んだとき、全部が切妻だとコピーに見えるので混ぜる。
function makeHip(fp){
  const m = {}, W = WIDTH(fp), h = W/2, e = Math.min(0.12, W*0.075);
  const o = h + e, y0 = 0.05, y1 = 0.05 + W*0.26, rx = o*0.34;   // rx = 棟の長さの半分
  box(m,'trim', -o, o, 0, y0, -o, o, 'xXyzZ');                   // 軒の見切り
  // 巻き順は「外から見て反時計回り」。makeGable と同じ並びで、棟を短くしただけ。
  quad(m,'roof', [-o,y0,-o],[-rx,y1, 0],[ rx,y1, 0],[ o,y0,-o]); // 前の流れ
  quad(m,'roof', [ o,y0, o],[ rx,y1, 0],[-rx,y1, 0],[-o,y0, o]); // 後ろの流れ
  tri (m,'roof', [ o,y0,-o],[ rx,y1, 0],[ o,y0, o]);             // 右の流れ
  tri (m,'roof', [-o,y0,-o],[-o,y0, o],[-rx,y1, 0]);             // 左の流れ
  return m;
}

// 陸屋根のもう一種。パラペットは同じだが、塔屋を反対側に寄せ、貯水槽の代わりに
// 室外機を並べる。同じ高さのビルが並んだとき屋上の表情が変わる。
function makeRoof2(fp){
  const m = {}, W = WIDTH(fp), h = W/2;
  box(m,'trim', -h-0.03,h+0.03, 0,0.15, -h-0.03,h+0.03, 'xXYzZ');   // パラペット (少し高い)
  box(m,'trim', -W*0.30,-W*0.02, 0.15, 0.34, W*0.02, W*0.30, 'xXYzZ'); // 塔屋 (奥の左)
  for(let i=0;i<3;i++){                                              // 室外機を 3 台
    const zx = -W*0.26 + i*W*0.20;
    box(m,'trim', W*0.10, W*0.30, 0.15, 0.24, zx-W*0.07, zx+W*0.07);
  }
  return m;
}

// 庇 (テント)。前へ張り出して 1 階に影を作る。業種色が乗るので 'sign' に置く。
// 店・飲食店に付けると「そこが入り口だ」と一目で分かるようになる。
function makeAwning(fp){
  const m = {}, W = WIDTH(fp), h = W/2;
  const y = H_BASE*0.66, d = Math.min(0.22, W*0.14), x = h*0.86;
  quad(m,'sign', [-x,y,-h], [-x,y-0.05,-h-d], [x,y-0.05,-h-d], [x,y,-h]);  // 天板 (前下がり)
  box(m,'sign', -x, x, y-0.14, y-0.05, -h-d-0.015, -h-d);                  // 前縁の垂れ
  for(const sx of [-x*0.88, x*0.88])                                       // 受けの腕
    box(m,'trim', sx-0.018, sx+0.018, y-0.11, y, -h-d, -h);
  return m;
}

// 塀と門。敷地を囲って前だけ開ける。住宅が「家」に見えるようになる。
// 建物の幅は CELL*0.8 なので、CELL*1.0 のセルに対して外側に少し余裕がある。
function makeFence(fp){
  const m = {}, W = WIDTH(fp), h = W/2;
  const o = h + Math.min(0.20, W*0.12), t = 0.04, y = 0.22, g = W*0.17;   // g = 門の開口の半分
  box(m,'trim', -o, -o+t, 0, y, -o, o);          // 左
  box(m,'trim',  o-t, o,  0, y, -o, o);          // 右
  box(m,'trim', -o, o, 0, y, o-t, o);            // 後ろ
  box(m,'trim', -o, -g, 0, y, -o, -o+t);         // 前 (門の左)
  box(m,'trim',  g, o,  0, y, -o, -o+t);         // 前 (門の右)
  for(const sx of [-g, g])                       // 門柱
    box(m,'trim', sx-0.05, sx+0.05, 0, y*1.55, -o-0.012, -o+t+0.012);
  return m;
}

function makeSignRoof(fp){
  const m = {}, W = WIDTH(fp), h = W/2;
  const sw = W*0.44, sy0 = -0.10, sy1 = 0.13 + Math.min(W*0.13, 0.26);
  const sz0 = -h-0.10, sz1 = -h-0.02;              // パラペット前面 (-h-0.03) を挟む厚み
  box(m,'sign', -sw, sw, sy0, sy1, sz0, sz1);
  box(m,'trim', -sw-0.03, sw+0.03, sy0-0.05, sy0+0.02, sz0-0.01, sz1+0.01);   // 下端の見切り
  box(m,'trim', -sw-0.03, -sw, sy0, sy1, sz0-0.01, sz1+0.01);                 // 左の枠
  box(m,'trim',  sw, sw+0.03, sy0, sy1, sz0-0.01, sz1+0.01);                  // 右の枠
  return m;
}

// ── 袖看板 ──────────────────────────────────────────────────────────────────
// 1階から前へ突き出す縦看板。ファサード写真には描けないパーツ。
function makeSignBlade(fp){
  const m = {}, W = WIDTH(fp), h = W/2, bx = h*0.62;
  box(m,'sign', bx-0.03, bx+0.03, 0.26, H_BASE-0.06, -h-0.34, -h-0.04);
  box(m,'trim', bx-0.02, bx+0.02, H_BASE-0.10, H_BASE-0.04, -h-0.20, -h);   // 取付金具
  return m;
}

// ── 巻き順の自己検査 ────────────────────────────────────────────────────────
// 三角形の法線が「モジュールの中心を向いている」ものを探す。裏返った面は
// 背面カリングで消えて**手前の面が抜け、奥の面だけが透けて見える**ので、
// レンダリングするまで気づけない。三角屋根の4面がまさにこれで全部裏返っていた。
//   ・見るのは **box()/ramp() を通していない手書きの面だけ**
//     (凹んだ形の内側の面まで拾うと警告だらけになって本物が埋もれる)
//   ・箱と斜め板の巻き順は検算済みなので除外してよい
function checkWinding(name, mod){
  let mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
  for(const mat in mod){
    const P=mod[mat].pos;
    for(let i=0;i<P.length;i+=3) for(let j=0;j<3;j++){
      if(P[i+j]<mn[j]) mn[j]=P[i+j];
      if(P[i+j]>mx[j]) mx[j]=P[i+j];
    }
  }
  const c=[0,1,2].map(j=>(mn[j]+mx[j])/2);
  const bad=[];
  for(const mat in mod){
    const P=mod[mat].pos, N=mod[mat].nrm, raw=mod[mat].raw;
    for(let t=0;t<P.length;t+=9){
      if(!raw[t/9]) continue;                                 // box()/ramp() 製は検算済み
      const g=[0,1,2].map(j=>(P[t+j]+P[t+3+j]+P[t+6+j])/3);   // 三角形の重心
      const d=[0,1,2].map(j=>g[j]-c[j]);
      const len=Math.hypot(d[0],d[1],d[2]);
      if(len<1e-4) continue;
      const dot=(N[t]*d[0]+N[t+1]*d[1]+N[t+2]*d[2])/len;
      if(dot < -0.25) bad.push(mat);                          // はっきり内向き
    }
  }
  if(bad.length){
    const cnt={}; for(const b of bad) cnt[b]=(cnt[b]||0)+1;
    console.warn(`  ⚠ ${name}: 法線が内向きの面 `
      + Object.entries(cnt).map(([k,v])=>`${k}:${v}`).join(' ')
      + ' ← 巻き順が逆。外から見て反時計回りに並べ直すこと');
  }
}

// ── glTF マテリアル (色は server.js が建物ごとに差し替える。ここは目安) ──────
const MATERIALS = [
  { name:'facade', color:[0.78,0.77,0.74,1], emis:[0,0,0] },
  { name:'trim',   color:[0.69,0.70,0.67,1], emis:[0,0,0] },
  { name:'roof',   color:[0.45,0.32,0.28,1], emis:[0,0,0] },
  { name:'sign',   color:[0.85,0.30,0.25,1], emis:[0.5,0.18,0.15] },
];
const MAT_IDX = Object.fromEntries(MATERIALS.map((m,i)=>[m.name,i]));

// ── GLB を書き出す ──────────────────────────────────────────────────────────
function writeGlb(outPath, mods){
  const json = {
    asset: { version:'2.0', generator:'mesa-clouds-renderer tools/make-building-glb.js' },
    scene: 0, scenes: [{ nodes: [] }],
    nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  json.materials = MATERIALS.map(m => ({
    name: m.name,
    pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 0.85 },
    emissiveFactor: m.emis,
  }));

  const chunks = []; let binLen = 0;
  const addAccessor = (arr, withMinMax) => {
    const buf = Buffer.from(new Float32Array(arr).buffer);
    const off = binLen;
    chunks.push(buf); binLen += buf.length;
    json.bufferViews.push({ buffer:0, byteOffset:off, byteLength:buf.length, target:34962 });
    const acc = { bufferView: json.bufferViews.length-1, componentType:5126,
                  count: arr.length/3, type:'VEC3' };
    if(withMinMax){
      const mn=[ Infinity, Infinity, Infinity], mx=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<arr.length;i+=3) for(let j=0;j<3;j++){
        if(arr[i+j]<mn[j]) mn[j]=arr[i+j];
        if(arr[i+j]>mx[j]) mx[j]=arr[i+j];
      }
      acc.min=mn; acc.max=mx;
    }
    json.accessors.push(acc);
    return json.accessors.length-1;
  };

  for(const { name, mod } of mods){
    const prims = [];
    for(const mat of Object.keys(mod)){
      const b = mod[mat];
      if(!b.pos.length) continue;
      prims.push({ attributes:{ POSITION:addAccessor(b.pos,true), NORMAL:addAccessor(b.nrm,false) },
                   material: MAT_IDX[mat], mode:4 });
    }
    json.meshes.push({ name, primitives: prims });
    json.nodes.push({ name, mesh: json.meshes.length-1 });
    json.scenes[0].nodes.push(json.nodes.length-1);
  }
  json.buffers[0].byteLength = binLen;

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if(jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4-jsonBuf.length%4, 0x20)]);
  let binBuf = Buffer.concat(chunks);
  if(binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4-binBuf.length%4, 0)]);

  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8+jsonBuf.length + 8+binBuf.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length,0); jh.write('JSON',4,'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length,0);  bh.write('BIN\0',4,'ascii');
  fs.writeFileSync(outPath, Buffer.concat([head, jh, jsonBuf, bh, binBuf]));
  return { bytes: 12+8+jsonBuf.length+8+binBuf.length, json };
}

// ── main ────────────────────────────────────────────────────────────────────
const out = process.argv[2] || path.join(__dirname, '..', 'glb', 'building.glb');
fs.mkdirSync(path.dirname(out), { recursive: true });

const mods = [];
for(const fp of [1,2]){
  mods.push({ name:`fp${fp}_base`,       mod: makeBase(fp) });
  mods.push({ name:`fp${fp}_floor`,      mod: makeFloor(fp) });
  mods.push({ name:`fp${fp}_balcony`,    mod: makeBalcony(fp) });
  mods.push({ name:`fp${fp}_exstair_base`, mod: makeExStairRun(fp, H_BASE) });
  mods.push({ name:`fp${fp}_exstair`,      mod: makeExStairRun(fp, H_FLR) });
  mods.push({ name:`fp${fp}_stair`,      mod: makeStair(fp) });
  mods.push({ name:`fp${fp}_roof`,       mod: makeRoof(fp) });
  mods.push({ name:`fp${fp}_roof_gable`, mod: makeGable(fp) });
  mods.push({ name:`fp${fp}_roof_hip`,   mod: makeHip(fp) });
  mods.push({ name:`fp${fp}_roof2`,      mod: makeRoof2(fp) });
  mods.push({ name:`fp${fp}_awning`,     mod: makeAwning(fp) });
  mods.push({ name:`fp${fp}_fence`,      mod: makeFence(fp) });
  mods.push({ name:`fp${fp}_sign_roof`,  mod: makeSignRoof(fp) });
  mods.push({ name:`fp${fp}_sign_blade`, mod: makeSignBlade(fp) });
}
const { bytes, json } = writeGlb(out, mods);
const tris = json.accessors.filter((_,i)=>i%2===0).reduce((s,a)=>s+a.count,0)/3;
console.log(`[make-building-glb] ${path.relative(process.cwd(), out)} を書きました`);
console.log(`  ノード ${json.nodes.length} / マテリアル ${json.materials.length} / 三角形 ${tris} / ${(bytes/1024).toFixed(1)} KB`);
for(const { name, mod } of mods){
  const n = Object.entries(mod).map(([k,v])=>`${k}:${v.pos.length/9}`).join(' ');
  console.log(`  ${name.padEnd(16)} ${n}`);
  checkWinding(name, mod);
}
