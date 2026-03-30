/**
 * MESA Persona City Sim — Cloud Rendering Server
 * WebSocket + JPEG フレームストリーム方式
 * headless-gl + Three.js r132 + ws
 *
 * ローカル: node server.js
 * Render:   xvfb-run -s "-screen 0 1x1x24" node server.js  (or Xvfb :99 ...)
 *
 * [Fix] レースコンディション修正:
 *   simLoop / renderLoop / statsLoop の setInterval を
 *   async 初期化 (ONNX + テクスチャ + scene 構築) 完了後に開始するよう変更。
 *   これにより scene = null の状態で renderer.render() が呼ばれるクラッシュを根絶。
 */

'use strict';

const gl    = require('gl');
const THREE = require('three');
const WebSocket = require('ws');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// JPEG エンコードに sharp を使う（なければ簡易RGB返し）
let sharp = null;
try { sharp = require('sharp'); console.log('[Sharp] loaded'); }
catch(e) { console.warn('[Sharp] not found — install sharp for better performance'); }

// onnxruntime-node はオプション
let ort = null;
try { ort = require('onnxruntime-node'); console.log('[ONNX] loaded'); }
catch(e) { console.warn('[ONNX] not found — random mode'); }

// ─── Config ──────────────────────────────────────────────────────────────────
const WIDTH  = parseInt(process.env.WIDTH)  || 100;
const HEIGHT = parseInt(process.env.HEIGHT) || 100;
const FPS    = parseInt(process.env.FPS)    || 12;
const JPEG_Q = parseInt(process.env.JPEG_Q) || 70;   // JPEG品質 (0-100)
const PORT   = process.env.PORT || 8080;

// ─── Sim constants ────────────────────────────────────────────────────────────
const GRID=30, CELL=2.0, TICK=parseInt(process.env.TICK)||150;
const INFER_EVERY=parseInt(process.env.INFER_EVERY)||10;
const OTHER=0, ROAD=1, BUILDING=2, TREE=3;
const PASSABLE = new Set([ROAD, BUILDING]);
const MOVE=0.25, ROT=Math.PI/9;
const RAY_MAX=6.0, RAY_STEP=0.15;
const W=GRID*CELL;
const IMG_W=64, IMG_H=64, IMG_CH=3;
const FP_FOV=Math.PI/3, FP_RAY_MAX=8.0, FP_RAY_STEP=0.1;
const FP_CELL_RGB=[[45,100,45],[80,80,80],[196,32,32],[35,104,40]];
const FP_SKY_RGB=[6,12,20], FP_FLOOR_RGB=[26,40,32];

const PERSONA_DEFS = [
  { id:'A', name:'Explorer Rex',    color:0xff3355, hex:'#ff3355', desc:'Actively explores new areas' },
  { id:'B', name:'Homebody Lily',   color:0x00ccff, hex:'#00ccff', desc:'Takes the shortest route' },
  { id:'C', name:'Social Marco',    color:0x33ff88, hex:'#33ff88', desc:'Gathers near others' },
  { id:'D', name:'Businessman Cole',color:0xffee00, hex:'#ffee00', desc:'Moves straight, efficiency first' },
  { id:'E', name:'Tourist Elena',   color:0xff7700, hex:'#ff7700', desc:'Wanders around buildings' },
];

