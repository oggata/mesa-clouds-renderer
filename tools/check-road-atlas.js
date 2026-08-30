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
const ok = maxStruct<1 && covBad===0 && rgbBad===0;
console.log(ok ? '  → 全ペアで継ぎ目なし' : '  → 上記を確認すること');
process.exit(ok?0:1);
