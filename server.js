/**
 * MESA Persona City Sim — Cloud Rendering Server
 * Three.js (headless-gl r132) + ONNX (onnxruntime-node) + WebRTC
 *
 * Install:
 *   npm install three@0.132.2 gl@9.0.0-rc.9 ws @roamhq/wrtc onnxruntime-node
 *
 * ONNX files (optional):
 *   ./data/persona_A.onnx 〜 persona_E.onnx
 *
 * Run:
 *   node server.js
 */

'use strict';

const gl   = require('gl');
const THREE = require('three');
const { RTCPeerConnection, RTCSessionDescription, nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource, rgbaToI420 } = nonstandard;
const WebSocket = require('ws');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// onnxruntime-node はオプション (なくても動く)
let ort = null;
try { ort = require('onnxruntime-node'); console.log('[ONNX] onnxruntime-node loaded'); }
catch(e) { console.warn('[ONNX] onnxruntime-node not found — random mode only'); }

// ─── Config ──────────────────────────────────────────────────────────────────
const WIDTH  = 1280;
const HEIGHT = 720;
const FPS    = 30;
const PORT   = process.env.PORT || 8080;

// ─── Sim constants (index.htmlと同じ値) ──────────────────────────────────────
const GRID=30, CELL=2.0, TICK=120;
const OTHER=0, ROAD=1, BUILDING=2, TREE=3;
const PASSABLE = new Set([ROAD, BUILDING]);
const MOVE=0.25, ROT=Math.PI/9;
const RAY_DEG=[-60,-30,0,30,60];
const RAY_RAD=RAY_DEG.map(d=>d*Math.PI/180);
const RAY_MAX=6.0, RAY_STEP=0.15;
const W=GRID*CELL;

// FP画像 (ONNX観測用)
const IMG_W=64, IMG_H=64, IMG_CH=3;
const FP_FOV=Math.PI/3, FP_RAY_MAX=8.0, FP_RAY_STEP=0.1;
const FP_CELL_RGB=[[45,100,45],[80,80,80],[196,32,32],[35,104,40]];
const FP_SKY_RGB=[6,12,20], FP_FLOOR_RGB=[26,40,32];

const PERSONA_DEFS = [
  { id:'A', name:'探索者タロウ',   color:0xff3355, hex:'#ff3355', desc:'新しい場所を積極的に探索' },
  { id:'B', name:'インドア花子',   color:0x00ccff, hex:'#00ccff', desc:'最短経路で目的地へ' },
  { id:'C', name:'社交家ケンジ',   color:0x33ff88, hex:'#33ff88', desc:'他者の近くに集まる' },
  { id:'D', name:'ビジネスマン誠', color:0xffee00, hex:'#ffee00', desc:'効率重視で直進' },
  { id:'E', name:'観光客サラ',     color:0xff7700, hex:'#ff7700', desc:'建物を巡って観光' },
];

// ─── マップ生成 (index.htmlと同じ) ───────────────────────────────────────────
function makeMap(size, seed){
  let s=seed>>>0;
  const rng=()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff};
  const ri=n=>Math.floor(rng()*n);
  const pick=a=>a[ri(a.length)];
  const g=Array.from({length:size},()=>new Array(size).fill(OTHER));
  const step=4;
  const rows=[],cols=[];
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
  const isIntersection=(r,c)=>rows.includes(r)&&cols.includes(c);
  const candidates=[];
  for(let r=0;r<size;r++)for(let c=0;c<size;c++)
    if(g[r][c]===ROAD&&!isIntersection(r,c))candidates.push([r,c]);
  for(let i=candidates.length-1;i>0;i--){
    const j=ri(i+1);[candidates[i],candidates[j]]=[candidates[j],candidates[i]];
  }
  function roadConnected(grid){
    let sr=-1,sc=-1;
    outer:for(let r=0;r<size;r++)for(let c=0;c<size;c++)
      if(grid[r][c]===ROAD){sr=r;sc=c;break outer;}
    if(sr<0)return true;
    const visited=new Set(),queue=[[sr,sc]];
    visited.add(sr*size+sc);
    const dirs=[[-1,0],[1,0],[0,-1],[0,1]];
    while(queue.length){
      const [r,c]=queue.shift();
      for(const [dr,dc] of dirs){
        const nr=r+dr,nc=c+dc;
        if(nr<0||nr>=size||nc<0||nc>=size)continue;
        const key=nr*size+nc;
        if(!visited.has(key)&&grid[nr][nc]===ROAD){visited.add(key);queue.push([nr,nc]);}
      }
    }
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)
      if(grid[r][c]===ROAD&&!visited.has(r*size+c))return false;
    return true;
  }
  const removeRatio=0.30+rng()*0.25;
  const maxRemove=Math.floor(candidates.length*removeRatio);
  let removed=0;
  for(const [r,c] of candidates){
    if(removed>=maxRemove)break;
    g[r][c]=OTHER;
    if(roadConnected(g)){g[r][c]=rng()<0.4?TREE:OTHER;removed++;}
    else{g[r][c]=ROAD;}
  }
  return g;
}