// ─── マップ生成 ───────────────────────────────────────────────────────────────
function makeMap(size, seed){
  let s=seed>>>0;
  const rng=()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff};
  const ri=n=>Math.floor(rng()*n);
  const pick=a=>a[ri(a.length)];
  const g=Array.from({length:size},()=>new Array(size).fill(OTHER));
  const step=4, rows=[], cols=[];
  for(let i=0;i<size;i+=step){rows.push(i);cols.push(i);}
  rows.forEach(r=>{for(let c=0;c<size;c++)g[r][c]=ROAD;});
  cols.forEach(c=>{for(let r=0;r<size;r++)g[r][c]=ROAD;});
  for(let ri2=0;ri2<rows.length-1;ri2++){
    for(let ci=0;ci<cols.length-1;ci++){
      const r0=rows[ri2]+1,r1=rows[ri2+1],c0=cols[ci]+1,c1=cols[ci+1];
      const cells=[];
      for(let r=r0;r<r1;r++)for(let c=c0;c<c1;c++)cells.push([r,c]);
      if(!cells.length)continue;
      const b=pick(cells);g[b[0]][b[1]]=BUILDING;
      cells.forEach(([r,c])=>{
        if(r===b[0]&&c===b[1])return;
        const v=rng();
        if(v<.25)g[r][c]=TREE;else if(v<.45)g[r][c]=BUILDING;
      });
    }
  }
  rows.forEach(r=>{for(let c=0;c<size;c++)g[r][c]=ROAD;});
  cols.forEach(c=>{for(let r=0;r<size;r++)g[r][c]=ROAD;});
  const isX=(r,c)=>rows.includes(r)&&cols.includes(c);
  const cands=[];
  for(let r=0;r<size;r++)for(let c=0;c<size;c++)
    if(g[r][c]===ROAD&&!isX(r,c))cands.push([r,c]);
  for(let i=cands.length-1;i>0;i--){const j=ri(i+1);[cands[i],cands[j]]=[cands[j],cands[i]];}
  function roadOK(grid){
    let sr=-1,sc=-1;
    outer:for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(grid[r][c]===ROAD){sr=r;sc=c;break outer;}
    if(sr<0)return true;
    const vis=new Set(),q=[[sr,sc]];vis.add(sr*size+sc);
    const D=[[-1,0],[1,0],[0,-1],[0,1]];
    while(q.length){const[r,c]=q.shift();for(const[dr,dc]of D){const nr=r+dr,nc=c+dc;if(nr<0||nr>=size||nc<0||nc>=size)continue;const k=nr*size+nc;if(!vis.has(k)&&grid[nr][nc]===ROAD){vis.add(k);q.push([nr,nc]);}}}
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(grid[r][c]===ROAD&&!vis.has(r*size+c))return false;
    return true;
  }
  const maxRm=Math.floor(cands.length*(0.30+rng()*0.25));let rm=0;
  for(const[r,c]of cands){if(rm>=maxRm)break;g[r][c]=OTHER;if(roadOK(g)){g[r][c]=rng()<0.4?TREE:OTHER;rm++;}else g[r][c]=ROAD;}
  return g;
}

// ─── FP画像 (ONNX観測) ───────────────────────────────────────────────────────
function renderFPImage(map,agent){
  const buf=new Float32Array(IMG_CH*IMG_H*IMG_W);
  for(let xi=0;xi<IMG_W;xi++){
    const ra=agent.th+FP_FOV*(xi/(IMG_W-1)-0.5);
    const rdx=Math.cos(ra),rdy=Math.sin(ra);
    let ht=-1,hd=FP_RAY_MAX;
    for(let d=FP_RAY_STEP;d<FP_RAY_MAX;d+=FP_RAY_STEP){
      const nx=agent.x+rdx*d,ny=agent.y+rdy*d;
      const r=Math.floor(nx),c=Math.floor(ny);
      if(r<0||r>=GRID||c<0||c>=GRID){ht=OTHER;hd=d;break;}
      const ct=map[r][c];if(ct!==ROAD){ht=ct;hd=d;break;}
    }
    const colH=ht>=0?Math.min(IMG_H*1.5/Math.max(hd,0.1),IMG_H):0;
    const y0=Math.floor((IMG_H-colH)*0.5),y1=Math.floor(y0+colH);
    const br=ht>=0?Math.max(0.15,1.0-hd/FP_RAY_MAX):0;
    const rgb=ht>=0?FP_CELL_RGB[ht]:[0,0,0];
    for(let yi=0;yi<IMG_H;yi++){
      let rv,gv,bv;
      if(yi>=y0&&yi<y1){rv=rgb[0]/255*br;gv=rgb[1]/255*br;bv=rgb[2]/255*br;}
      else if(yi<IMG_H*0.5){rv=FP_SKY_RGB[0]/255;gv=FP_SKY_RGB[1]/255;bv=FP_SKY_RGB[2]/255;}
      else{rv=FP_FLOOR_RGB[0]/255;gv=FP_FLOOR_RGB[1]/255;bv=FP_FLOOR_RGB[2]/255;}
      const pi=yi*IMG_W+xi;buf[0*IMG_H*IMG_W+pi]=rv;buf[1*IMG_H*IMG_W+pi]=gv;buf[2*IMG_H*IMG_W+pi]=bv;
    }
  }
  return buf;
}

