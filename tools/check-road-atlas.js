#!/usr/bin/env node
'use strict';
// check-road-atlas.js — road_atlas.png の継ぎ目を検査する。
//
//   node tools/check-road-atlas.js
//
// オートタイルは「どの組み合わせで隣り合っても繋がる」ことが前提なので、
// 見た目で1枚ずつ確認しても意味が無い。**接しうる全ペアの辺**を突き合わせる。
//
// 何を見るか:
//   1. 構造の一致 — 車道の幅と位置が両側で揃っているか (px 単位)。ここがズレると
//      道幅が段違いになって一目で分かる。許容 1px 未満。
//   2. 縁石のサブピクセル位置 — 辺の各ピクセルの「車道の被覆率」(1-alpha) を比べる。
//      生の色差で見ると、境界 1px のアンチエイリアスが 214/255 のような大きな数字に
//      なって本物の不一致と区別が付かない。被覆率なら「何px ぶんズレたか」で読める。
//      曲がり角は円弧がセル端に対して厳密には接しない (曲率中心がセル内にあるため)
//      ので 0.3px 程度は必ず残る。0.5px 未満なら見た目には出ない。
//   3. 塗りの色 — 両側とも不透明なピクセルどうしの RGB。周期パターン (破線・歩道の
//      目地) の位相が境界で飛んでいるとここに出る。
//   4. 縁石の輪郭 (road_curbs.json) と PNG の一致 — 輪郭の各頂点で、法線の
//      内側が車道・外側が歩道になっているか。PNG と JSON は同じ SDF から作られる
//      ので本来ズレようが無いが、**片方だけ焼き直したときに静かにズレる**。
//      server.js は JSON を信じて縦の面を立てるので、ここが狂うと縁石が
//      道の真ん中や歩道の奥に立つ。

const fs=require('fs'), path=require('path');
const PNG=require('./png.js');

const TILE=128, GUT=8, CONTENT=112, COLS=8;
const file=process.argv[2] || path.join(__dirname,'..','textures','road','road_atlas.png');

const img=PNG.decode(fs.readFileSync(file));
const org=s=>[(s%COLS)*TILE+GUT, ((s/COLS)|0)*TILE+GUT];
// 辺のピクセル列。dir 0=N(上端) 1=E(右端) 2=S(下端) 3=W(左端)。
// N/S は左→右、E/W は上→下で走査するので、向かい合う辺は同じ順序で並ぶ。
function edge(slot,dir){
  const [ox,oy]=org(slot), out=[];
  for(let i=0;i<CONTENT;i++){
    if(dir===0) out.push(img.px(ox+i, oy));
    else if(dir===1) out.push(img.px(ox+CONTENT-1, oy+i));
    else if(dir===2) out.push(img.px(ox+i, oy+CONTENT-1));
    else out.push(img.px(ox, oy+i));
  }
  return out;
}
// 車道 = alpha が低い (透明で下地のアスファルトが出る) 区間
function span(e){
  let lo=-1, hi=-1;
  for(let i=0;i<e.length;i++) if(e[i][3]<128){ if(lo<0) lo=i; hi=i; }
  return lo<0 ? null : [lo,hi];
}