// ─── レイキャスト ─────────────────────────────────────────────────────────────
function raycast(map,x,y,th){
  return RAY_RAD.map(da=>{
    const angle=th+da,dx=Math.cos(angle),dy=Math.sin(angle);
    for(let d=RAY_STEP;d<RAY_MAX;d+=RAY_STEP){
      const nx=x+dx*d,ny=y+dy*d;
      const r=Math.floor(nx),c=Math.floor(ny);
      if(r<0||r>=GRID||c<0||c>=GRID)return{type:OTHER,dist:d,norm:d/RAY_MAX};
      const ct=map[r][c];
      if(ct===BUILDING||ct===TREE)return{type:ct,dist:d,norm:d/RAY_MAX};
    }
    return{type:ROAD,dist:RAY_MAX,norm:1.0};
  });
}

// ─── FP画像生成 (ONNX観測) ───────────────────────────────────────────────────
function renderFPImage(map,agent){
  const buf=new Float32Array(IMG_CH*IMG_H*IMG_W);
  for(let xi=0;xi<IMG_W;xi++){
    const rayAngle=agent.th+FP_FOV*(xi/(IMG_W-1)-0.5);
    const rdx=Math.cos(rayAngle),rdy=Math.sin(rayAngle);
    let hitType=-1,hitDist=FP_RAY_MAX;
    for(let d=FP_RAY_STEP;d<FP_RAY_MAX;d+=FP_RAY_STEP){
      const nx=agent.x+rdx*d,ny=agent.y+rdy*d;
      const r=Math.floor(nx),c=Math.floor(ny);
      if(r<0||r>=GRID||c<0||c>=GRID){hitType=OTHER;hitDist=d;break;}
      const ct=map[r][c];
      if(ct!==ROAD){hitType=ct;hitDist=d;break;}
    }
    const colH=hitType>=0?Math.min(IMG_H*1.5/Math.max(hitDist,0.1),IMG_H):0;
    const y0=Math.floor((IMG_H-colH)*0.5),y1=Math.floor(y0+colH);
    const bright=hitType>=0?Math.max(0.15,1.0-hitDist/FP_RAY_MAX):0;
    const rgb=hitType>=0?FP_CELL_RGB[hitType]:[0,0,0];
    for(let yi=0;yi<IMG_H;yi++){
      let rv,gv,bv;
      if(yi>=y0&&yi<y1){rv=rgb[0]/255*bright;gv=rgb[1]/255*bright;bv=rgb[2]/255*bright;}
      else if(yi<IMG_H*0.5){rv=FP_SKY_RGB[0]/255;gv=FP_SKY_RGB[1]/255;bv=FP_SKY_RGB[2]/255;}
      else{rv=FP_FLOOR_RGB[0]/255;gv=FP_FLOOR_RGB[1]/255;bv=FP_FLOOR_RGB[2]/255;}
      const pidx=yi*IMG_W+xi;
      buf[0*IMG_H*IMG_W+pidx]=rv;
      buf[1*IMG_H*IMG_W+pidx]=gv;
      buf[2*IMG_H*IMG_W+pidx]=bv;
    }
  }
  return buf;
}

// ─── ONNX セッション読み込み ──────────────────────────────────────────────────
const ortSessions = {};  // id → ort.InferenceSession
const obsDims     = {};  // id → number