// ─── ONNX ────────────────────────────────────────────────────────────────────
const ortSessions={}, obsDims={};
async function loadOnnxSessions(){
  if(!ort)return;
  for(const p of PERSONA_DEFS){
    const op=path.join(__dirname,'data',`persona_${p.id}.onnx`);
    const mp=path.join(__dirname,'data',`persona_${p.id}_meta.json`);
    if(fs.existsSync(mp)){try{const m=JSON.parse(fs.readFileSync(mp,'utf8'));if(m.input_size)obsDims[p.id]=m.input_size;}catch(e){}}
    if(fs.existsSync(op)){
      try{
        ortSessions[p.id]=await ort.InferenceSession.create(op,{executionProviders:['cpu']});
        const dim=obsDims[p.id]||(IMG_CH*IMG_H*IMG_W);
        const nm=ortSessions[p.id].inputNames[0];
        await ortSessions[p.id].run({[nm]:new ort.Tensor('float32',new Float32Array(dim),[1,dim])});
        console.log(`[ONNX] persona_${p.id} OK`);
      }catch(e){console.warn(`[ONNX] persona_${p.id}:`,e.message);ortSessions[p.id]=null;}
    }
  }
}

// 推論結果キャッシュ (エージェントごと)
const actionCache = {};

async function inferAction(map, agent){
  const sess=ortSessions[agent.def.id];
  if(sess){
    try{
      const obs=renderFPImage(map,agent);
      const dim=obsDims[agent.def.id]||(IMG_CH*IMG_H*IMG_W);
      const nm=sess.inputNames[0],on=sess.outputNames[0];
      const out=await sess.run({[nm]:new ort.Tensor('float32',obs,[1,dim])});
      const lg=Array.from(out[on].data);
      const mx=Math.max(...lg),ex=lg.map(v=>Math.exp(v-mx)),sm=ex.reduce((a,b)=>a+b,0),pr=ex.map(v=>v/sm);
      let rv=Math.random();for(let i=0;i<pr.length;i++){rv-=pr[i];if(rv<=0)return i;}return 0;
    }catch(e){return Math.floor(Math.random()*3);}
  }
  // ランダム (前進バイアス)
  const rays=[0,1,2,3,4].map(i=>{
    const angle=agent.th+(i-2)*Math.PI/3,dx=Math.cos(angle),dy=Math.sin(angle);
    for(let d=RAY_STEP;d<RAY_MAX;d+=RAY_STEP){
      const r=Math.floor(agent.x+dx*d),c=Math.floor(agent.y+dy*d);
      if(r<0||r>=GRID||c<0||c>=GRID)return{type:OTHER,dist:d};
      const ct=map[r][c];if(ct===BUILDING||ct===TREE)return{type:ct,dist:d};
    }
    return{type:ROAD,dist:RAY_MAX};
  });
  return (rays[2].type===ROAD&&Math.random()<0.55)?0:(Math.random()<0.5?1:2);
}

