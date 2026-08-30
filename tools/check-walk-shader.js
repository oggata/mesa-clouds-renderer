#!/usr/bin/env node
'use strict';
// check-walk-shader.js — 頂点シェーダの関節角が skeleton.js と一致するか検算する。
//
//   node tools/check-walk-shader.js
//
// server.js のシェーダは skeleton.js の定数を埋め込んだ GLSL の文字列で、
// **式の形だけが JS と GLSL に二重に存在する**。定数はどちらも SK から出ている
// ので値のズレは起きないが、式を書き写すときの取り違え (符号、位相のずらし方、
// 骨番号の振り分け) は起こりうる。しかも GLSL 側は実機でしか動かないので、
// 間違えていても絵を見るまで分からない。
//
// ここでは GLSL のテンプレートを server.js から取り出して評価し、GLSL の
// 算術式を JS へ機械的に置き換えて、skeleton.js の limbAngles と数値で比べる。

const fs=require('fs'), path=require('path');
const SK=require('../skeleton.js');

const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const m=src.match(/const WALK_ANGLES_GLSL = `([\s\S]*?)`;/);
if(!m){ console.error('[WalkShader] server.js に WALK_ANGLES_GLSL が見つかりません'); process.exit(1); }
// server.js と同じ入力 (SK と _f) でテンプレートを評価する
const _f=v=>v.toFixed(5);
const glsl=new Function('SK','_f','return `'+m[1]+'`;')(SK,_f);

// GLSL → JS。使っているのは float 宣言・三項・比較・sin/cos/pow/max だけ。
const js=glsl
  .replace(/\/\/[^\n]*/g,'')                 // コメント
  .replace(/\bfloat\s+/g,'let ')
  .replace(/\b(sin|cos|pow|max)\(/g,'Math.$1(')
  .replace(/aWalk\.x/g,'ph').replace(/aWalk\.y/g,'am')
  .replace(/\baBone\b/g,'bone');
const run=new Function('ph','am','bone', js+'\nreturn {thigh:_thigh, knee:_knee, sh:_shd, el:_elb, lean:_lean, ang:_ang};');

const B=SK.BONE;
// 骨番号 → その骨に効く合計回転角 (法線を回すのに使う値)。poseVertex の連鎖と対応。
const expectAng=(A,lean,bone)=>
    (bone===B.LSHIN||bone===B.RSHIN)   ? A.knee+A.thigh
  : (bone===B.LTHIGH||bone===B.RTHIGH) ? A.thigh
  : (bone===B.LFARM||bone===B.RFARM)   ? A.el+A.sh+lean
  : (bone===B.LUARM||bone===B.RUARM)   ? A.sh+lean
  :                                      lean;

let bad=0, checked=0, worst=0;
for(const bone of [0,1,2,3,4,5,6,7,8]){
  const isLeft = bone===B.LTHIGH||bone===B.LSHIN||bone===B.LUARM||bone===B.LFARM;
  for(let i=0;i<48;i++){
    for(const am of [0, 0.37, 1]){
      const ph=i/48*Math.PI*2;
      const g=run(ph, am, bone);
      const A=SK.limbAngles(ph, am, isLeft?1:-1);
      const lean=SK.WALK.lean*am;
      const want={thigh:A.thigh, knee:A.knee, sh:A.sh, el:A.el, lean,
                  ang:expectAng(A, lean, bone)};
      for(const k of Object.keys(want)){
        const d=Math.abs(g[k]-want[k]);
        checked++;
        if(d>worst) worst=d;
        if(d>1e-4){ bad++;
          if(bad<=5) console.log(`      NG 骨${bone} 位相${ph.toFixed(2)} 振幅${am} ${k}: `
            + `GLSL=${g[k].toFixed(5)} skeleton=${want[k].toFixed(5)}`); }
      }
    }
  }
}
console.log(`[WalkShader] 比較 ${checked} 件 / 不一致 ${bad} / 最大差 ${worst.toExponential(1)}`);

// 骨番号の振り分けが左右で食い違っていないかも見る (左脚が前のとき右脚は後ろ)
const a=run(Math.PI/2, 1, B.LTHIGH), b=run(Math.PI/2, 1, B.RTHIGH);
const opp = a.thigh*b.thigh < 0;
const arm = a.thigh*run(Math.PI/2,1,B.LUARM).sh < 0;      // 同じ側の腕は脚と逆位相
console.log(`[WalkShader] 左右の脚が逆位相: ${opp?'OK':'NG'} / 同側の腕と脚が逆位相: ${arm?'OK':'NG'}`);
// ── 回転支点の取り違えを見る ────────────────────────────────────────────────
// 関節名を書き間違えても SK.J[名前] が undefined になって落ちるので気付くが、
// **別の関節と取り違えた場合は落ちない** (膝の角度を腰で回す等)。
// mesaRotX(transformed, SKZ('関節'), 角度) の組を全部取り出して、
// 「その角度を回す支点」が正しい関節かを見る。
const WANT={ _knee:'knee', _thigh:'hip', _elb:'elbow', _shd:'shoulder', _lean:'pelvis' };
let pivBad=0, pivN=0;
for(const mm of src.matchAll(/mesaRotX\(transformed,\s*\$\{_f\(SKZ\('(\w+)'\)\)\},\s*(_\w+)\)/g)){
  const [,joint,ang]=mm; pivN++;
  if(WANT[ang]!==joint){
    pivBad++;
    console.log(`      NG ${ang} を ${joint} で回している (正しくは ${WANT[ang]||'?'})`);
  }
}
console.log(`[WalkShader] 回転支点 ${pivN} 箇所 / 取り違え ${pivBad}`);

process.exit(bad===0 && opp && arm && pivBad===0 && pivN>=9 ? 0 : 1);
