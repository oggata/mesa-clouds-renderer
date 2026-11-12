#!/usr/bin/env node
'use strict';
// preview-car.js — 車の形を大きく描いて確かめる。
//
//   node tools/preview-car.js [out.png] [--size=420] [--night]
//
// 配信画面の車は 30px ほどなので、形の良し悪しはあれでは分からない。
// ここでは src/carmesh.js の型紙をそのまま、何色かの車体色で斜め前・横・斜め後ろ・
// 真上寄り (配信の俯瞰に近い角度) から描く。--night は灯火を光らせた見た目。

const path=require('path');
const THREE=require('three');
const gl=require('gl');
const SCALE=require('../src/scale.js');
const CARMESH=require('../src/carmesh.js');

const arg=k=>{ const a=process.argv.find(v=>v.startsWith('--'+k+'=')); return a?a.split('=')[1]:null; };
const SIZE=parseInt(arg('size'))||420;
const NIGHT=process.argv.includes('--night');
const out=process.argv.slice(2).find(a=>!a.startsWith('--'))
       || path.join(__dirname,'..','docs','images','car_preview.png');

const CELL=1;   // 寸法は比なので 1 セル = 1 で十分 (server.js の CELL と同じ考え方)
const DIM=SCALE.make(CELL, SCALE.DEFAULT_CHAR_SCALE, process.env);
const CAR=DIM.CAR;
// [名前, 方位 (z 軸まわり), 仰角]
const VIEWS=[['front-iso',Math.PI*0.22,0.38],['side',Math.PI*0.5,0.10],
             ['rear-iso',Math.PI*1.20,0.38],['top',Math.PI*0.30,1.00]];
const PAINTS=[0xd8d8d4,0xa83a32,0x2e6ea8];   // server.js の CAR_COLORS から 3 色
const W=SIZE*VIEWS.length, HT=SIZE*PAINTS.length;

const glCtx=gl(W,HT,{preserveDrawingBuffer:true});
const canvas={width:W,height:HT,style:{},addEventListener(){},removeEventListener(){},
              setAttribute(){},getContext:()=>glCtx};
const renderer=new THREE.WebGLRenderer({canvas,context:glCtx,antialias:false});
renderer.setSize(W,HT,false); renderer.setPixelRatio(1);
renderer.toneMapping=THREE.ACESFilmicToneMapping;   // server.js と同じトーンマップ
renderer.toneMappingExposure=0.6;

const scene=new THREE.Scene();
scene.add(new THREE.AmbientLight(0xbcd0e0, NIGHT?0.25:0.9));
scene.add(new THREE.HemisphereLight(0xeaf2f7,0x50504a, NIGHT?0.2:0.7));
const sun=new THREE.DirectionalLight(0xfff4e0, NIGHT?0.3:2.35); sun.position.set(2,-3,4); scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(40,40),
  new THREE.MeshLambertMaterial({color:0x5a5d60}));
scene.add(ground);

const parts=CARMESH.build(THREE, CAR);
const groups=[];
for(const paint of PAINTS){
  const g=new THREE.Group();
  for(const it of parts.body) g.add(new THREE.Mesh(it.geo, new THREE.MeshLambertMaterial({color:paint})));
  for(const it of parts.trim) g.add(new THREE.Mesh(it.geo, new THREE.MeshLambertMaterial({color:it.color})));
  for(const it of parts.lamp){
    const m=new THREE.MeshLambertMaterial({color:it.color});
    if(NIGHT){ m.emissive=it.color.clone(); m.emissiveIntensity=2.2; }
    g.add(new THREE.Mesh(it.geo, m));
  }
  g.position.z=0.008; g.visible=false; scene.add(g); groups.push(g);
}

const R=CAR.len*2.6, CZ=CAR.cabZ[1]*0.45;
const cam=new THREE.PerspectiveCamera(30,1,R*0.05,R*200);
cam.up.set(0,0,1);
renderer.setScissorTest(true);
renderer.setClearColor(0x1b1e24,1);
renderer.clear();
groups.forEach((g,ri)=>{
  groups.forEach(o=>{ o.visible=(o===g); });
  VIEWS.forEach(([,az,el],ci)=>{
    const ce=Math.cos(el);
    cam.position.set(Math.cos(az)*ce*R, Math.sin(az)*ce*R, CZ+Math.sin(el)*R);
    cam.lookAt(0,0,CZ);
    const x=ci*SIZE, y=(PAINTS.length-1-ri)*SIZE;
    renderer.setViewport(x,y,SIZE,SIZE); renderer.setScissor(x,y,SIZE,SIZE);
    renderer.render(scene,cam);
  });
});

const px=new Uint8Array(W*HT*4);
glCtx.readPixels(0,0,W,HT,glCtx.RGBA,glCtx.UNSIGNED_BYTE,px);
const flip=new Uint8Array(W*HT*4), row=W*4;
for(let y=0;y<HT;y++) flip.set(px.subarray((HT-1-y)*row,(HT-y)*row), y*row);
require('fs').mkdirSync(path.dirname(out),{recursive:true});
require('fs').writeFileSync(out, require('./png.js').encode(flip,W,HT));
const tri=[...parts.body,...parts.trim,...parts.lamp].reduce((n,it)=>{
  const g=it.geo; return n+(g.index?g.index.count:g.attributes.position.count)/3; },0);
console.log(`[Car] ${out}  ${W}x${HT}  ${PAINTS.length}色 × ${VIEWS.length}方向  三角形 ${tri}`);