async function loadOnnxSessions(){
  if(!ort){ console.log('[ONNX] skipped (not installed)'); return; }
  for(const p of PERSONA_DEFS){
    const onnxPath = path.join(__dirname, 'data', `persona_${p.id}.onnx`);
    const metaPath = path.join(__dirname, 'data', `persona_${p.id}_meta.json`);
    // meta
    if(fs.existsSync(metaPath)){
      try{
        const meta = JSON.parse(fs.readFileSync(metaPath,'utf8'));
        if(meta.input_size) obsDims[p.id] = meta.input_size;
        if(meta.persona_name){
          const idx=PERSONA_DEFS.findIndex(x=>x.id===p.id);
          if(idx>=0) PERSONA_DEFS[idx].name=meta.persona_name;
        }
        console.log(`[ONNX] meta ${p.id}: input_size=${obsDims[p.id]}`);
      }catch(e){ console.warn(`[ONNX] meta ${p.id} parse error:`,e.message); }
    }
    // onnx
    if(fs.existsSync(onnxPath)){
      try{
        ortSessions[p.id] = await ort.InferenceSession.create(onnxPath,{
          executionProviders:['cpu'],
          graphOptimizationLevel:'all',
        });
        const dim=obsDims[p.id]||(IMG_CH*IMG_H*IMG_W);
        const inputName=ortSessions[p.id].inputNames[0];
        const t=new ort.Tensor('float32',new Float32Array(dim),[1,dim]);
        await ortSessions[p.id].run({[inputName]:t});
        console.log(`[ONNX] persona_${p.id} loaded & tested OK`);
      }catch(e){
        console.warn(`[ONNX] persona_${p.id} failed:`,e.message);
        ortSessions[p.id]=null;
      }
    }else{
      console.log(`[ONNX] persona_${p.id}.onnx not found → random mode`);
    }
  }
}

// ─── 行動選択 ─────────────────────────────────────────────────────────────────
async function selectAction(map, agent){
  const session = ortSessions[agent.def.id];
  if(session){
    try{
      const obs=renderFPImage(map,agent);
      const dim=obsDims[agent.def.id]||(IMG_CH*IMG_H*IMG_W);
      const inputName=session.inputNames[0];
      const outputName=session.outputNames[0];
      const t=new ort.Tensor('float32',obs,[1,dim]);
      const out=await session.run({[inputName]:t});
      const lg=Array.from(out[outputName].data);
      const mx=Math.max(...lg);
      const ex=lg.map(v=>Math.exp(v-mx));
      const sm=ex.reduce((a,b)=>a+b,0);
      const pr=ex.map(v=>v/sm);
      let rv=Math.random();
      for(let i=0;i<pr.length;i++){rv-=pr[i];if(rv<=0)return i;}
      return 0;
    }catch(e){return Math.floor(Math.random()*3);}
  }
  // ランダム (前進バイアス)
  const rays=raycast(map,agent.x,agent.y,agent.th);
  return (rays[2].type===ROAD&&Math.random()<0.55)?0:(Math.random()<0.5?1:2);
}

// ─── Headless GL + Three.js ───────────────────────────────────────────────────
function createHeadlessRenderer(){
  const glCtx = gl(WIDTH, HEIGHT, { preserveDrawingBuffer: true });
  const vaoExt = glCtx.getExtension('OES_vertex_array_object');
  if(vaoExt){
    glCtx.createVertexArray = ()=>vaoExt.createVertexArrayOES();
    glCtx.bindVertexArray   = v=>vaoExt.bindVertexArrayOES(v);
    glCtx.deleteVertexArray = v=>vaoExt.deleteVertexArrayOES(v);
    glCtx.isVertexArray     = v=>vaoExt.isVertexArrayOES(v);
    console.log('[GL] VAO patched');
  } else {
    glCtx.createVertexArray = ()=>({_stub:true});
    glCtx.bindVertexArray   = ()=>{};
    glCtx.deleteVertexArray = ()=>{};
    glCtx.isVertexArray     = ()=>false;
  }
  const canvasMock = {
    width:WIDTH, height:HEIGHT, style:{},
    addEventListener:()=>{}, removeEventListener:()=>{}, setAttribute:()=>{},
    getContext:()=>glCtx,
  };
  const renderer = new THREE.WebGLRenderer({ canvas:canvasMock, context:glCtx, antialias:false });
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.setPixelRatio(1);
  return { renderer, glCtx };
}