let stepCount = 0;
async function prefetchAllActions(map, agents){
  if(stepCount % INFER_EVERY !== 0) return;
  await Promise.all(agents.map(async a=>{
    const action = await inferAction(map, a);
    actionCache[a.def.id] = action;
  }));
}

function selectAction(agent){
  return actionCache[agent.def.id] ?? Math.floor(Math.random()*3);
}

// ─── 建物タイプ定義 ────────────────────────────────────────────────────────────
const BLDG_TYPES = [
  { label: '🥩 牛丼屋',    name: 'gyudon',   textureFile: './textures/50x80/gyudon.png', fallbackColor: 0xe8a020, height: 1.6 },
  { label: '🍜 ラーメン屋', name: 'ramen',    textureFile: './textures/50x80/ramen.png',   fallbackColor: 0xe03030, height: 1.6 },
  { label: '🍱 弁当屋',    name: 'bento',    textureFile: './textures/50x50/bento.png',  fallbackColor: 0x20a020, height: 1.0 },
  { label: '☕ カフェ',    name: 'cafe',     textureFile: './textures/50x80/cafe.png',  fallbackColor: 0x8B5E3C, height: 1.6 },
  { label: '🏢 オフィス',  name: 'office',   textureFile: './textures/50x120/office.png',  fallbackColor: 0x4060a0, height: 2.4 },
  { label: '🏠 住宅',      name: 'house',    textureFile: './textures/50x80/house.png',  fallbackColor: 0xa06040, height: 1.6 },
  { label: '🏪 コンビニ',  name: 'conbini',  textureFile: './textures/50x50/conbini.png',   fallbackColor: 0x20a8e0, height: 1.0 },
  { label: '🏥 病院',      name: 'hospital', textureFile: './textures/50x80/hospital.png',  fallbackColor: 0xe0e0f0, height: 1.6 },
];

let BUILDING_TYPES = {};
const texCache = {};