const cov = c => 1 - c[3]/255;                    // 車道の被覆率 (透明ほど 1)
let pairs=0, structBad=0, maxStruct=0, maxCov=0, covBad=0, maxRGB=0, rgbBad=0;
const worst=[];
for(const [cls,base] of [[2,0],[1,16]]){
  for(let m=0;m<16;m++) for(let d=0;d<4;d++){
    if(!(m&(1<<d))) continue;                      // その辺が道でないタイルは接さない
    const opp=(d+2)%4;
    for(let m2=0;m2<16;m2++){
      if(!(m2&(1<<opp))) continue;                 // 相手も向かい合う辺が道であること
      const a=edge(base+m,d), b=edge(base+m2,opp);
      pairs++;
      const sa=span(a), sb=span(b);
      const st = (sa&&sb) ? Math.max(Math.abs(sa[0]-sb[0]), Math.abs(sa[1]-sb[1])) : 999;
      if(st>maxStruct) maxStruct=st;
      if(st>=1) structBad++;
      let cm=0, rm=0;
      for(let i=0;i<a.length;i++){
        cm=Math.max(cm, Math.abs(cov(a[i])-cov(b[i])));
        // 色は両側とも不透明なところだけ比べる (半透明は上の被覆率で見ている)
        if(a[i][3]>250 && b[i][3]>250)
          for(let k=0;k<3;k++) rm=Math.max(rm, Math.abs(a[i][k]-b[i][k]));
      }
      if(cm>maxCov) maxCov=cm;
      if(rm>maxRGB) maxRGB=rm;
      if(cm>=0.5) covBad++;
      if(rm>8){ rgbBad++; worst.push([rm, `class${cls} mask${m}(dir${d}) ↔ mask${m2}`]); }
    }
  }
}
worst.sort((x,y)=>y[0]-x[0]);
console.log(`[Check] ${path.relative(process.cwd(),file)}`);
console.log(`  接しうるペア        : ${pairs}`);
console.log(`  車道の位置ズレ      : 最大 ${maxStruct}px  (1px以上のペア ${structBad})`);
console.log(`  縁石のサブピクセル差: 最大 ${maxCov.toFixed(2)}px  (0.5px以上のペア ${covBad})`);
console.log(`  塗りの色差          : 最大 ${maxRGB}/255  (差>8 のペア ${rgbBad})`);
for(const [v,k] of worst.slice(0,5)) console.log(`      ${k}  差${v}`);
// ── 4) 縁石の輪郭が PNG の境界に乗っているか ─────────────────────────────────
// 各頂点から法線の内側/外側へ D だけ離れた点を PNG から引く。
//   内側 (車道) … 透明 (下地が透ける) か、白い標示 (横断歩道・センターライン)
//   外側 (歩道) … 不透明の灰色の舗装
// D は黄色い外側線 (車道の縁から 0.014〜0.036) の外に取る。
const curbFile=path.join(path.dirname(file),'road_curbs.json');
let curbBad=0, curbPts=0, curbLines=0, curbNote='';
if(!fs.existsSync(curbFile)){
  curbNote='road_curbs.json が無い (node tools/make-road-atlas.js で作られる)';
}else{
  const D=0.05;
  const tilePx=(slot,x,y)=>{
    const [ox,oy]=org(slot);
    return img.px(ox+Math.min(CONTENT-1,Math.max(0,Math.round(x*CONTENT-0.5))),
                  oy+Math.min(CONTENT-1,Math.max(0,Math.round(y*CONTENT-0.5))));
  };
  const isRoadSide=c=> c[3]<128 || (c[0]>225 && c[1]>225 && c[2]>215);   // 透明 or 白い塗料
  const isWalkSide=c=> c[3]>250 && c[0]>150 && c[0]<225
                       && Math.abs(c[0]-c[2])<25 && Math.abs(c[0]-c[1])<25;
  const J=JSON.parse(fs.readFileSync(curbFile,'utf8'));
  for(const slot of Object.keys(J.slots)){
    for(const line of J.slots[slot]){
      curbLines++;
      for(const [x,y,nx,ny] of line){
        const ix=x-nx*D, iy=y-ny*D, ox2=x+nx*D, oy2=y+ny*D;
        // セルの外へ出る点 (輪郭の端) は隣のセルの絵になるので判定しない
        if(ix<0||ix>1||iy<0||iy>1||ox2<0||ox2>1||oy2<0||oy2>1) continue;
        curbPts++;
        if(!isRoadSide(tilePx(+slot,ix,iy)) || !isWalkSide(tilePx(+slot,ox2,oy2))){
          curbBad++;
          if(curbBad<=4) console.log(`      NG slot${slot} (${x},${y}) `
            + `内=${JSON.stringify(tilePx(+slot,ix,iy))} 外=${JSON.stringify(tilePx(+slot,ox2,oy2))}`);
        }
      }
    }
  }
}
console.log(`  縁石の輪郭          : ${curbNote || `${curbLines}本 / 判定 ${curbPts}点 / 不一致 ${curbBad}`}`);