// ─── シーン構築 ───────────────────────────────────────────────────────────────
function buildScene(map){
  const S = new THREE.Scene();
  S.background = new THREE.Color(0x020406);

  // ライト (MeshBasicMaterialはライティング不要だが、ambient入れておく)
  S.add(new THREE.AmbientLight(0xffffff, 1.0));

  // 地面
  const gnd = new THREE.Mesh(
    new THREE.PlaneGeometry(W, W),
    new THREE.MeshBasicMaterial({ color: 0x060a0f })
  );
  gnd.position.set(W/2, W/2, 0);
  S.add(gnd);

  // タイル
  for(let r=0;r<GRID;r++){
    for(let c=0;c<GRID;c++){
      const t=map[r][c];
      const cx=c*CELL+CELL*.5, cy=r*CELL+CELL*.5;
      if(t===BUILDING){
        const h=(0.9+((r*GRID+c)%7)*.3)*CELL;
        const typeColors=[0xe8a020,0xe03030,0x20a020,0x8B5E3C,0x4060a0,0xa06040,0x20a8e0,0xe0e0f0];
        const col=typeColors[(r*GRID+c)%typeColors.length];
        const m=new THREE.Mesh(
          new THREE.BoxGeometry(CELL*.8,CELL*.8,h),
          new THREE.MeshBasicMaterial({color:col})
        );
        m.position.set(cx,cy,h/2); S.add(m);
        // 屋上 (白)
        const roof=new THREE.Mesh(
          new THREE.BoxGeometry(CELL*.82,CELL*.82,0.06),
          new THREE.MeshBasicMaterial({color:0xaaaaaa})
        );
        roof.position.set(cx,cy,h); S.add(roof);
      } else if(t===TREE){
        const tr=new THREE.Mesh(
          new THREE.BoxGeometry(CELL*.15,CELL*.15,CELL*.4),
          new THREE.MeshBasicMaterial({color:0x4a3020})
        );
        tr.position.set(cx,cy,CELL*.2); S.add(tr);
        const cn=new THREE.Mesh(
          new THREE.BoxGeometry(CELL*.55,CELL*.55,CELL*.45),
          new THREE.MeshBasicMaterial({color:0x236826})
        );
        cn.position.set(cx,cy,CELL*.58); S.add(cn);
      } else if(t===ROAD){
        const m=new THREE.Mesh(
          new THREE.PlaneGeometry(CELL*.97,CELL*.97),
          new THREE.MeshBasicMaterial({color:0x555555})
        );
        m.position.set(cx,cy,.008); S.add(m);
      } else {
        const m=new THREE.Mesh(
          new THREE.PlaneGeometry(CELL*.97,CELL*.97),
          new THREE.MeshBasicMaterial({color:0x1a3020})
        );
        m.position.set(cx,cy,.005); S.add(m);
      }
    }
  }
  return S;
}

// ─── エージェントメッシュ ─────────────────────────────────────────────────────
function createAgentMesh(S, color){
  const body=new THREE.Mesh(
    new THREE.BoxGeometry(CELL*.3,CELL*.3,CELL*.52),
    new THREE.MeshBasicMaterial({color})
  );
  const head=new THREE.Mesh(
    new THREE.BoxGeometry(CELL*.22,CELL*.22,CELL*.22),
    new THREE.MeshBasicMaterial({color:0xffd9aa})
  );
  head.position.set(0,0,CELL*.4);
  body.add(head);
  const nose=new THREE.Mesh(
    new THREE.BoxGeometry(CELL*.08,CELL*.08,CELL*.12),
    new THREE.MeshBasicMaterial({color:0xffffff})
  );
  nose.position.set(0,CELL*.18,CELL*.12);
  body.add(nose);
  S.add(body);
  return body;
}

// ─── トレイルメッシュ ─────────────────────────────────────────────────────────
function addTrail(S, agent, trailMats){
  const m=new THREE.Mesh(
    new THREE.PlaneGeometry(CELL*.2,CELL*.2),
    trailMats[agent.def.id]
  );
  m.position.set(agent.y*CELL+CELL*.5, agent.x*CELL+CELL*.5, .04);
  S.add(m);
  agent.trail.push(m);
  if(agent.trail.length>50){ S.remove(agent.trail.shift()); }
}

// ─── カメラ ───────────────────────────────────────────────────────────────────
function updateCamera(cam, camAngle){
  cam.position.set(W*.5, -W*.15, W*1.25);
  cam.up.set(0,1,0);
  cam.lookAt(W*.5, W*.5, 0);
}

// ─── Pixel readout ────────────────────────────────────────────────────────────
function readPixels(glCtx){
  const pixels=new Uint8ClampedArray(WIDTH*HEIGHT*4);
  glCtx.readPixels(0,0,WIDTH,HEIGHT,glCtx.RGBA,glCtx.UNSIGNED_BYTE,pixels);
  const flipped=new Uint8ClampedArray(WIDTH*HEIGHT*4);
  const row=WIDTH*4;
  for(let y=0;y<HEIGHT;y++)
    flipped.set(pixels.subarray((HEIGHT-1-y)*row,(HEIGHT-y)*row),y*row);
  return flipped;
}