async function loadTextureFile(filePath) {
  if (!filePath || texCache.hasOwnProperty(filePath)) return;
  const fullPath = path.join(__dirname, filePath);
  if (!sharp || !fs.existsSync(fullPath)) { texCache[filePath] = null; return; }
  try {
    const { data, info } = await sharp(fullPath)
      .resize(512, 512)   // ← 2のべき乗サイズに強制リサイズ
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tex = new THREE.DataTexture(new Uint8Array(data), info.width, info.height, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = true;
    tex.needsUpdate = true;
    texCache[filePath] = tex;
  } catch(e) {
    console.warn(`[Tex] failed ${filePath}:`, e.message);
    texCache[filePath] = null;
  }
}

async function preloadTextures() {
  await Promise.all(BLDG_TYPES.map(bt => loadTextureFile(bt.textureFile)));
}

// BoxGeometry 面インデックス:
//   0: +X, 1: -X → UV横がZ軸方向なので90°補正
//   2: +Y, 3: -Y → 正常
//   4: +Z 上面(屋上), 5: -Z 底面
function getBuildingMaterial(typeIdx) {
  const bt = BLDG_TYPES[typeIdx % BLDG_TYPES.length];
  const sideTex = texCache[bt.textureFile];

  function makeMat(flipU = false, flipV = false, rotateDeg = 0) {
    if (!sideTex) return new THREE.MeshBasicMaterial({ color: bt.fallbackColor });
    const t = sideTex.clone();
    t.needsUpdate = true;
    if (rotateDeg !== 0) {
      t.rotation = rotateDeg * (Math.PI / 180);
      t.center.set(0.5, 0.5);
    }
    t.repeat.set(flipU ? -1 : 1, flipV ? -1 : 1);
    t.offset.set(flipU ?  1 : 0, flipV ?  1 : 0);
    return new THREE.MeshBasicMaterial({ map: t });
  }

  return [
    makeMat(false, false,  90), // 0: +X 右側面
    makeMat(false, false,   -90), // 1: -X 左側面
    makeMat(false, false,   0), // 2: +Y 正面
    makeMat(true,  false,   0), // 3: -Y 背面
    new THREE.MeshBasicMaterial({ color: 0x888888 }), // 4: 屋上
    new THREE.MeshBasicMaterial({ color: 0x444444 }), // 5: 底面
  ];
}

// ─── headless-gl + Three.js ───────────────────────────────────────────────────
function createRenderer(){
  const glCtx=gl(WIDTH,HEIGHT,{preserveDrawingBuffer:true});
  const vaoExt=glCtx.getExtension('OES_vertex_array_object');
  if(vaoExt){
    glCtx.createVertexArray=()=>vaoExt.createVertexArrayOES();
    glCtx.bindVertexArray=v=>vaoExt.bindVertexArrayOES(v);
    glCtx.deleteVertexArray=v=>vaoExt.deleteVertexArrayOES(v);
    glCtx.isVertexArray=v=>vaoExt.isVertexArrayOES(v);
    console.log('[GL] VAO patched');
  }else{
    glCtx.createVertexArray=()=>({_stub:true});
    glCtx.bindVertexArray=()=>{};glCtx.deleteVertexArray=()=>{};glCtx.isVertexArray=()=>false;
  }
  const canvasMock={width:WIDTH,height:HEIGHT,style:{},addEventListener:()=>{},removeEventListener:()=>{},setAttribute:()=>{},getContext:()=>glCtx};
  const renderer=new THREE.WebGLRenderer({canvas:canvasMock,context:glCtx,antialias:false});
  renderer.setSize(WIDTH,HEIGHT,false);renderer.setPixelRatio(1);
  return{renderer,glCtx};
}

function buildScene(map){
  BUILDING_TYPES = {};
  const rng=(()=>{let s=42;return()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff;};})();
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(map[r][c]===BUILDING) BUILDING_TYPES[r+'_'+c]=Math.floor(rng()*BLDG_TYPES.length);
  }

  const S=new THREE.Scene();S.background=new THREE.Color(0x020406);
  S.add(new THREE.AmbientLight(0xffffff,1.0));
  const gnd=new THREE.Mesh(new THREE.PlaneGeometry(W,W),new THREE.MeshBasicMaterial({color:0x060a0f}));
  gnd.position.set(W/2,W/2,0);S.add(gnd);
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    const t=map[r][c],cx=c*CELL+CELL*.5,cy=r*CELL+CELL*.5;
    if(t===BUILDING){
      const typeIdx=BUILDING_TYPES[r+'_'+c]||0;
      const bt=BLDG_TYPES[typeIdx%BLDG_TYPES.length];
      const h=bt.height*CELL;
      const mat=getBuildingMaterial(typeIdx);
      const m=new THREE.Mesh(new THREE.BoxGeometry(CELL*.8,CELL*.8,h),mat);
      m.position.set(cx,cy,h/2);S.add(m);
    }else if(t===TREE){
      const tr=new THREE.Mesh(new THREE.BoxGeometry(CELL*.15,CELL*.15,CELL*.4),new THREE.MeshBasicMaterial({color:0x4a3020}));
      tr.position.set(cx,cy,CELL*.2);S.add(tr);
      const cn=new THREE.Mesh(new THREE.BoxGeometry(CELL*.55,CELL*.55,CELL*.45),new THREE.MeshBasicMaterial({color:0x236826}));
      cn.position.set(cx,cy,CELL*.58);S.add(cn);
    }else if(t===ROAD){
      const m=new THREE.Mesh(new THREE.PlaneGeometry(CELL*.97,CELL*.97),new THREE.MeshBasicMaterial({color:0x555555}));
      m.position.set(cx,cy,.008);S.add(m);
    }else{
      const m=new THREE.Mesh(new THREE.PlaneGeometry(CELL*.97,CELL*.97),new THREE.MeshBasicMaterial({color:0x1a3020}));
      m.position.set(cx,cy,.005);S.add(m);
    }
  }
  return S;
}

