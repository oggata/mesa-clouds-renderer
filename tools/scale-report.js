#!/usr/bin/env node
'use strict';
// scale-report.js — 街の寸法をメートルで一覧する。
//   node tools/scale-report.js [--cell=2.0] [--char=0.3333]
// 数字を足したり変えたりしたあと、人間 (1.70m) から見て妥当かを一目で見るため。
const SC=require('../scale.js');
const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?parseFloat(a.split('=')[1]):null; };
const CELL=arg('cell')||2.0, CHAR=arg('char')||1/3;
const S=SC.make(CELL, CHAR, process.env);
console.log(SC.report(S, CELL));
const png=(process.argv.find(v=>v.startsWith('--png='))||'').split('=')[1];
if(png){
  const {W,H}=drawLineup(S, CELL, png);
  console.log(`\n並べた図: ${png}  ${W}x${H} (1m ごとに目盛り、5m ごとに明るい線)`);
}

// ── 並べて見る ──────────────────────────────────────────────────────────────
// 数字だけだと「揃っているか」は判断しづらいので、同じ縮尺で横に並べる。
// 人物は skeleton.js の骨格をそのまま描く (絵と実装がズレないように)。
function drawLineup(S, CELL, out){
  const PNG=require('./png.js'), SK=require('../skeleton.js'), fs=require('fs');
  const SK_HUMAN_M=S.HUMAN_M;                    // 基準の身長 (scale.js)
  const W=1120, H=560, GY=H-70;                // GY = 地面の線
  const TOPM=14;                               // 画面に収める高さ (m)
  const PPM=(GY-40)/TOPM;                      // 1m あたりのピクセル
  const img=new Uint8Array(W*H*4);
  for(let i=0;i<W*H;i++){ img[i*4]=22; img[i*4+1]=24; img[i*4+2]=28; img[i*4+3]=255; }
  const px=(x,y,c)=>{ x|=0; y|=0; if(x<0||x>=W||y<0||y>=H) return;
    const o=(y*W+x)*4; img[o]=c[0]; img[o+1]=c[1]; img[o+2]=c[2]; };
  const rect=(x0,y0,x1,y1,c)=>{ for(let y=Math.min(y0,y1);y<=Math.max(y0,y1);y++)
    for(let x=Math.min(x0,x1);x<=Math.max(x0,x1);x++) px(x,y,c); };
  const line=(ax,ay,bx,by,r,c)=>{
    const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy;
    for(let y=Math.floor(Math.min(ay,by)-r-1);y<=Math.ceil(Math.max(ay,by)+r+1);y++)
    for(let x=Math.floor(Math.min(ax,bx)-r-1);x<=Math.ceil(Math.max(ax,bx)+r+1);x++){
      let t=L2<1e-9?0:((x-ax)*dx+(y-ay)*dy)/L2; t=Math.max(0,Math.min(1,t));
      if(Math.hypot(x-(ax+dx*t), y-(ay+dy*t))<=r) px(x,y,c);
    }
  };
  const ell=(cx,cy,rx,ry,c)=>{ for(let y=-ry;y<=ry;y++)for(let x=-rx;x<=rx;x++)
    if((x/rx)**2+(y/ry)**2<=1) px(cx+x,cy+y,c); };
  const Y=m=>GY-m*PPM;                          // m → 画面 y

  // 1m ごとの目盛り
  for(let m=1;m<=TOPM;m++){
    const c=m%5===0?[70,76,86]:[42,46,54];
    for(let x=0;x<W;x+=m%5===0?1:6) px(x, Y(m), c);
  }
  rect(0, GY, W-1, GY+2, [90,96,104]);

  let x=70;
  const label=(cx,txt)=>{};                     // 文字は描かない (標準出力の表と対応させる)

  // 住民 (skeleton.js の骨格を rest pose で)。**正面から見る**。
  // 側面だと rest pose の前後座標がすべて 0 なので、図が縦線に潰れる。
  {
    const k=PPM*SK_HUMAN_M;                      // 骨格の z は身長 1.0 に対する比
    for(const b of SK.boneSegments()){
      const c=[(b.col>>16)&255,(b.col>>8)&255,b.col&255];
      line(x+b.a.x*k, GY-b.a.z*k, x+b.b.x*k, GY-b.b.z*k, Math.max(1,b.r*k), c);
    }
    for(const s of SK.jointSpheres())
      ell(x+s.p.x*k, GY-s.p.z*k, Math.max(1,s.r*k), Math.max(1,s.r*k),
          [(s.col>>16)&255,(s.col>>8)&255,s.col&255]);
    x+=110;
  }
  // 車 (側面)
  {
    const L=S.toM(S.CAR.len)*PPM, bt=S.toM(S.CAR.bodyZ[1])*PPM, tp=S.toM(S.CAR.cabZ[1])*PPM;
    const b0=S.toM(S.CAR.bodyZ[0])*PPM, wr=S.toM(S.CAR.wheelR)*PPM;
    rect(x, GY-bt, x+L, GY-b0, [190,70,64]);
    rect(x+L*0.20, GY-tp, x+L*0.74, GY-bt, [150,55,52]);
    for(const wx of [x+L*0.20, x+L*0.80]) ell(wx, GY-wr, wr, wr, [30,32,36]);
    x+=L+90;
  }
  // 街路樹
  {
    const h=S.toM(S.TREE.streetH)*PPM, tr=Math.max(1,h*0.035);
    line(x, GY, x, GY-h*0.42, tr, [120,84,52]);
    ell(x, GY-h*0.68, h*0.26, h*0.34, [70,140,66]);
    x+=110;
  }
  // 木のセルの木
  {
    const h=S.toM(S.TREE.h)*PPM, tr=Math.max(1,h*0.035);
    line(x, GY, x, GY-h*0.42, tr, [120,84,52]);
    ell(x, GY-h*0.68, h*0.28, h*0.36, [62,126,58]);
    x+=115;
  }
  // 街灯
  {
    const h=S.toM(S.LAMP.h)*PPM, pr=Math.max(1,S.toM(S.LAMP.poleR)*PPM);
    const arm=S.toM(S.LAMP.armLen)*PPM, hw=S.toM(S.LAMP.headW)*PPM;
    line(x, GY, x, GY-h, pr, [110,116,124]);
    line(x, GY-h, x+arm, GY-h, pr*0.85, [110,116,124]);
    rect(x+arm-hw, GY-h, x+arm+hw, GY-h+hw*1.4, [200,190,150]);
    x+=arm+110;
  }
  // 建物 (1x1 の住宅: 幅 = セル x fill、高さは 1 階 3.28m + 基準階 2.13m x 3 + 屋根)
  {
    const bw=S.toM(CELL*S.BLDG.fill)*PPM;
    const fl=[3.28, 2.13, 2.13, 2.13];
    let y=GY;
    for(let i=0;i<fl.length;i++){
      const hh=fl[i]*PPM;
      rect(x, y-hh, x+bw, y, i?[126,120,112]:[104,99,94]);
      for(let g=0;g<=1;g++) rect(x, y-hh, x+bw, y-hh+1, [70,68,66]);
      y-=hh;
    }
    for(let i=0;i<=bw;i++){                     // 切妻屋根
      const t=Math.abs(i-bw/2)/(bw/2);
      rect(x+i, y-(1-t)*2.0*PPM, x+i, y, [122,78,66]);
    }
  }
  fs.writeFileSync(out, PNG.encode(img,W,H));
  return {W,H};
}