// ─── Simulation state ─────────────────────────────────────────────────────────
let MAP = makeMap(GRID, 42);
let BUILDINGS = [];
function rebuildBuildings(map){ BUILDINGS.length=0; for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)if(map[r][c]===BUILDING)BUILDINGS.push([r,c]); }
rebuildBuildings(MAP);

function randB(ex){
  for(let i=0;i<500;i++){
    const b=BUILDINGS[Math.floor(Math.random()*BUILDINGS.length)];
    if(!ex||Math.abs(b[0]-ex[0])>1||Math.abs(b[1]-ex[1])>1)return[...b];
  }
  return[...BUILDINGS[0]];
}

let agents=[], agentMeshes=[];

function initAgents(S){
  agents.forEach(a=>{
    if(a.mesh)S.remove(a.mesh);
    a.trail.forEach(m=>S.remove(m));
  });
  agents=[]; agentMeshes=[];
  PERSONA_DEFS.forEach(def=>{
    const b=randB(null), g=randB(b);
    agents.push({
      x:b[0]+0.5,y:b[1]+0.5,th:Math.random()*Math.PI*2,
      gx:g[0]+0.5,gy:g[1]+0.5,
      trips:0,viols:0,steps:0,stall:0,
      def,trail:[],active:true,
      visited:new Set(),explored:0,
    });
    agentMeshes.push(createAgentMesh(S, def.color));
  });
  console.log(`[Sim] ${agents.length} agents initialized`);
}

let paused=false, speedMul=1;

async function stepAll(S, trailMats){
  if(paused)return;
  for(let i=0;i<agents.length;i++){
    const a=agents[i];
    const prevX=a.x,prevY=a.y;
    const action=await selectAction(MAP,a);
    if(action===1)a.th-=ROT;
    else if(action===2)a.th+=ROT;
    a.th=(a.th+Math.PI*2)%(Math.PI*2);
    if(action===0){
      const nx=Math.max(0.01,Math.min(GRID-0.01,a.x+Math.cos(a.th)*MOVE));
      const ny=Math.max(0.01,Math.min(GRID-0.01,a.y+Math.sin(a.th)*MOVE));
      const r=Math.max(0,Math.min(GRID-1,Math.floor(nx)));
      const c=Math.max(0,Math.min(GRID-1,Math.floor(ny)));
      if(PASSABLE.has(MAP[r][c])){
        a.x=nx;a.y=ny;
        const key=`${r},${c}`;
        if(!a.visited.has(key)){a.visited.add(key);a.explored++;}
        addTrail(S,a,trailMats);
      }else{a.viols++;}
    }
    a.steps++;
    const moved=(Math.abs(a.x-prevX)+Math.abs(a.y-prevY))>0.05;
    a.stall=moved?0:Math.min(a.stall+1,10);
    const dist=Math.sqrt((a.x-a.gx)**2+(a.y-a.gy)**2);
    if(dist<0.8){
      a.trips++;
      const g=randB([Math.floor(a.x),Math.floor(a.y)]);
      a.gx=g[0]+0.5;a.gy=g[1]+0.5;
    }
  }
}

// ─── Main rendering + sim loop ────────────────────────────────────────────────
const { renderer, glCtx } = createHeadlessRenderer();

const mainCam = new THREE.PerspectiveCamera(52, WIDTH/HEIGHT, 0.1, 1200);
updateCamera(mainCam, 0);

let scene = buildScene(MAP);

const trailMats={};
PERSONA_DEFS.forEach(p=>{
  trailMats[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});
});

initAgents(scene);

// WebRTC video sources (全クライアント共有)
const videoSources = new Set();
const i420Data = new Uint8Array(WIDTH * HEIGHT * 3 / 2);

let lastRenderTime = 0;
let frameCount = 0;

// sim loop (TICK ms ごと)
setInterval(async()=>{
  for(let s=0;s<speedMul;s++) await stepAll(scene, trailMats);
}, TICK);