function createAgentMesh(S,color){
  const body=new THREE.Mesh(new THREE.BoxGeometry(CELL*.3,CELL*.3,CELL*.52),new THREE.MeshBasicMaterial({color}));
  const head=new THREE.Mesh(new THREE.BoxGeometry(CELL*.22,CELL*.22,CELL*.22),new THREE.MeshBasicMaterial({color:0xffd9aa}));
  head.position.set(0,0,CELL*.4);body.add(head);
  const nose=new THREE.Mesh(new THREE.BoxGeometry(CELL*.08,CELL*.08,CELL*.12),new THREE.MeshBasicMaterial({color:0xffffff}));
  nose.position.set(0,CELL*.18,CELL*.12);body.add(nose);
  S.add(body);return body;
}

// ─── RGBA → JPEG ─────────────────────────────────────────────────────────────
async function rgbaToJpeg(rgba, width, height){
  if(sharp){
    return await sharp(Buffer.from(rgba),{raw:{width,height,channels:4}})
      .jpeg({quality:JPEG_Q}).toBuffer();
  }
  const rgb=Buffer.alloc(width*height*3);
  for(let i=0;i<width*height;i++){rgb[i*3]=rgba[i*4];rgb[i*3+1]=rgba[i*4+1];rgb[i*3+2]=rgba[i*4+2];}
  return rgb;
}

// ─── Pixel readout ────────────────────────────────────────────────────────────
function readPixels(glCtx){
  const px=new Uint8ClampedArray(WIDTH*HEIGHT*4);
  glCtx.readPixels(0,0,WIDTH,HEIGHT,glCtx.RGBA,glCtx.UNSIGNED_BYTE,px);
  const fl=new Uint8ClampedArray(WIDTH*HEIGHT*4),row=WIDTH*4;
  for(let y=0;y<HEIGHT;y++)fl.set(px.subarray((HEIGHT-1-y)*row,(HEIGHT-y)*row),y*row);
  return fl;
}

// ─── Simulation state ─────────────────────────────────────────────────────────
let MAP=makeMap(GRID,42), BUILDINGS=[];
function rebuildBuildings(map){BUILDINGS.length=0;for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)if(map[r][c]===BUILDING)BUILDINGS.push([r,c]);}
rebuildBuildings(MAP);
function randB(ex){for(let i=0;i<500;i++){const b=BUILDINGS[Math.floor(Math.random()*BUILDINGS.length)];if(!ex||Math.abs(b[0]-ex[0])>1||Math.abs(b[1]-ex[1])>1)return[...b];}return[...BUILDINGS[0]];}

let agents=[], agentMeshes=[], trailMats={};
let scene=null;   // ★ async init 完了まで null のまま
let paused=false, speedMul=1;

function initAgents(S){
  agents.forEach(a=>{if(a.mesh)S.remove(a.mesh);a.trail.forEach(m=>S.remove(m));});
  agents=[];agentMeshes=[];
  PERSONA_DEFS.forEach(def=>{
    const b=randB(null),g=randB(b);
    agents.push({x:b[0]+0.5,y:b[1]+0.5,th:Math.random()*Math.PI*2,gx:g[0]+0.5,gy:g[1]+0.5,trips:0,viols:0,steps:0,stall:0,def,trail:[],active:true,visited:new Set(),explored:0});
    agentMeshes.push(createAgentMesh(S,def.color));
  });
  console.log(`[Sim] ${agents.length} agents initialized`);
}

function addTrail(S,agent){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(CELL*.2,CELL*.2),trailMats[agent.def.id]);
  m.position.set(agent.y*CELL+CELL*.5,agent.x*CELL+CELL*.5,.04);
  S.add(m);agent.trail.push(m);
  if(agent.trail.length>50){S.remove(agent.trail.shift());}
}