// ── 5) 縁石の立体 (roads.js pushCurb) の巻き方と法線 ─────────────────────────
// 三角形の巻き方から出る幾何法線と、頂点に載せた法線が**同じ側**を向いていること。
// 食い違う (内積が負) と、両面描画でも three が裏面と判定して法線を反転させ、
// 陰影が裏返る。見るのは符号であって滑らかさではない:
//   ・円弧の上   … 頂点法線が 1 線分ぶん傾く (数度)
//   ・直角の隅   … SDF の勾配が二等分線になるので **cos45° = 0.707** になる
// どちらも法線を頂点ごとに持つ以上ふつうに起きることで、面は正しく向いている。
// あわせて、縦の面が**車道の側**を向いていることも見る (輪郭の法線は車道→歩道
// なので、縦の面の法線はその逆でなければならない)。
if(!curbNote){
  const RD2=require('../roads.js');
  const J2=JSON.parse(fs.readFileSync(curbFile,'utf8'));
  const P={zRoad:0, zTop:0.06, zWalk:0.014, chamfer:0.06};
  let tris=0, windBad=0, faceBad=0, soft=0, worstDot=1;
  for(const slot of Object.keys(J2.slots)){
    const pos=[], nrm=[];
    RD2.pushCurb(pos, nrm, J2.slots[slot], 0, 0, 1, P);
    for(let t=0;t*9<pos.length;t++){
      const V=i=>[pos[t*9+i*3], pos[t*9+i*3+1], pos[t*9+i*3+2]];
      const N=i=>[nrm[t*9+i*3], nrm[t*9+i*3+1], nrm[t*9+i*3+2]];
      const [v0,v1,v2]=[V(0),V(1),V(2)];
      const e1=[v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
      const e2=[v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]];
      const g=[e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
      const gl=Math.hypot(...g); if(gl<1e-12) continue;   // 退化三角形は飛ばす
      const a=[0,1,2].reduce((s,k)=>s+(N(0)[k]+N(1)[k]+N(2)[k])/3*g[k]/gl, 0);
      tris++;
      if(a<worstDot) worstDot=a;
      if(a<=0.2){ windBad++;      // 0.2 = 78°。反転 (負) と退化を捕まえるための線
        if(windBad<=3) console.log(`      NG slot${slot} 三角形${t} 巻き方と法線の内積 ${a.toFixed(3)}`); }
      else if(a<0.9) soft++;
      // 縦の面 (法線の z が 0) は車道側を向くこと = 輪郭の法線の逆向き
      const n0=N(0);
      if(Math.abs(n0[2])<1e-6){
        const key=`${v0[0].toFixed(4)},${v0[1].toFixed(4)}`;
        for(const line of J2.slots[slot]) for(const [x,y,nx,ny] of line){
          if(`${x.toFixed(4)},${y.toFixed(4)}`!==key) continue;
          if(n0[0]*nx + n0[1]*ny > -0.9) faceBad++;
          break;
        }
      }
    }
  }
  console.log(`  縁石の立体          : 三角形 ${tris} / 反転 ${windBad} / 向きの不一致 ${faceBad}`
            + ` (隅で法線が寝ている三角形 ${soft} / 最小内積 ${worstDot.toFixed(3)})`);
  curbBad += windBad + faceBad;
}

// ── 6) groundKind が絵と一致しているか ──────────────────────────────────────
// roads.js の groundKind は「足元が歩道か車道か横断歩道か」を式で答える。
// 床の描画・歩道を優先して歩く判定・学習の報酬が全部これを見るので、
// **アトラスの絵とズレていると、見た目と挙動が食い違う**。
// タイルの中を格子状に走査して、式の答えと PNG のピクセルを突き合わせる。
{
  const RD2=require('../roads.js');
  const V={OTHER:0, ROAD:1, BUILDING:2, TREE:3};
  const N=40;                                   // タイルあたり N x N 点
  let gkN=0, gkBad=0;
  // 不透明で灰色 = 歩道の舗装 (縁石の天端も含む)。アルファは 200 で切る。
  // 250 だと縁石天端の帯の縁 (被覆 94%) を取りこぼす。車道は 0 なので判別は保てる。
  const isPaving=c=> c[3]>200 && c[0]>150 && c[0]<225
                  && Math.abs(c[0]-c[2])<28 && Math.abs(c[0]-c[1])<28;
  const isWhite =c=> c[3]>200 && c[0]>225 && c[1]>225 && c[2]>215;
  for(const [cls,base] of [[RD2.TWOLANE,0],[RD2.ONEWAY,16]]){
    for(let m=0;m<16;m++){
      const slot=base+m, [ox,oy]=org(slot);
      for(let j=0;j<N;j++) for(let i=0;i<N;i++){
        const fu=(i+0.5)/N, fv=(j+0.5)/N;
        const k=RD2.groundKind(V.ROAD, cls, m, fu, fv, V);
        // 判定が切り替わる境目の画素はアンチエイリアスで中間色になっている。
        // そこを厳密に見ても意味が無いので、**1 画素ぶん動かして判定が変わる点は
        // 飛ばし**、領域の内側だけを突き合わせる (D = 1/112 ≒ 1 画素)。
        const D=0.012;
        let edge=false;
        for(const [du,dv] of [[D,0],[-D,0],[0,D],[0,-D]])
          if(RD2.groundKind(V.ROAD, cls, m, fu+du, fv+dv, V)!==k){ edge=true; break; }
        if(edge) continue;
        const c=img.px(ox+Math.min(CONTENT-1,(fu*CONTENT)|0),
                       oy+Math.min(CONTENT-1,(fv*CONTENT)|0));
        gkN++;
        let ok;
        // 車道の上にはアスファルト (透明) のほかに白線・黄線とその中間色が載る。
        // 見るべきは「**歩道の舗装に見えないこと**」なので、それだけを確かめる。
        if(k===RD2.GROUND.SIDEWALK)       ok = isPaving(c);
        else if(k===RD2.GROUND.CROSSWALK) ok = isWhite(c);
        else                              ok = !isPaving(c);
        if(!ok){ gkBad++;
          if(gkBad<=4) console.log(`      NG slot${slot} (${fu.toFixed(2)},${fv.toFixed(2)}) `
            + `判定=${Object.keys(RD2.GROUND).find(n=>RD2.GROUND[n]===k)} 絵=${JSON.stringify(c)}`); }
      }
    }
  }
  console.log(`  足元の判定          : ${gkN} 点 (境目は除外) / 絵と食い違い ${gkBad}`);
  curbBad += gkBad;
}

const ok = maxStruct<1 && covBad===0 && rgbBad===0 && curbBad===0 && !curbNote;
console.log(ok ? '  → 全ペアで継ぎ目なし' : '  → 上記を確認すること');
process.exit(ok?0:1);