// render loop (1000/FPS ms ごと)
setInterval(()=>{
  // エージェントメッシュ更新
  const dt = 1/FPS;
  agents.forEach((a,i)=>{
    const tx=a.y*CELL+CELL*.5, ty=a.x*CELL+CELL*.5;
    const m=agentMeshes[i];
    m.position.x+=(tx-m.position.x)*Math.min(1,dt*14);
    m.position.y+=(ty-m.position.y)*Math.min(1,dt*14);
    m.position.z=CELL*.26;
    const tar=-a.th+Math.PI*.5;
    let dr=tar-m.rotation.z;
    while(dr>Math.PI)dr-=Math.PI*2;
    while(dr<-Math.PI)dr+=Math.PI*2;
    m.rotation.z+=dr*Math.min(1,dt*14);
  });

  renderer.render(scene, mainCam);
  frameCount++;

  if(videoSources.size===0)return;  // クライアントなしなら変換省略

  const rgba = readPixels(glCtx);
  rgbaToI420(
    {width:WIDTH, height:HEIGHT, data:rgba},
    {width:WIDTH, height:HEIGHT, data:i420Data}
  );
  const frame = {width:WIDTH, height:HEIGHT, data:i420Data};
  for(const src of videoSources){
    try{ src.onFrame(frame); }catch(e){}
  }

  if(frameCount % (FPS*10) === 0){
    const a=agents[0];
    console.log(`[Sim] frame=${frameCount} clients=${videoSources.size} agent0=(${a.x.toFixed(1)},${a.y.toFixed(1)}) trips=${a.trips}`);
  }
}, 1000/FPS);

// ─── WebSocket control messages ───────────────────────────────────────────────
// クライアントからの操作コマンドを受け付ける
function handleCommand(msg){
  switch(msg.cmd){
    case 'pause':  paused=!paused; break;
    case 'reset':  initAgents(scene); break;
    case 'speed':  speedMul=[1,2,4][(([1,2,4].indexOf(speedMul)+1)%3)]; break;
    case 'newmap':
      MAP=makeMap(GRID, Math.floor(Math.random()*100000));
      rebuildBuildings(MAP);
      // シーン再構築
      scene = buildScene(MAP);
      const trailMatsNew={};
      PERSONA_DEFS.forEach(p=>{
        trailMatsNew[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});
      });
      Object.assign(trailMats, trailMatsNew);
      initAgents(scene);
      break;
  }
}

// ─── Per-client WebRTC session ────────────────────────────────────────────────
class ClientSession {
  constructor(ws){
    this.ws=ws;
    this.pc=null;
    this.videoSource=new RTCVideoSource();
    videoSources.add(this.videoSource);
    console.log(`[Session] client joined  total=${videoSources.size}`);
  }
  async start(offer){
    this.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    const track=this.videoSource.createTrack();
    this.pc.addTrack(track);
    this.pc.onicecandidate=({candidate})=>{ if(candidate) this.send({type:'candidate',candidate}); };
    this.pc.onconnectionstatechange=()=>console.log('[RTC]',this.pc.connectionState);
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer=await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send({type:'answer',sdp:answer.sdp});
  }
  addIceCandidate(c){ if(this.pc) this.pc.addIceCandidate(c).catch(console.error); }
  send(msg){ if(this.ws.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  destroy(){
    videoSources.delete(this.videoSource);
    if(this.pc)this.pc.close();
    console.log(`[Session] client left  total=${videoSources.size}`);
  }
}

// ─── HTTP + WS ────────────────────────────────────────────────────────────────
const httpServer=http.createServer((req,res)=>{
  if(req.url==='/'||req.url==='/index.html'){
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(fs.readFileSync(path.join(__dirname,'client.html')));
  }else{res.writeHead(404);res.end();}
});

const wss=new WebSocket.Server({server:httpServer});
const clientSessions=new Map();

wss.on('connection',ws=>{
  const s=new ClientSession(ws);
  clientSessions.set(ws,s);
  ws.on('message',async data=>{
    const msg=JSON.parse(data);
    if(msg.type==='offer')     await s.start(msg);
    if(msg.type==='candidate') s.addIceCandidate(msg.candidate);
    if(msg.type==='command')   handleCommand(msg);
  });
  ws.on('close',()=>{ s.destroy(); clientSessions.delete(ws); });
  ws.on('error',console.error);
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async()=>{
  await loadOnnxSessions();
  httpServer.listen(PORT,()=>{
    console.log(`\n🚀 MESA City Sim → http://localhost:${PORT}`);
    console.log(`   ONNX sessions: ${Object.keys(ortSessions).filter(k=>ortSessions[k]).join(', ')||'none (random mode)'}\n`);
  });
})();