async function stepAll(){
  if(paused || !scene) return;   // ★ scene null ガード
  stepCount++;
  await prefetchAllActions(MAP, agents);
  for(let i=0;i<agents.length;i++){
    const a=agents[i];
    const px=a.x,py=a.y;
    const action=selectAction(a);
    if(action===1)a.th-=ROT;else if(action===2)a.th+=ROT;
    a.th=(a.th+Math.PI*2)%(Math.PI*2);
    if(action===0){
      const nx=Math.max(0.01,Math.min(GRID-0.01,a.x+Math.cos(a.th)*MOVE));
      const ny=Math.max(0.01,Math.min(GRID-0.01,a.y+Math.sin(a.th)*MOVE));
      const r=Math.max(0,Math.min(GRID-1,Math.floor(nx)));
      const c=Math.max(0,Math.min(GRID-1,Math.floor(ny)));
      if(PASSABLE.has(MAP[r][c])){
        a.x=nx;a.y=ny;
        const key=`${r},${c}`;if(!a.visited.has(key)){a.visited.add(key);a.explored++;}
        addTrail(scene,a);
      }else a.viols++;
    }
    a.steps++;
    const moved=(Math.abs(a.x-px)+Math.abs(a.y-py))>0.05;
    a.stall=moved?0:Math.min(a.stall+1,10);
    const dist=Math.sqrt((a.x-a.gx)**2+(a.y-a.gy)**2);
    if(dist<0.8){a.trips++;const g=randB([Math.floor(a.x),Math.floor(a.y)]);a.gx=g[0]+0.5;a.gy=g[1]+0.5;}
  }
}

