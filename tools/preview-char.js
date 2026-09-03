#!/usr/bin/env node
'use strict';
// preview-char.js — 住民のキャラクターを大きく描いて形と色を確かめる。
//
//   node tools/preview-char.js [out.png] [--style=human|skeleton] [--size=520] [--wear=3]
//
// 配信画面では住民は 40px ほどにしかならないので、あれで形の良し悪しは分からない。
// ここでは 1 体を画面いっぱいに、正面・横・斜めの 3 方向から描く。
//
// **色はシェーダではなく charmesh.partColor で解決する。** 規則は
// WEAR_COLOR_GLSL と同じものを JS 側に書いたもので、ここが本番とズレたら
// プレビューの色が本番と違って見える (= 気づける) ようにしてある。

const path=require('path');
const THREE=require('three');
const gl=require('gl');
const SK=require('../skeleton.js');
const CHARMESH=require('../charmesh.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const STYLE=(arg('style')||'human')==='skeleton'?'skeleton':'human';
const SIZE=parseInt(arg('size'))||520;
const WEAR_N=parseInt(arg('wear'))||3;            // 並べる服装の数
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','docs','images','char_preview.png');

const H=1.32, BASE=-0.52;                          // 身長と足元 (server.js と同じ比率)
const VIEWS=[['front',0],['side',Math.PI/2],['iso',Math.PI*0.25]];
const W=SIZE*VIEWS.length*WEAR_N, HT=SIZE;

const glCtx=gl(W,HT,{preserveDrawingBuffer:true});
const canvas={width:W,height:HT,style:{},addEventListener(){},removeEventListener(){},
              setAttribute(){},getContext:()=>glCtx};
const renderer=new THREE.WebGLRenderer({canvas,context:glCtx,antialias:false});
renderer.setSize(W,HT,false); renderer.setPixelRatio(1);
// 本番 (server.js) と同じトーンマップ。ここを揃えないと色の印象がズレる。
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=0.6;

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x1b1e24);
scene.add(new THREE.AmbientLight(0xbcd0e0,0.9));
const hemi=new THREE.HemisphereLight(0xeaf2f7,0x50504a,0.7); scene.add(hemi);
const sun=new THREE.DirectionalLight(0xfff4e0,2.35); sun.position.set(2,-3,4); scene.add(sun);

// 服装は server.js の agentWear と同じ考え方 (aid のハッシュ) で振る。
// ここは見た目の確認なので、単純に候補を順に使う。
const wears=[];
for(let i=0;i<WEAR_N;i++) wears.push({
  pants: SK.PANTS[i % SK.PANTS.length],
  tone : (i % SK.SKIN_TONES.length)*4 + (i % SK.HAIR_TONES.length),
  top  : [0xff3355,0x00ccff,0x33ff88,0xffee00,0xff7700][i % 5],
});

let col=0;
for(const w of wears){
  const parts=CHARMESH.partList(THREE, STYLE, H, BASE);
  for(const [,yaw] of VIEWS){
    const g=new THREE.Group();
    for(const it of parts){
      const c=CHARMESH.partColor(it.part, w, w.top);
      const m=new THREE.MeshLambertMaterial({color: c!=null ? c : it.color.getHex()});
      g.add(new THREE.Mesh(it.geo, m));
    }
    g.rotation.z=yaw;
    g.userData.col=col++;
    scene.add(g);
  }
}

// 1 体ずつビューポートを切って描く (カメラは共通)
// 体は z = BASE .. BASE+H*1.01 に立っている。その中心を画面の中心に置く。
const CZ=BASE+H*0.5;
const cam=new THREE.PerspectiveCamera(22, 1, 0.05, 40);
cam.up.set(0,0,1);
cam.position.set(0,-4.2,CZ); cam.lookAt(0,0,CZ);
renderer.setScissorTest(true);
renderer.setClearColor(0x1b1e24,1);
renderer.clear();
scene.children.filter(o=>o.isGroup).forEach(g=>{
  scene.children.filter(o=>o.isGroup).forEach(o=>{ o.visible = (o===g); });
  const x=g.userData.col*SIZE;
  renderer.setViewport(x,0,SIZE,HT); renderer.setScissor(x,0,SIZE,HT);
  renderer.render(scene,cam);
});

// 読み出し (上下反転) して PNG へ
const px=new Uint8Array(W*HT*4);
glCtx.readPixels(0,0,W,HT,glCtx.RGBA,glCtx.UNSIGNED_BYTE,px);
const flip=new Uint8Array(W*HT*4), row=W*4;
for(let y=0;y<HT;y++) flip.set(px.subarray((HT-1-y)*row,(HT-y)*row), y*row);
require('fs').mkdirSync(path.dirname(out),{recursive:true});
require('fs').writeFileSync(out, require('./png.js').encode(flip,W,HT));
console.log(`[Char] ${out}  ${W}x${HT}  style=${STYLE} / ${wears.length}着 × ${VIEWS.length}方向`);
console.log(`[Char] パーツ ${CHARMESH.partList(THREE,STYLE,H,BASE).length}個`);