function handleCommand(msg){
  switch(msg.cmd){
    case 'pause': paused=!paused; break;
    case 'reset': if(scene) initAgents(scene); break;
    case 'speed': speedMul=[1,2,4][(([1,2,4].indexOf(speedMul)+1)%3)]; break;
    case 'newmap':
      MAP=makeMap(GRID,Math.floor(Math.random()*100000));
      rebuildBuildings(MAP);
      scene=buildScene(MAP);
      PERSONA_DEFS.forEach(p=>{trailMats[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});});
      if(scene) initAgents(scene);
      break;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const {renderer, glCtx} = createRenderer();
const mainCam = new THREE.PerspectiveCamera(60, WIDTH/HEIGHT, 0.1, 1200);
mainCam.up.set(0,0,1);

// ── 追跡カメラ ────────────────────────────────────────────────
const CAM_OVERVIEW_INTERVAL = 5000;
let camTargetIdx  = 0;
let camSwitchTimer = Date.now();

function updateTrackingCamera(cam) {
  const now = Date.now();
  if (now - camSwitchTimer > CAM_OVERVIEW_INTERVAL) {
    camTargetIdx = (camTargetIdx + 1) % (agents.length + 1);
    camSwitchTimer = now;
  }
  cam.up.set(0, 1, 0);
  if (camTargetIdx === 0 || agents.length === 0) {
    cam.position.set(W*.5, W*.5, W*0.75);
    cam.lookAt(W*.5, W*.5 + 1, 0);
  } else {
    const a = agents[camTargetIdx - 1];
    if (!a) return;
    const tx = a.y * CELL + CELL * .5;
    const ty = a.x * CELL + CELL * .5;
    cam.position.set(tx, ty - CELL*5, CELL*7);
    cam.lookAt(tx, ty + CELL * 1.5, 0);
  }
}

// ─── WebSocket クライアント管理 ────────────────────────────────────────────────
const clients = new Set();

// ─── HTTP + WebSocket サーバー ─────────────────────────────────────────────────
const httpServer=http.createServer((req,res)=>{
  if(req.url==='/'||req.url==='/index.html'){
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(fs.readFileSync(path.join(__dirname,'client.html')));
  }else{res.writeHead(404);res.end();}
});

const wss=new WebSocket.Server({server:httpServer});

wss.on('connection',ws=>{
  clients.add(ws);
  console.log(`[WS] client joined total=${clients.size}`);
  ws.on('message',data=>{
    try{
      const msg=JSON.parse(data);
      if(msg.type==='command') handleCommand(msg);
    }catch(e){}
  });
  ws.on('close',()=>{clients.delete(ws);console.log(`[WS] client left total=${clients.size}`);});
  ws.on('error',()=>clients.delete(ws));
});

// ─── ループ関数定義 (startLoops() から呼ばれる) ───────────────────────────────

// sim ループ
let simRunning = false;
async function simLoop(){
  if(simRunning) return;
  simRunning = true;
  for(let s=0;s<speedMul;s++) await stepAll();
  simRunning = false;
}

// render + JPEG 配信ループ
let frameCount=0, encoding=false;
async function renderLoop(){
  if(!scene) return;          // ★ scene null ガード (二重保険)
  if(encoding) return;
  encoding=true;

  // エージェントメッシュ更新
  const dt=1/FPS;
  agents.forEach((a,i)=>{
    const tx=a.y*CELL+CELL*.5,ty=a.x*CELL+CELL*.5,m=agentMeshes[i];
    m.position.x+=(tx-m.position.x)*Math.min(1,dt*14);
    m.position.y+=(ty-m.position.y)*Math.min(1,dt*14);
    m.position.z=CELL*.26;
    const tar=-a.th+Math.PI*.5;
    let dr=tar-m.rotation.z;
    while(dr>Math.PI)dr-=Math.PI*2;while(dr<-Math.PI)dr+=Math.PI*2;
    m.rotation.z+=dr*Math.min(1,dt*14);
  });

  updateTrackingCamera(mainCam);
  renderer.render(scene, mainCam);
  frameCount++;

  if(clients.size===0){encoding=false;return;}

  try{
    const rgba=readPixels(glCtx);
    const jpeg=await rgbaToJpeg(rgba,WIDTH,HEIGHT);
    for(const ws of clients){
      if(ws.readyState===WebSocket.OPEN){
        ws.send(jpeg,(err)=>{if(err)clients.delete(ws);});
      }
    }
    if(frameCount%(FPS*10)===0)console.log(`[Render] frame=${frameCount} clients=${clients.size}`);
  }catch(e){console.error('[Render]',e.message);}

  encoding=false;
}

// stats ブロードキャスト
function statsLoop(){
  if(clients.size===0) return;
  const camName = camTargetIdx === 0 ? 'overview' : (agents[camTargetIdx-1]?.def.name || '-');
  const msg=JSON.stringify({type:'stats', camName, agents:agents.map(a=>({id:a.def.id,trips:a.trips,viols:a.viols,explored:a.explored}))});
  for(const ws of clients){if(ws.readyState===WebSocket.OPEN)ws.send(msg);}
}

/**
 * ★ 修正のポイント:
 *   全ての setInterval をここでまとめて開始する。
 *   この関数は async init (ONNX + テクスチャ + scene 構築) が
 *   完全に完了した後にのみ呼ばれるため、scene が null になることはない。
 */
function startLoops(){
  setInterval(simLoop,    TICK);
  setInterval(renderLoop, 1000/FPS);
  setInterval(statsLoop,  2000);
  console.log('[Loops] sim / render / stats loops started');
}

// ─── エントリポイント ──────────────────────────────────────────────────────────
(async()=>{
  console.log('[Init] loading ONNX sessions...');
  await loadOnnxSessions();

  console.log('[Init] preloading textures...');
  await preloadTextures();

  console.log('[Init] building scene...');
  scene = buildScene(MAP);

  PERSONA_DEFS.forEach(p=>{
    trailMats[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});
  });

  initAgents(scene);

  httpServer.listen(PORT, ()=>{
    console.log(`\n🚀 MESA City Sim → http://localhost:${PORT}\n`);
  });

  // ★ scene の構築が完全に終わってからループを開始する
  startLoops();
})();