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
const { spawn } = require('child_process');

// JPEG エンコードに sharp を使う（なければ簡易RGB返し）
let sharp = null;
try { sharp = require('sharp'); console.log('[Sharp] loaded'); }
catch(e) { console.warn('[Sharp] not found — install sharp for better performance'); }

// onnxruntime-node はオプション
let ort = null;
try { ort = require('onnxruntime-node'); console.log('[ONNX] loaded'); }
catch(e) { console.warn('[ONNX] not found — random mode'); }

// ─── Config: 配信解像度 / アスペクト比 / 画質 / FPS ─────────────────────────────
// アスペクト比と画質を ASPECT / QUALITY プリセットで簡単に切替できる。
//   ASPECT  : 'square' (1:1・従来)      | 'wide' (16:9・YouTube向け)
//   QUALITY : 'H'(高画質) | 'M'(中) | 'L'(低負荷・回線が不安定なとき)
//   例:  ASPECT=wide QUALITY=L node server.js
// WIDTH/HEIGHT/FPS/JPEG_Q/YT_VIDEO_BITRATE_K を個別指定した場合はそちらが優先される。
const STREAM_ASPECTS = { square: 1/1, wide: 16/9 };
const STREAM_PRESETS = {
  //     h = 縦解像度(px) / fps / jpeg品質(0-100) / ytk = YouTube動画ビットレート(kbps)
  H: { h:720, fps:30, jpeg:95, ytk:2500 },   // 高画質 (回線良好時)
  M: { h:540, fps:30, jpeg:85, ytk:1500 },   // 中
  L: { h:480, fps:13, jpeg:80, ytk:1200  },   // 低負荷 (回線が不安定なとき)
};
const ASPECT  = STREAM_ASPECTS[process.env.ASPECT]  ? process.env.ASPECT  : 'wide';
const QUALITY = STREAM_PRESETS[process.env.QUALITY] ? process.env.QUALITY : 'L';
const _preset = STREAM_PRESETS[QUALITY];
const HEIGHT = parseInt(process.env.HEIGHT) || _preset.h;
// アスペクト比から横幅を算出 (動画エンコード要件で偶数へ丸める)
const WIDTH  = parseInt(process.env.WIDTH)  || (Math.round(HEIGHT * STREAM_ASPECTS[ASPECT] / 2) * 2);
const FPS    = parseInt(process.env.FPS)    || _preset.fps;
const JPEG_Q = parseInt(process.env.JPEG_Q) || _preset.jpeg;   // JPEG品質 (0-100)

// ─── CPU負荷 (推論スレッド数 / 推論頻度) ─────────────────────────────────────────
// しょぼいサーバーで CPU が張り付くとき用の負荷調整。DINOv2 をエージェント5体ぶん CPU で回すため、
// 未調整だと推論のたびに全コアを奪い 100% に張り付く。下の2つで抑えられる。
//   ONNX_THREADS : ONNX推論に使うスレッド数 (既定2)。小さいほど CPU を空ける (推論は遅くなる)。
//   INFER_EVERY  : 何 sim ステップごとに推論し直すか (既定10)。大きいほど推論回数が減り CPU が下がる。
//   例:  ONNX_THREADS=1 INFER_EVERY=30 node server.js
const ONNX_THREADS = parseInt(process.env.ONNX_THREADS) || 1;
const INFER_EVERY  = parseInt(process.env.INFER_EVERY)  || 45;
// 全 ONNX セッション共通のオプション (スレッド数を絞って全コア占有を防ぐ)
const ORT_OPTS = { executionProviders:['cpu'], intraOpNumThreads:ONNX_THREADS, interOpNumThreads:ONNX_THREADS };

// ─── カメラ演出 (追跡モード) ─────────────────────────────────────────────────────
//   CAM_MODE = 'A' : 既存ロジック。俯瞰 + 各エージェントを一定間隔で順番に巡回。
//              'B' : 動いているエージェントを優先的に追う。誰も動いていなければランダム。
//   CAM_INTERVAL_MS  : ターゲット切替の間隔 (既定20000ms)。
//   CAM_STALL_SWITCH : (Bのみ) 追跡中の対象がこの step 数ぶん停止したら、動いてる人へ早めに切替 (既定6)。
//   例:  CAM_MODE=B node server.js
//const CAM_MODE         = (process.env.CAM_MODE||'A').toUpperCase()==='B' ? 'B' : 'A';
const CAM_MODE = 'B';
const CAM_INTERVAL_MS  = parseInt(process.env.CAM_INTERVAL_MS)  || 20000;
const CAM_STALL_SWITCH = parseInt(process.env.CAM_STALL_SWITCH) || 6;
// FPV_CHANCE: ターゲット切替時に、そのキャラの一人称視点(目線)ショットになる確率 (0..1, 既定0.25)。
//             A/B どちらでも「たまに挟む」形で入る。0 で無効。 例: FPV_CHANCE=0.3 node server.js
const FPV_CHANCE       = (()=>{ const v=parseFloat(process.env.FPV_CHANCE); return isNaN(v)?0.25:Math.max(0,Math.min(1,v)); })();

console.log(`[Config] ASPECT=${ASPECT} QUALITY=${QUALITY} → ${WIDTH}x${HEIGHT} @ ${FPS}fps (jpeg ${JPEG_Q}) | onnxThreads=${ONNX_THREADS} inferEvery=${INFER_EVERY} | camMode=${CAM_MODE} fpv=${FPV_CHANCE}`);
const PORT   = process.env.PORT || 8080;
// 前進可否の判定方式: 既定はマップ配列(確実・学習と一致)。
// seg_head で学習し直した場合のみ SEG_GATE=1 で seg 判定に切替。
const SEG_GATE = process.env.SEG_GATE === '1';

// ─── YouTube ライブ配信 (任意) ─────────────────────────────────────────────────
// YT_STREAM_KEY がセットされている時だけ有効化。renderLoop の JPEG フレームを
// ffmpeg の stdin (image2pipe) へ流し込み、H.264/AAC(無音) で RTMP 送出する。
// WebSocket 配信には一切影響しない (フレームを追加コピーで横流しするだけ)。
const YT_STREAM_KEY = process.env.YT_STREAM_KEY || '';
const YT_RTMP_BASE  = process.env.YT_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2';
const YT_BITRATE_K  = parseInt(process.env.YT_VIDEO_BITRATE_K) || _preset.ytk;
const YT_ENABLED    = Boolean(YT_STREAM_KEY);

// ─── Sim constants ────────────────────────────────────────────────────────────
const GRID=30, CELL=2.0, TICK=parseInt(process.env.TICK)||150;
// 軌跡(trail)の最大点数。長いほど遠くまで残るが描画コスト(メッシュ数)が増える。
// 環境変数 MAX_TRAIL で可変。例: MAX_TRAIL=300 node server.js
const MAX_TRAIL=parseInt(process.env.MAX_TRAIL)||50;
// キャラクター / 軌跡マーカーの大きさ倍率 (1=従来)。街や建物に対して小さくしたい時に下げる。
// 環境変数 CHAR_SCALE / TRAIL_SCALE で可変。例: CHAR_SCALE=0.5 node server.js
const CHAR_SCALE =parseFloat(process.env.CHAR_SCALE) || 1/3;   // 人型の大きさ
const TRAIL_SCALE=parseFloat(process.env.TRAIL_SCALE)|| 1/3;   // 軌跡マーカーの大きさ
// INFER_EVERY / ONNX_THREADS は先頭の「CPU負荷」設定ブロックに移動
const OTHER=0, ROAD=1, BUILDING=2, TREE=3;
const PASSABLE = new Set([ROAD, BUILDING]);
const MOVE=0.25, ROT=Math.PI/9;
const RAY_MAX=6.0, RAY_STEP=0.15;
const W=GRID*CELL;
const IMG_W=64, IMG_H=64, IMG_CH=3;
const FP_FOV=Math.PI/3, FP_RAY_MAX=8.0, FP_RAY_STEP=0.1;
const FP_CELL_RGB=[[45,100,45],[80,80,80],[196,32,32],[35,104,40]];
const FP_SKY_RGB=[6,12,20], FP_FLOOR_RGB=[26,40,32];

// ─── ペルソナ定義 (外部設定ファイル personas.json から読み込み) ────────────────────
//   PERSONAS_FILE でパス変更可。ファイルが無い/壊れている場合は下記の既定5体を使う。
//   各ペルソナの id は行動モデル data/persona_<id>.onnx と対応 (無ければランダム移動)。
const PERSONA_FALLBACK = [
  { id:'A', name:'Explorer Rex',    color:0xff3355, hex:'#ff3355', desc:'Actively explores new areas' },
  { id:'B', name:'Homebody Lily',   color:0x00ccff, hex:'#00ccff', desc:'Takes the shortest route' },
  { id:'C', name:'Social Marco',    color:0x33ff88, hex:'#33ff88', desc:'Gathers near others' },
  { id:'D', name:'Businessman Cole',color:0xffee00, hex:'#ffee00', desc:'Moves straight, efficiency first' },
  { id:'E', name:'Tourist Elena',   color:0xff7700, hex:'#ff7700', desc:'Wanders around buildings' },
];
function loadPersonaDefs(){
  const fp = process.env.PERSONAS_FILE || path.join(__dirname,'personas.json');
  let raw = PERSONA_FALLBACK;
  try{
    if(fs.existsSync(fp)){
      const j = JSON.parse(fs.readFileSync(fp,'utf8'));
      const arr = Array.isArray(j) ? j : j.personas;
      if(Array.isArray(arr) && arr.length) raw = arr;
      else console.warn(`[Persona] ${fp} に personas 配列が無い → 既定5体を使用`);
    }else{
      console.warn(`[Persona] ${fp} が見つからない → 既定5体を使用`);
    }
  }catch(e){ console.warn(`[Persona] ${fp} 読み込み失敗: ${e.message} → 既定5体を使用`); }
  // 正規化: color(数値) と hex(文字列) を両方揃える (設定ファイルは "#RRGGBB" 文字列で書ける)
  return raw.map((p,i)=>{
    const col = (typeof p.color==='number')
      ? p.color
      : (parseInt(String(p.color||p.hex||'#888888').replace('#',''),16) || 0x888888);
    return {
      id:   String(p.id ?? String.fromCharCode(65+i)),
      name: p.name || `Persona ${p.id ?? i}`,
      color: col,
      hex:  '#'+col.toString(16).padStart(6,'0'),
      desc: p.desc || '',
    };
  });
}
const PERSONA_DEFS = loadPersonaDefs();
// キャラクター数 (1-50)。未設定ならペルソナ数。ペルソナ数より多い場合は一覧を巡回して割り当てる。
//const _numAgentsEnv = parseInt(process.env.NUM_AGENTS);
const _numAgentsEnv = 50;
const NUM_AGENTS = Number.isFinite(_numAgentsEnv)
  ? Math.max(1, Math.min(50, _numAgentsEnv))
  : PERSONA_DEFS.length;
console.log(`[Persona] ${PERSONA_DEFS.length} personas loaded | NUM_AGENTS=${NUM_AGENTS}`);

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
      // 敷地に余裕があれば一定確率で 2x2 の建物パッチを塗る (学校/病院/駅などの大型敷地)
      let patch=null;
      if(r1-r0>=2 && c1-c0>=2 && rng()<0.42){
        const pr=(rng()<0.5)?r0:r1-2, pc=(rng()<0.5)?c0:c1-2;
        for(let r=pr;r<pr+2;r++)for(let c=pc;c<pc+2;c++)g[r][c]=BUILDING;
        patch={pr,pc};
      }
      const b=pick(cells);g[b[0]][b[1]]=BUILDING;
      cells.forEach(([r,c])=>{
        if(r===b[0]&&c===b[1])return;
        if(patch && r>=patch.pr && r<patch.pr+2 && c>=patch.pc && c<patch.pc+2)return; // パッチ内は保持
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
// 観測方式は persona meta の input_size で決まる:
//   12288 (= img_w*img_h*img_ch)  → 旧CNN方式: 生FPV画像をそのままヘッドへ (persona E)
//   384 / 392                     → DINOv2方式: 224画像→DINOv2→CLS(384)[+建物分類8]→ヘッド
// DINOv2本体 (dinov2_vits14.onnx) と seg_head / building_classifier は
// 全ペルソナで共有する1セッションとしてロードする (メモリ最小化)。
const ortSessions={}, obsDims={}, personaMeta={};
let dinoSession=null, segSession=null, bldgSession=null, segMeta=null;
let dinoIn='image', dinoClsOut='cls', dinoPatchOut='patch';
let segIn='patch_tokens', segOut=null, bldgIn='dino_feat', bldgOut=null;
const inferErrLogged={};        // ペルソナごと: フォールバック警告を1回だけ出す
const segPassCache={};          // エージェント(aid)ごと: seg による前方通行可否 (キャッシュ)

// 共有 ONNX (DINOv2 / seg_head / building_classifier) をロード
async function loadSharedSessions(){
  if(!ort) return;
  const dinoPath=path.join(__dirname,'data','dinov2_vits14.onnx');
  if(fs.existsSync(dinoPath)){
    try{
      dinoSession=await ort.InferenceSession.create(dinoPath,ORT_OPTS);
      dinoIn=dinoSession.inputNames[0];
      // 出力名: cls / patch を名前で拾い、無ければ順番で割り当て
      const outs=dinoSession.outputNames;
      dinoClsOut=outs.find(n=>/cls/i.test(n))||outs[0];
      dinoPatchOut=outs.find(n=>/patch/i.test(n))||outs[1]||outs[0];
      console.log(`[ONNX] dinov2_vits14 OK  in=${dinoIn} out=${outs.join(',')}`);
    }catch(e){console.warn('[ONNX] dinov2 load failed:',e.message);dinoSession=null;}
  }else{
    console.warn('[ONNX] dinov2_vits14.onnx not found — DINOv2系ペルソナはランダムにフォールバック');
  }
  const segPath=path.join(__dirname,'data','seg_head.onnx');
  const segMetaPath=path.join(__dirname,'data','seg_head_meta.json');
  if(fs.existsSync(segPath)){
    try{
      segSession=await ort.InferenceSession.create(segPath,ORT_OPTS);
      segIn=segSession.inputNames[0]; segOut=segSession.outputNames[0];
      segMeta=fs.existsSync(segMetaPath)?JSON.parse(fs.readFileSync(segMetaPath,'utf8')):{open_class_id:2,n_classes:5};
      console.log(`[ONNX] seg_head OK  open_class_id=${segMeta.open_class_id}`);
    }catch(e){console.warn('[ONNX] seg_head load failed:',e.message);segSession=null;}
  }
  const bldgPath=path.join(__dirname,'data','building_classifier.onnx');
  if(fs.existsSync(bldgPath)){
    try{
      bldgSession=await ort.InferenceSession.create(bldgPath,ORT_OPTS);
      bldgIn=bldgSession.inputNames[0]; bldgOut=bldgSession.outputNames[0];
      console.log(`[ONNX] building_classifier OK`);
    }catch(e){console.warn('[ONNX] building_classifier load failed:',e.message);bldgSession=null;}
  }
}

async function loadOnnxSessions(){
  if(!ort)return;
  await loadSharedSessions();
  for(const p of PERSONA_DEFS){
    const op=path.join(__dirname,'data',`persona_${p.id}.onnx`);
    const mp=path.join(__dirname,'data',`persona_${p.id}_meta.json`);
    if(fs.existsSync(mp)){
      try{
        const m=JSON.parse(fs.readFileSync(mp,'utf8'));
        if(m.input_size)obsDims[p.id]=m.input_size;
        const iw=m.img_w||IMG_W, ih=m.img_h||IMG_H, ic=m.img_ch||IMG_CH;
        const isize=m.input_size||(iw*ih*ic);
        const div=v=>v/255;
        personaMeta[p.id]={
          inputSize: isize,
          goalDim: m.goal_dim||0,             // >0 なら goal条件付け (cls+z)。0=従来(clsのみ)
          auxDim: m.aux_dim||0,               // >0 なら補助観測 (compass/visited/social) 付き = 401モデル
          visitR: m.visit_radius||5,
          visitWin: m.visit_window_ticks||4000,
          socialRange: m.social_range||8,
          // 学習時の 1tick あたり旋回量。旧モデル(rot_deg=20)は 20°/tick のまま動かす
          rotPerTick: ((m.rot_per_tick_deg!=null?m.rot_per_tick_deg:(m.rot_deg||20))*Math.PI)/180,
          dino: isize!==iw*ih*ic,             // 生画像サイズと違う → DINOv2方式
          cfg:{
            w:iw, h:ih,
            fov:(m.fov_deg||60)*Math.PI/180,
            rayMax:m.ray_max||FP_RAY_MAX,
            rayStep:FP_RAY_STEP,
            cell:(m.cell_rgb||[[12,30,74],[176,180,172],[196,32,32],[35,104,40]]).map(c=>c.map(div)),
            sky:(m.sky_rgb||FP_SKY_RGB).map(div),
            floor:(m.floor_rgb||FP_FLOOR_RGB).map(div),
          },
        };
      }catch(e){console.warn(`[Meta] persona_${p.id}:`,e.message);}
    }
    if(fs.existsSync(op)){
      try{
        ortSessions[p.id]=await ort.InferenceSession.create(op,ORT_OPTS);
        const dim=obsDims[p.id]||(IMG_CH*IMG_H*IMG_W);
        const nm=ortSessions[p.id].inputNames[0];
        await ortSessions[p.id].run({[nm]:new ort.Tensor('float32',new Float32Array(dim),[1,dim])});
        const mode=personaMeta[p.id]&&personaMeta[p.id].dino?`DINOv2(${dim})`:`CNN(${dim})`;
        console.log(`[ONNX] persona_${p.id} OK  ${mode}`);
      }catch(e){console.warn(`[ONNX] persona_${p.id}:`,e.message);ortSessions[p.id]=null;}
    }
  }
}

// ─── 224 FPV レンダリング (学習時 render_fp_batch と一致) ─────────────────────
// CHW [0,1] の Float32Array を返す。逐次推論前提でサイズ別バッファを再利用する。
const _renderBufs={};
function getRenderBuf(w,h){
  const k=w+'x'+h;
  if(!_renderBufs[k]) _renderBufs[k]=new Float32Array(3*h*w);
  return _renderBufs[k];
}
// ── レイキャスタ用テクスチャ (学習と同じ 64×64・BLDG_TYPES順) ──
const RC_TW=64, RC_TH=64;
let rcTex=[], rcTexReady=false;
async function loadRaycastTextures(){
  if(!sharp){ console.warn('[Raycast] sharp 無し → テクスチャ観測不可'); return; }
  rcTex=new Array(BLDG_TYPES.length).fill(null);
  await Promise.all(BLDG_TYPES.map(async (bt,i)=>{
    const fp=path.join(__dirname, bt.textureFile);
    if(!fs.existsSync(fp)) return;
    try{
      const {data}=await sharp(fp).resize(RC_TW,RC_TH,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const f=new Float32Array(RC_TW*RC_TH*3);
      for(let k=0;k<f.length;k++) f[k]=data[k]/255;
      rcTex[i]=f;
    }catch(e){ console.warn(`[Raycast] tex ${bt.name}:`,e.message); }
  }));
  rcTexReady = rcTex.length>0 && rcTex.every(t=>t);
  console.log(`[Raycast] textures ${rcTex.filter(t=>t).length}/${BLDG_TYPES.length} loaded  ready=${rcTexReady}`);
}

// テクスチャ付きDDAレイキャスタ (学習 render_fp_batch と一致)。返り値 CHW [0,1]。
// 壁=建物セルのみ (BUILDING_TYPES でタイプ決定)。木/空地/道路は通過。
function renderFPImageCfg(map, agent, cfg){
  const W=cfg.w, H=cfg.h, HW=H*W;
  const sky=cfg.sky, fl=cfg.floor, FOV=cfg.fov;
  const buf=getRenderBuf(W,H);
  // 背景: 上半分=空 / 下半分=地面
  for(let yi=0;yi<H;yi++){
    const col=(yi<H*0.5)?sky:fl;
    for(let xi=0;xi<W;xi++){ const pi=yi*W+xi; buf[pi]=col[0]; buf[HW+pi]=col[1]; buf[2*HW+pi]=col[2]; }
  }
  if(!rcTexReady) return buf;   // テクスチャ未ロード → 背景のみ
  const dirX=Math.cos(agent.th), dirY=Math.sin(agent.th);
  const pl=Math.tan(FOV/2), planeX=-dirY*pl, planeY=dirX*pl;
  for(let x=0;x<W;x++){
    const cam=2*x/W-1;
    const rdx=dirX+planeX*cam, rdy=dirY+planeY*cam;
    let mapX=Math.floor(agent.x), mapY=Math.floor(agent.y);
    const ddx=rdx===0?1e30:Math.abs(1/rdx), ddy=rdy===0?1e30:Math.abs(1/rdy);
    let stepX,stepY,sdx,sdy;
    if(rdx<0){stepX=-1;sdx=(agent.x-mapX)*ddx;}else{stepX=1;sdx=(mapX+1-agent.x)*ddx;}
    if(rdy<0){stepY=-1;sdy=(agent.y-mapY)*ddy;}else{stepY=1;sdy=(mapY+1-agent.y)*ddy;}
    let hit=-1, side=0, g=0;
    while(g++<64){
      if(sdx<sdy){sdx+=ddx;mapX+=stepX;side=0;}else{sdy+=ddy;mapY+=stepY;side=1;}
      if(mapX<0||mapX>=GRID||mapY<0||mapY>=GRID) break;
      if(map[mapX][mapY]===BUILDING){ const ti=BUILDING_TYPES[mapX+'_'+mapY]; hit=(ti==null?0:ti); break; }
    }
    if(hit<0) continue;
    const tex=rcTex[hit % rcTex.length]; if(!tex) continue;
    const perp=Math.max(1e-4, side===0?(sdx-ddx):(sdy-ddy));
    const lineH=H/perp;
    const dsC=Math.min(H-1, Math.max(0, -lineH/2+H/2));
    const deC=Math.min(H-1, Math.max(0,  lineH/2+H/2));
    let wallX=side===0?agent.y+perp*rdy:agent.x+perp*rdx; wallX-=Math.floor(wallX);
    let texXi=Math.floor(wallX*RC_TW);
    if((side===0&&rdx>0)||(side===1&&rdy<0)) texXi=RC_TW-1-texXi;
    if(texXi<0)texXi=0; if(texXi>=RC_TW)texXi=RC_TW-1;
    const br=Math.min(1.0, Math.max(0.35, 1.0-perp/9));
    for(let yi=Math.ceil(dsC); yi<=deC; yi++){
      let texYi=Math.floor((yi-dsC)/lineH*RC_TH);
      if(texYi<0)texYi=0; if(texYi>=RC_TH)texYi=RC_TH-1;
      const ti=(texYi*RC_TW+texXi)*3, pi=yi*W+x;
      buf[pi]=tex[ti]*br; buf[HW+pi]=tex[ti+1]*br; buf[2*HW+pi]=tex[ti+2]*br;
    }
  }
  return buf;
}

function sampleLogits(lg){
  const mx=Math.max(...lg), ex=lg.map(v=>Math.exp(v-mx));
  const sm=ex.reduce((a,b)=>a+b,0), pr=ex.map(v=>v/sm);
  let rv=Math.random();
  for(let i=0;i<pr.length;i++){rv-=pr[i];if(rv<=0)return i;}
  return 0;
}

// 前進バイアス付きランダム (ONNX未ロード/失敗時のフォールバック)
function biasedRandom(map, agent){
  const fwd=(()=>{
    const dx=Math.cos(agent.th), dy=Math.sin(agent.th);
    for(let d=RAY_STEP;d<RAY_MAX;d+=RAY_STEP){
      const r=Math.floor(agent.x+dx*d), c=Math.floor(agent.y+dy*d);
      if(r<0||r>=GRID||c<0||c>=GRID) return ROAD;
      const ct=map[r][c]; if(ct===BUILDING||ct===TREE) return ct;
    }
    return ROAD;
  })();
  return (fwd===ROAD && Math.random()<0.55) ? 0 : (Math.random()<0.5?1:2);
}

// seg_head: DINOv2 patch tokens → セグメンテーション → 前方中央が open か
async function computeSegPassable(patchTensor){
  const so=await segSession.run({[segIn]:patchTensor});
  const t=so[segOut], dims=t.dims, data=t.data;        // (1, C, H, W)
  const C=dims[1], H=dims[2], W=dims[3];
  const cy=H>>1, cx=W>>1, base=cy*W+cx, plane=H*W;
  let best=-Infinity, cls=0;
  for(let k=0;k<C;k++){ const v=data[k*plane+base]; if(v>best){best=v;cls=k;} }
  return cls===(segMeta?segMeta.open_class_id:2);
}

// 推論結果キャッシュ (エージェントごと)
const actionCache = {};

// ─── 補助観測 aux(9) の組み立て ───────────────────────────────────────────────
// 学習側 PersonaVecEnvGoal.aux() と同一レイアウト・同一式にすること。
//   compass(3): 目的地の相対方位 sin/cos + 距離/GRID
//   visited(4): 前/左/右/後セクタ(半径 visitR)の訪問済みセル率 (範囲外=訪問済み扱い)
//   social(2) : 最寄りの他エージェントの相対方位 sin/cos × 近接度
function buildAux(agent, meta){
  const aux=new Float32Array(meta.auxDim);
  // compass(3)
  const dx=agent.gx-agent.x, dy=agent.gy-agent.y, d=Math.hypot(dx,dy);
  let b=Math.atan2(dy,dx)-agent.th; b=Math.atan2(Math.sin(b),Math.cos(b));
  aux[0]=Math.sin(b); aux[1]=Math.cos(b); aux[2]=Math.min(d/GRID,1);
  // visited(4): 学習側は 1 エピソード(4000tick)ぶんの記憶なので、visitWin より古い訪問は忘れる
  const R=meta.visitR, r0=Math.floor(agent.x), c0=Math.floor(agent.y);
  const cnt=[0,0,0,0], hit=[0,0,0,0];
  for(let dr=-R;dr<=R;dr++)for(let dc=-R;dc<=R;dc++){
    let a2=Math.atan2(dc,dr)-agent.th; a2=Math.atan2(Math.sin(a2),Math.cos(a2));
    const s = Math.abs(a2)<=Math.PI/4 ? 0
            : (a2<-Math.PI/4&&a2>-3*Math.PI/4 ? 1
            : (a2> Math.PI/4&&a2< 3*Math.PI/4 ? 2 : 3));
    cnt[s]++;
    const rr=r0+dr, cc=c0+dc;
    if(rr<0||cc<0||rr>=GRID||cc>=GRID){ hit[s]++; continue; }
    const t=agent.visMem&&agent.visMem.get(rr+','+cc);
    if(t!=null && (stepCount-t)<=meta.visitWin) hit[s]++;
  }
  for(let s=0;s<4;s++) aux[3+s]=hit[s]/Math.max(1,cnt[s]);
  // social(2): 最寄りの他エージェント
  let best=Infinity,ox=0,oy=0;
  for(const o of agents){
    if(o===agent||!o.active) continue;
    const dd=(o.x-agent.x)**2+(o.y-agent.y)**2;
    if(dd<best){best=dd;ox=o.x;oy=o.y;}
  }
  if(best<Infinity){
    const sd=Math.sqrt(best);
    let sb=Math.atan2(oy-agent.y,ox-agent.x)-agent.th; sb=Math.atan2(Math.sin(sb),Math.cos(sb));
    const prox=Math.max(0,1-sd/meta.socialRange);
    aux[7]=Math.sin(sb)*prox; aux[8]=Math.cos(sb)*prox;
  }
  return aux;
}

async function inferAction(map, agent){
  const id=agent.def.id;
  const sess=ortSessions[id];
  if(!sess) return biasedRandom(map, agent);
  const meta=personaMeta[id];
  try{
    if(meta && meta.dino){
      if(!dinoSession) return biasedRandom(map, agent);   // DINOv2未ロード
      // 224画像 → DINOv2 → CLS(384) + patch(256,384)
      const img=renderFPImageCfg(map, agent, meta.cfg);
      const di=await dinoSession.run({[dinoIn]:new ort.Tensor('float32', img, [1,3,meta.cfg.h,meta.cfg.w])});
      const cls=di[dinoClsOut];

      // ヘッド入力の組み立て:
      //   goal条件付け(meta.goalDim>0): [cls(384), z(goalDim)]
      //     z(=agent.goalZ) 未設定はゼロ → 「目標なし」= 従来挙動 (学習側もzゼロを混ぜてある)
      //   それ以外: CLSのみ(384) か CLS+建物分類(392)(legacy)
      let inData=cls.data, inDim=cls.data.length;
      if(meta.goalDim>0 || meta.auxDim>0){
        inDim=cls.data.length+(meta.goalDim||0)+(meta.auxDim||0);
        const cat=new Float32Array(inDim);
        cat.set(cls.data,0);
        const z=agent.goalZ;                          // Float32Array(goalDim) をセットすれば誘導できる
        if(z && meta.goalDim>0 && z.length===meta.goalDim) cat.set(z, cls.data.length);
        if(meta.auxDim>0) cat.set(buildAux(agent,meta), cls.data.length+(meta.goalDim||0));
        inData=cat;
      }else if(meta.inputSize>cls.data.length && bldgSession){
        const bo=await bldgSession.run({[bldgIn]:new ort.Tensor('float32', cls.data, [1, cls.data.length])});
        const bl=bo[bldgOut].data;
        const bmx=Math.max(...bl), bex=Array.from(bl).map(v=>Math.exp(v-bmx));
        const bsm=bex.reduce((a,b)=>a+b,0), probs=bex.map(v=>v/bsm);
        inDim=cls.data.length+probs.length;
        const cat=new Float32Array(inDim);
        cat.set(cls.data,0); cat.set(probs, cls.data.length);
        inData=cat;
      }
      const ho=await sess.run({[sess.inputNames[0]]:new ort.Tensor('float32', inData, [1, inDim])});
      const lg=Array.from(ho[sess.outputNames[0]].data);

      // seg による前方通行可否を更新 (使う場合のみ)
      if(segSession){
        try{ segPassCache[agent.aid]=await computeSegPassable(di[dinoPatchOut]); }
        catch(e){ segPassCache[agent.aid]=true; }
      }
      return sampleLogits(lg);
    }

    // 旧CNN方式 (生FPV画像をそのままヘッドへ)
    const obs=renderFPImage(map, agent);
    const dim=(meta&&meta.inputSize)||(IMG_CH*IMG_H*IMG_W);
    const out=await sess.run({[sess.inputNames[0]]:new ort.Tensor('float32', obs, [1, dim])});
    return sampleLogits(Array.from(out[sess.outputNames[0]].data));
  }catch(e){
    if(!inferErrLogged[id]){ console.warn(`[Infer] persona_${id} → フォールバック:`, e.message); inferErrLogged[id]=true; }
    return biasedRandom(map, agent);
  }
}

let stepCount = 0;
async function prefetchAllActions(map, agents){
  if(stepCount % INFER_EVERY !== 0) return;
  // 逐次実行: DINOv2/seg のピークメモリを抑えつつ描画バッファを再利用できる
  for(const a of agents){
    actionCache[a.aid] = await inferAction(map, a);
  }
}

function selectAction(agent){
  return actionCache[agent.aid] ?? Math.floor(Math.random()*3);
}

// ─── 建物タイプ定義 (マスター) ───────────────────────────────────────────────
//   footprint: 1=1x1マス, 2=2x2マス / height: 実寸=height*CELL の高さ倍率(8段階)
//   category : 行動/用途カテゴリ (eat/shop/work/home/health/learn/civic/tour/leisure/transit)
//   persona  : 主に引き寄せるペルソナID ('*'=全般, 'CA'=C優先+A 等)
//   texture  : ./textures/v2/<name>.png (側面比 = footprint*CELL*0.8 : height*CELL)
const BLDG_TYPES = [
  // ── 1x1 ──
  { label:'🍢 屋台',      name:'kiosk',       footprint:1, height:0.7, category:'eat',     persona:'CA', fallbackColor:0xd08030, textureFile:'./textures/v2/kiosk.png' },
  { label:'🏪 コンビニ',   name:'conbini',     footprint:1, height:0.9, category:'shop',    persona:'*',  fallbackColor:0x20a8e0, textureFile:'./textures/v2/conbini.png' },
  { label:'💊 薬局',      name:'pharmacy',    footprint:1, height:0.9, category:'shop',    persona:'B',  fallbackColor:0x30b070, textureFile:'./textures/v2/pharmacy.png' },
  { label:'☕ カフェ',    name:'cafe',        footprint:1, height:1.1, category:'eat',     persona:'C',  fallbackColor:0x8B5E3C, textureFile:'./textures/v2/cafe.png' },
  { label:'🥩 牛丼屋',    name:'gyudon',      footprint:1, height:1.1, category:'eat',     persona:'D',  fallbackColor:0xe8a020, textureFile:'./textures/v2/gyudon.png' },
  { label:'🍜 ラーメン屋', name:'ramen',       footprint:1, height:1.1, category:'eat',     persona:'*',  fallbackColor:0xe03030, textureFile:'./textures/v2/ramen.png' },
  { label:'🍱 弁当屋',    name:'bento',       footprint:1, height:1.1, category:'eat',     persona:'B',  fallbackColor:0x20a020, textureFile:'./textures/v2/bento.png' },
  { label:'🛍 商店',      name:'shop',        footprint:1, height:1.4, category:'shop',    persona:'E',  fallbackColor:0xc060a0, textureFile:'./textures/v2/shop.png' },
  { label:'🏠 住宅',      name:'house',       footprint:1, height:1.4, category:'home',    persona:'B',  fallbackColor:0xa06040, textureFile:'./textures/v2/house.png' },
  { label:'📮 郵便局',    name:'post',        footprint:1, height:1.4, category:'civic',   persona:'D',  fallbackColor:0xd04040, textureFile:'./textures/v2/post.png' },
  { label:'🏦 銀行',      name:'bank',        footprint:1, height:1.7, category:'civic',   persona:'D',  fallbackColor:0x808890, textureFile:'./textures/v2/bank.png' },
  { label:'🏬 マンション', name:'apartment',   footprint:1, height:2.1, category:'home',    persona:'B',  fallbackColor:0x9088a0, textureFile:'./textures/v2/apartment.png' },
  { label:'🏨 ホテル',    name:'hotel',       footprint:1, height:2.1, category:'tour',    persona:'E',  fallbackColor:0xc0a060, textureFile:'./textures/v2/hotel.png' },
  { label:'🏢 オフィス',  name:'office',      footprint:1, height:2.6, category:'work',    persona:'D',  fallbackColor:0x4060a0, textureFile:'./textures/v2/office.png' },
  { label:'🗼 タワー',    name:'tower',       footprint:1, height:3.3, category:'work',    persona:'AE', fallbackColor:0x6070b0, textureFile:'./textures/v2/tower.png' },
  // ── 2x2 ──
  { label:'🛒 スーパー',   name:'supermarket', footprint:2, height:1.1, category:'shop',    persona:'CB', fallbackColor:0x40a060, textureFile:'./textures/v2/supermarket.png' },
  { label:'⛩ 神社仏閣',   name:'temple',      footprint:2, height:1.1, category:'tour',    persona:'EA', fallbackColor:0xc04040, textureFile:'./textures/v2/temple.png' },
  { label:'🏫 学校',      name:'school',      footprint:2, height:1.4, category:'learn',   persona:'C',  fallbackColor:0xe0b040, textureFile:'./textures/v2/school.png' },
  { label:'🚉 駅',        name:'station',     footprint:2, height:1.4, category:'transit', persona:'CA', fallbackColor:0x7080a0, textureFile:'./textures/v2/station.png' },
  { label:'📚 図書館',    name:'library',     footprint:2, height:1.4, category:'learn',   persona:'BE', fallbackColor:0x8060a0, textureFile:'./textures/v2/library.png' },
  { label:'🏥 病院',      name:'hospital',    footprint:2, height:1.7, category:'health',  persona:'*',  fallbackColor:0xe0e0f0, textureFile:'./textures/v2/hospital.png' },
  { label:'🏛 市役所',    name:'cityhall',    footprint:2, height:1.7, category:'civic',   persona:'D',  fallbackColor:0xb0b4b8, textureFile:'./textures/v2/cityhall.png' },
  { label:'🖼 博物館',    name:'museum',      footprint:2, height:1.7, category:'tour',    persona:'E',  fallbackColor:0xa09060, textureFile:'./textures/v2/museum.png' },
  { label:'🏟 競技場',    name:'stadium',     footprint:2, height:2.1, category:'leisure', persona:'C',  fallbackColor:0x60a080, textureFile:'./textures/v2/stadium.png' },
  { label:'🏬 複合ビル',  name:'mall',        footprint:2, height:2.6, category:'shop',    persona:'CD', fallbackColor:0x5878a0, textureFile:'./textures/v2/mall.png' },
];
// footprint 別インデックス (型割当で使用)
const FP1_IDX = BLDG_TYPES.map((b,i)=>b.footprint===1?i:-1).filter(i=>i>=0);
const FP2_IDX = BLDG_TYPES.map((b,i)=>b.footprint===2?i:-1).filter(i=>i>=0);

let BUILDING_TYPES = {};
const texCache = {};

// 建物 material は「建物タイプ × 面」単位で共有する。
// 以前は建物ごとにテクスチャを clone していたため、同じタイプの建物が
// 大量にあるとテクスチャ/マテリアルが建物数ぶん重複し GPU メモリを圧迫していた。
// buildScene ごとに作り直し、disposeScene で破棄する。
let buildingMatCache = {};

async function loadTextureFile(filePath) {
  if (!filePath || texCache.hasOwnProperty(filePath)) return;
  const fullPath = path.join(__dirname, filePath);
  if (!sharp || !fs.existsSync(fullPath)) { texCache[filePath] = null; return; }
  try {
    // 元PNGの縦横比を保持したまま読み込む (箱の側面比に合わせて撮影した写真がそのまま貼れる)。
    // NPOT テクスチャは WebGL1(headless-gl) でも Linear+ClampToEdge+mipmap無しなら使用可。
    const { data, info } = await sharp(fullPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tex = new THREE.DataTexture(new Uint8Array(data), info.width, info.height, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
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
  const cacheKey = typeIdx % BLDG_TYPES.length;
  if (buildingMatCache[cacheKey]) return buildingMatCache[cacheKey];

  const bt = BLDG_TYPES[cacheKey];
  const sideTex = texCache[bt.textureFile];

  function makeMat(flipU = false, flipV = false, rotateDeg = 0) {
    if (!sideTex) return new THREE.MeshLambertMaterial({ color: bt.fallbackColor });
    const t = sideTex.clone();
    t.needsUpdate = true;
    if (rotateDeg !== 0) {
      t.rotation = rotateDeg * (Math.PI / 180);
      t.center.set(0.5, 0.5);
    }
    t.repeat.set(flipU ? -1 : 1, flipV ? -1 : 1);
    t.offset.set(flipU ?  1 : 0, flipV ?  1 : 0);
    return new THREE.MeshLambertMaterial({ map: t });
  }

  const mats = [
    makeMat(false, false,  90), // 0: +X 右側面
    makeMat(false, false,   -90), // 1: -X 左側面
    makeMat(true,  true,    0), // 2: +Y 正面 (BoxGeometry の +Y UV は 180°回転なので flipU+flipV で補正)
    makeMat(false, false,   0), // 3: -Y 背面 (無変換で正立)
    new THREE.MeshLambertMaterial({ color: 0xb0b4ac }), // 4: 屋上
    new THREE.MeshLambertMaterial({ color: 0x666666 }), // 5: 底面
  ];
  buildingMatCache[cacheKey] = mats;
  return mats;
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
  renderer.toneMapping=THREE.ACESFilmicToneMapping;   // dinov2seg と同じ淡いフィルミック調
  renderer.toneMappingExposure=0.6;
  return{renderer,glCtx};
}

// シーン全体の GPU リソースを解放する。
// newmap などで scene を作り直す際、古い scene を渡して呼ぶ。
// geometry / material / texture は GC 対象外なので明示的に dispose しないと
// headless-gl のメモリにリークし続け、最終的にサーバーが落ちる。
function disposeScene(S){
  if(!S) return;
  const geos = new Set(), mats = new Set();
  S.traverse(obj=>{
    if(obj.geometry) geos.add(obj.geometry);
    if(obj.material){
      if(Array.isArray(obj.material)) obj.material.forEach(m=>mats.add(m));
      else mats.add(obj.material);
    }
  });
  geos.forEach(g=>{ if(g!==TRAIL_GEO) g.dispose(); });
  mats.forEach(m=>{
    if(m.map) m.map.dispose();
    m.dispose();
  });
}

// ─── ジオメトリマージ用ヘルパー ───────────────────────────────────────────────
// three の CJS ビルドには BufferGeometryUtils が含まれない (examples/jsm は ESM)
// ため、非インデックス BufferGeometry の position(+uv) を連結する軽量版を自前で持つ。

// フラットな正方形タイル (道路/地面) を2三角形=6頂点ぶん配列に追加する。
function pushQuad(arr, size, tx, ty, z){
  const h=size/2, x0=tx-h, x1=tx+h, y0=ty-h, y1=ty+h;
  arr.push(
    x0,y0,z,  x1,y0,z,  x1,y1,z,   // +Z を向く CCW 巻き
    x0,y0,z,  x1,y1,z,  x0,y1,z
  );
}
function quadMesh(posArr, color){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  g.computeVertexNormals();   // Lambert ライティング用
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({color}));
}

// 複数の非インデックス geometry を1つに連結 (position 必須, uv は任意)。
function mergeGeos(geos, includeUV){
  let posLen=0, uvLen=0;
  for(const g of geos){
    posLen += g.attributes.position.array.length;
    if(includeUV) uvLen += g.attributes.uv.array.length;
  }
  const pos=new Float32Array(posLen);
  const uv = includeUV ? new Float32Array(uvLen) : null;
  let po=0, uo=0;
  for(const g of geos){
    const pa=g.attributes.position.array; pos.set(pa, po); po+=pa.length;
    if(includeUV){ const ua=g.attributes.uv.array; uv.set(ua, uo); uo+=ua.length; }
  }
  const m=new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if(includeUV) m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.computeVertexNormals();   // Lambert ライティング用
  return m;
}

// BoxGeometry の1面 (groups[i]) を切り出し、(tx,ty,tz) 平行移動した
// 非インデックス geometry を返す。box の UV をそのまま使うので、
// material 側のテクスチャ回転/反転 (getBuildingMaterial) の見た目を保持できる。
function extractFace(boxGeo, group, tx, ty, tz){
  const idx=boxGeo.index.array;
  const P=boxGeo.attributes.position.array;
  const U=boxGeo.attributes.uv.array;
  const n=group.count;
  const pos=new Float32Array(n*3), uv=new Float32Array(n*2);
  for(let k=0;k<n;k++){
    const vi=idx[group.start+k];
    pos[k*3]   = P[vi*3]   + tx;
    pos[k*3+1] = P[vi*3+1] + ty;
    pos[k*3+2] = P[vi*3+2] + tz;
    uv[k*2]    = U[vi*2];
    uv[k*2+1]  = U[vi*2+1];
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// キャラクター近傍のオブジェクトをフェードさせるための管理テーブル。
// key -> {mesh, cx, cy, faded}。mesh.material は建物ごとに clone した専用インスタンス
// (型/面で共有される元マテリアルの opacity を書き換えると他の建物にも波及してしまうため)。
let occluders = {};
function buildScene(map){
  buildingMatCache = {};
  BUILDING_TYPES = {};
  occluders = {};
  const rng=(()=>{let s=42;return()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff;};})();
  // 建物を「構造 (1x1 or 2x2)」として型割当。全4セルが BUILDING の正方形を貪欲に 2x2 として検出し、
  // 残りは 1x1。BUILDING_TYPES は全セルに構造の型を記録 (レイキャスト観測が参照)。
  const assigned=new Set(), structures=[];
  const isB=(r,c)=>r>=0&&r<GRID&&c>=0&&c<GRID&&map[r][c]===BUILDING;
  for(let r=0;r<GRID-1;r++)for(let c=0;c<GRID-1;c++){
    if(assigned.has(r+'_'+c))continue;
    if(isB(r,c)&&isB(r+1,c)&&isB(r,c+1)&&isB(r+1,c+1)
       && !assigned.has((r+1)+'_'+c) && !assigned.has(r+'_'+(c+1)) && !assigned.has((r+1)+'_'+(c+1))){
      const typeIdx=FP2_IDX[Math.floor(rng()*FP2_IDX.length)];
      for(let dr=0;dr<2;dr++)for(let dc=0;dc<2;dc++){
        const kk=(r+dr)+'_'+(c+dc); assigned.add(kk); BUILDING_TYPES[kk]=typeIdx;
      }
      structures.push({r,c,fp:2,typeIdx});
    }
  }
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(map[r][c]!==BUILDING || assigned.has(r+'_'+c))continue;
    const typeIdx=FP1_IDX[Math.floor(rng()*FP1_IDX.length)];
    assigned.add(r+'_'+c); BUILDING_TYPES[r+'_'+c]=typeIdx;
    structures.push({r,c,fp:1,typeIdx});
  }

  const S=new THREE.Scene();S.background=new THREE.Color(0xeaf2f7);
  S.add(new THREE.AmbientLight(0xbcd0e0,1.3));
  S.add(new THREE.HemisphereLight(0xeaf2f7,0xc8c0b0,1.1));
  const sun=new THREE.DirectionalLight(0xfff4e0,1.7);
  sun.position.set(W*.4,-W*.3,W*.8);S.add(sun);
  const gnd=new THREE.Mesh(new THREE.PlaneGeometry(W,W),new THREE.MeshLambertMaterial({color:0xe6e9e2}));
  gnd.position.set(W/2,W/2,0);S.add(gnd);

  // 建物/木はキャラクター近接フェードのため個別メッシュとして生成する
  // (ジオメトリ/一部マテリアルは種類ごとに共有し、ドローコール増加を抑える)。
  const roadPos=[], groundPos=[];
  const trunkGeo=new THREE.BoxGeometry(CELL*.15,CELL*.15,CELL*.4);
  const coneGeo =new THREE.BoxGeometry(CELL*.55,CELL*.55,CELL*.45);
  const trunkMat=new THREE.MeshLambertMaterial({color:0x8a5a32});
  const coneMat =new THREE.MeshLambertMaterial({color:0x4f9e44});
  const boxGeoByH={};                 // 高さ別 BoxGeometry (共有・indexed)

  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    const t=map[r][c],cx=c*CELL+CELL*.5,cy=r*CELL+CELL*.5;
    if(t===BUILDING){
      // 建物は下の structures ループで構造単位 (1x1/2x2) にまとめて描画
    }else if(t===TREE){
      const trunk=new THREE.Mesh(trunkGeo, trunkMat.clone());
      trunk.position.set(cx,cy,CELL*.2); S.add(trunk);
      const cone=new THREE.Mesh(coneGeo, coneMat.clone());
      cone.position.set(cx,cy,CELL*.58); S.add(cone);
      occluders[r+'_'+c+'_t1']={mesh:trunk,cx,cy,faded:false};
      occluders[r+'_'+c+'_t2']={mesh:cone,cx,cy,faded:false};
    }else if(t===ROAD){
      pushQuad(roadPos, CELL*.97, cx, cy, .008);
    }else{
      pushQuad(groundPos, CELL*.97, cx, cy, .005);
    }
  }

  // 建物を構造単位で描画 (1x1 / 2x2)。箱幅 = footprint*CELL の 80%、位置 = footprint 中心。
  for(const st of structures){
    const bt=BLDG_TYPES[st.typeIdx%BLDG_TYPES.length];
    const h=bt.height*CELL, span=st.fp, bw=span*CELL*0.8;
    const cx=st.c*CELL+span*CELL*0.5, cy=st.r*CELL+span*CELL*0.5;
    const gkey=span+'_'+h;
    if(!boxGeoByH[gkey]) boxGeoByH[gkey]=new THREE.BoxGeometry(bw,bw,h);
    const mats=getBuildingMaterial(st.typeIdx).map(m=>m.clone());
    const mesh=new THREE.Mesh(boxGeoByH[gkey], mats);
    mesh.position.set(cx,cy,h/2);
    S.add(mesh);
    occluders[st.r+'_'+st.c+'_b']={mesh,cx,cy,faded:false};
  }

  if(roadPos.length)   S.add(quadMesh(roadPos,   0xc4c8cc));
  if(groundPos.length) S.add(quadMesh(groundPos, 0x9ccc65));

  return S;
}

// ─── 近接フェード: キャラクターが建物/木のそばに来たら半透明にして視認性を保つ ──
const FADE_DIST = CELL*2.3, FADE_OPACITY = 0.4;
function updateOcclusionFade(){
  const near=new Set();
  for(const a of agents){
    const ax=a.y*CELL+CELL*.5, ay=a.x*CELL+CELL*.5;
    for(const key in occluders){
      const o=occluders[key];
      const dx=o.cx-ax, dy=o.cy-ay;
      if(dx*dx+dy*dy<FADE_DIST*FADE_DIST) near.add(key);
    }
  }
  for(const key in occluders){
    const o=occluders[key], should=near.has(key);
    if(should===o.faded) continue;
    o.faded=should;
    const mats=Array.isArray(o.mesh.material)?o.mesh.material:[o.mesh.material];
    mats.forEach(m=>{ m.transparent=should; m.opacity=should?FADE_OPACITY:1; m.depthWrite=!should; m.needsUpdate=true; });
  }
}

// 洒落た人型: 箱の積み木をやめ、丸み・テーパー・陰影のある立ち姿にする。
// Z が上方向、+Y が正面 (進行方向)。親オブジェクトは renderLoop で z=CELL*.26 に置かれ、
// 足元のローカル z は -CELL*.26 (地面)。MeshLambert にしてシーンのライトで陰影を付ける。
function createAgentMesh(S,color){
  const g=new THREE.Group();
  const base=-CELL*.26;                                   // 地面 (足元)
  const skin=0xf1c9a5, hair=0x4a3b2f, pants=0x2b303a;
  const bodyMat =new THREE.MeshLambertMaterial({color});
  const skinMat =new THREE.MeshLambertMaterial({color:skin});
  const hairMat =new THREE.MeshLambertMaterial({color:hair});
  const pantsMat=new THREE.MeshLambertMaterial({color:pants});
  const upZ=geo=>{geo.rotateX(Math.PI/2);return geo;};    // Y軸ジオメトリを Z 上向きに

  // 脚 (細身・左右)
  const legGeo=upZ(new THREE.CylinderGeometry(CELL*.032,CELL*.028,CELL*.22,8));
  for(const sx of [-1,1]){
    const leg=new THREE.Mesh(legGeo,pantsMat);
    leg.position.set(sx*CELL*.05,0,base+CELL*.11);
    g.add(leg);
  }

  // 胴体: 裾に向かってわずかに広がるテーパー (コート/ワンピース風シルエット)
  const torso=new THREE.Mesh(
    upZ(new THREE.CylinderGeometry(CELL*.095,CELL*.135,CELL*.30,16)),bodyMat);
  torso.position.set(0,0,base+CELL*.35);
  g.add(torso);

  // 丸い肩
  const shoulders=new THREE.Mesh(new THREE.SphereGeometry(CELL*.12,16,10),bodyMat);
  shoulders.scale.set(1.05,.8,.7);
  shoulders.position.set(0,0,base+CELL*.49);
  g.add(shoulders);

  // 首
  const neck=new THREE.Mesh(upZ(new THREE.CylinderGeometry(CELL*.04,CELL*.045,CELL*.06,8)),skinMat);
  neck.position.set(0,0,base+CELL*.55);
  g.add(neck);

  // 頭
  const head=new THREE.Mesh(new THREE.SphereGeometry(CELL*.115,18,14),skinMat);
  head.scale.set(1,.95,1.05);
  head.position.set(0,0,base+CELL*.66);
  g.add(head);

  // 髪 (頭頂のドーム)
  const hairGeo=upZ(new THREE.SphereGeometry(CELL*.122,18,12,0,Math.PI*2,0,Math.PI*.62));
  const hairMesh=new THREE.Mesh(hairGeo,hairMat);
  hairMesh.position.set(0,-CELL*.012,base+CELL*.665);
  g.add(hairMesh);

  // 正面マーカー (鼻) — 進行方向の判別用に控えめに残す。Cone は既定で +Y を向く。
  const nose=new THREE.Mesh(new THREE.ConeGeometry(CELL*.03,CELL*.06,8),skinMat);
  nose.position.set(0,CELL*.11,base+CELL*.655);
  g.add(nose);

  g.scale.setScalar(CHAR_SCALE);   // 街に対する大きさ調整 (足元は renderLoop 側で接地補正)
  S.add(g);return g;
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
// バッファは毎フレーム使い回す (renderLoop は encoding ガードで直列実行されるため安全)。
// 以前は毎フレーム 2 本の TypedArray を確保しており GC 圧の原因になっていた。
const _pxBuf=new Uint8ClampedArray(WIDTH*HEIGHT*4);
const _flBuf=new Uint8ClampedArray(WIDTH*HEIGHT*4);
function readPixels(glCtx){
  glCtx.readPixels(0,0,WIDTH,HEIGHT,glCtx.RGBA,glCtx.UNSIGNED_BYTE,_pxBuf);
  const row=WIDTH*4;
  for(let y=0;y<HEIGHT;y++)_flBuf.set(_pxBuf.subarray((HEIGHT-1-y)*row,(HEIGHT-y)*row),y*row);
  return _flBuf;
}

// ─── Simulation state ─────────────────────────────────────────────────────────
let MAP=makeMap(GRID,42), BUILDINGS=[];
function rebuildBuildings(map){BUILDINGS.length=0;for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)if(map[r][c]===BUILDING)BUILDINGS.push([r,c]);}
rebuildBuildings(MAP);
function randB(ex){for(let i=0;i<500;i++){const b=BUILDINGS[Math.floor(Math.random()*BUILDINGS.length)];if(!ex||Math.abs(b[0]-ex[0])>1||Math.abs(b[1]-ex[1])>1)return[...b];}return[...BUILDINGS[0]];}

let agents=[], agentMeshes=[], trailMats={};
let scene=null;   // ★ async init 完了まで null のまま
let paused=false, speedMul=1;

function disposeMesh(m){
  if(!m) return;
  m.traverse(o=>{
    if(o.geometry && o.geometry!==TRAIL_GEO) o.geometry.dispose();
    if(o.material){
      const arr=Array.isArray(o.material)?o.material:[o.material];
      arr.forEach(mat=>{ if(mat.map) mat.map.dispose(); mat.dispose(); });
    }
  });
}

function initAgents(S){
  // 既存エージェント/トレイルのメッシュを scene から外し GPU リソースを解放
  agentMeshes.forEach(m=>{S.remove(m);disposeMesh(m);});
  agents.forEach(a=>{a.trail.forEach(m=>S.remove(m));});  // trail geo/mat は共有なので dispose しない
  agents=[];agentMeshes=[];
  // NUM_AGENTS 体を生成。ペルソナ数を超える場合は一覧を巡回して割り当て、aid で個体を一意化する。
  for(let i=0;i<NUM_AGENTS;i++){
    const def=PERSONA_DEFS[i % PERSONA_DEFS.length];
    const b=randB(null),g=randB(b);
    agents.push({aid:`${def.id}#${i}`,x:b[0]+0.5,y:b[1]+0.5,th:Math.random()*Math.PI*2,gx:g[0]+0.5,gy:g[1]+0.5,trips:0,viols:0,steps:0,stall:0,def,trail:[],active:true,visited:new Set(),explored:0,visMem:new Map()});
    agentMeshes.push(createAgentMesh(S,def.color));
  }
  console.log(`[Sim] ${agents.length} agents initialized (personas=${PERSONA_DEFS.length})`);
}

// トレイルは毎ステップ生成されるため、geometry を全トレイルで共有する。
// 以前は毎回 new PlaneGeometry していて、50個超で remove するだけ (dispose なし)
// だったため GPU バッファがリークし続けていた。共有 geometry なら 1個で済み、
// disposeScene では破棄しない (TRAIL_GEO で除外)。
const TRAIL_GEO = new THREE.PlaneGeometry(CELL*.2*TRAIL_SCALE, CELL*.2*TRAIL_SCALE);

function addTrail(S,agent){
  const m=new THREE.Mesh(TRAIL_GEO,trailMats[agent.def.id]);
  m.position.set(agent.y*CELL+CELL*.5,agent.x*CELL+CELL*.5,.04);
  S.add(m);agent.trail.push(m);
  while(agent.trail.length>MAX_TRAIL){
    const old=agent.trail.shift();
    S.remove(old);   // geometry は共有・material はパーソナ共有なので dispose 不要
  }
}

async function stepAll(){
  if(paused || !scene) return;   // ★ scene null ガード
  stepCount++;
  await prefetchAllActions(MAP, agents);
  for(let i=0;i<agents.length;i++){
    const a=agents[i];
    const px=a.x,py=a.y;
    const action=selectAction(a);
    const meta=personaMeta[a.def.id];
    // 旋回量は学習時 meta の rot_per_tick_deg と一致させる (旧モデルは 20°/tick のまま)
    const rot=(meta&&meta.rotPerTick)||ROT;
    if(action===1)a.th-=rot;else if(action===2)a.th+=rot;
    a.th=(a.th+Math.PI*2)%(Math.PI*2);
    if(action===0){
      const nx=Math.max(0.01,Math.min(GRID-0.01,a.x+Math.cos(a.th)*MOVE));
      const ny=Math.max(0.01,Math.min(GRID-0.01,a.y+Math.sin(a.th)*MOVE));
      const r=Math.max(0,Math.min(GRID-1,Math.floor(nx)));
      const c=Math.max(0,Math.min(GRID-1,Math.floor(ny)));
      // 通行判定: 既定は実マップ配列(=前方セルが道路/建物か)。確実で、
      // 学習時(マップ配列で通行判定)とも一致するため「seg誤判定で止まる」を防ぐ。
      // SEG_GATE=1 かつ seg_head ありのときだけ seg 判定を使う。
      const useSeg = SEG_GATE && segSession && meta && meta.dino;
      const passable = useSeg ? (segPassCache[a.aid] ?? true) : PASSABLE.has(MAP[r][c]);
      if(passable){
        a.x=nx;a.y=ny;
        const key=`${r},${c}`;if(!a.visited.has(key)){a.visited.add(key);a.explored++;}
        addTrail(scene,a);
      }else a.viols++;
    }
    // 訪問メモリ (aux の visited セクタ率が参照。学習側と同じく毎tick現在セルを記録)
    if(a.visMem) a.visMem.set(Math.floor(a.x)+','+Math.floor(a.y), stepCount);
    a.steps++;
    const moved=(Math.abs(a.x-px)+Math.abs(a.y-py))>0.05;
    a.stall=moved?0:Math.min(a.stall+1,10);
    const dist=Math.sqrt((a.x-a.gx)**2+(a.y-a.gy)**2);
    if(dist<0.8){
      a.trips++;
      // goal(z) 設定中は同タイプの建物を次の目的地に選ぶ (学習時は z=目的地建物のタイプ)
      let g=null;
      if(a.goalZ){
        const ti=Array.from(a.goalZ).indexOf(1);
        const cands=BUILDINGS.filter(b=>(BUILDING_TYPES[b[0]+'_'+b[1]]||0)===ti
          &&(Math.abs(b[0]-Math.floor(a.x))>1||Math.abs(b[1]-Math.floor(a.y))>1));
        if(cands.length) g=cands[Math.floor(Math.random()*cands.length)];
      }
      if(!g) g=randB([Math.floor(a.x),Math.floor(a.y)]);
      a.gx=g[0]+0.5;a.gy=g[1]+0.5;
    }
  }
}

function handleCommand(msg){
  switch(msg.cmd){
    case 'pause': paused=!paused; break;
    case 'reset': if(scene) initAgents(scene); break;
    case 'speed': speedMul=[1,2,4][(([1,2,4].indexOf(speedMul)+1)%3)]; break;
    case 'newmap': {
      const oldScene=scene;
      MAP=makeMap(GRID,Math.floor(Math.random()*100000));
      rebuildBuildings(MAP);
      scene=buildScene(MAP);
      // 古いシーン (建物/道路/エージェント/トレイル) の GPU リソースを解放
      disposeScene(oldScene);
      PERSONA_DEFS.forEach(p=>{trailMats[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});});
      if(scene) initAgents(scene);
      break;
    }
  }
}

// プロセスを巻き込んで落とさないよう、未処理の例外/Promise reject はログだけ残す。
// (ループは個別に try/catch 済み。これは最後のセーフティネット)
process.on('unhandledRejection', (reason)=>{
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err)=>{
  console.error('[uncaughtException]', err && err.message ? err.message : err);
});

// ─── YouTube ライブ配信ワーカー ──────────────────────────────────────────────────
// renderLoop が生成する JPEG フレームを ffmpeg の stdin へ書き込み、RTMP 送出する。
// ffmpeg が死んでも指数バックオフで自動再起動する (demo の index.js と同方針)。
const YT = {
  child: null,
  shuttingDown: false,
  backoff: 2000,
  MAX_BACKOFF: 60000,
  ready: false,   // stdin が書き込み可能か
};

function buildYtArgs(){
  const gop = FPS * 2;   // 2秒に1キーフレーム (YouTube 推奨)
  return [
    // --- 映像入力: stdin から流れてくる JPEG 連番 (image2pipe) ---
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    // --- 音声入力: 無音 ---
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    // --- 映像出力 ---
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${YT_BITRATE_K}k`,
    '-maxrate', `${YT_BITRATE_K}k`,
    '-bufsize', `${YT_BITRATE_K * 2}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-r', String(FPS),
    // --- 音声出力 ---
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-f', 'flv', `${YT_RTMP_BASE}/${YT_STREAM_KEY}`,
  ];
}

function startYtStream(){
  if (!YT_ENABLED || YT.shuttingDown) return;

  const args = buildYtArgs();
  const started = Date.now();
  console.log(`[YT] ffmpeg 起動 (${WIDTH}x${HEIGHT} @ ${FPS}fps, ${YT_BITRATE_K}k, rtmp=${YT_RTMP_BASE}/****)`);

  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  YT.child = child;
  YT.ready = true;

  // stdin が詰まったり切れたりしても本体を巻き込まないよう握りつぶす
  child.stdin.on('error', (err)=>{
    YT.ready = false;
    console.error('[YT] stdin error:', err.message);
  });

  child.stderr.on('data', (d)=>{
    const s = d.toString();
    // 冗長な進捗行 (frame=... fps=...) は抑制し、警告/エラーだけ出す
    if (/error|Error|failed|Cannot|Invalid/.test(s)) process.stderr.write(`[YT/ffmpeg] ${s}`);
  });

  child.on('exit', (code, signal)=>{
    YT.child = null;
    YT.ready = false;
    if (YT.shuttingDown) { console.log('[YT] シャットダウン中のため再起動しません'); return; }
    const ranForSec = Math.round((Date.now() - started) / 1000);
    if (ranForSec > 60) YT.backoff = 2000;   // 60秒以上安定したらバックオフをリセット
    console.error(`[YT] ffmpeg 終了 (code=${code}, signal=${signal}, 稼働=${ranForSec}s)。${YT.backoff/1000}秒後に再起動`);
    setTimeout(startYtStream, YT.backoff);
    YT.backoff = Math.min(YT.backoff * 2, YT.MAX_BACKOFF);
  });

  child.on('error', (err)=>{
    YT.ready = false;
    console.error(`[YT] ffmpeg 起動失敗: ${err.message} (ffmpeg はインストール済みですか?)`);
  });
}

// renderLoop から呼ばれる: 1フレーム分の JPEG を ffmpeg stdin へ書き込む
function pushYtFrame(jpeg){
  if (!YT.ready || !YT.child) return;
  const stdin = YT.child.stdin;
  if (!stdin.writable) return;
  // backpressure 時は破棄せず書き込む (write は内部バッファに積む)。
  // 戻り値 false は無視 — ライブ配信は多少の遅延より欠落回避を優先。
  stdin.write(jpeg);
}

function shutdownYt(sig, done){
  if (!YT_ENABLED) { if (done) done(); return; }
  console.log(`[YT] ${sig} 受信。ffmpeg を停止します`);
  YT.shuttingDown = true;
  const child = YT.child;
  if (!child) { if (done) done(); return; }
  try { child.stdin.end(); } catch(_){}
  child.kill('SIGTERM');
  setTimeout(()=>{ try { child.kill('SIGKILL'); } catch(_){}; if (done) done(); }, 5000);
}

if (YT_ENABLED) {
  process.on('SIGTERM', ()=>shutdownYt('SIGTERM', ()=>process.exit(0)));
  process.on('SIGINT',  ()=>shutdownYt('SIGINT',  ()=>process.exit(0)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const {renderer, glCtx} = createRenderer();
const mainCam = new THREE.PerspectiveCamera(60, WIDTH/HEIGHT, 0.1, 1200);
mainCam.up.set(0,0,1);

// ── 追跡カメラ ────────────────────────────────────────────────
// camTargetIdx: 0=俯瞰(overview) / 1..agents.length=各エージェント。
// camFPV: true のあいだは、対象キャラの一人称視点(目線)ショットにする。
let camTargetIdx  = 0;
let camSwitchTimer = Date.now();
let camFPV = false;

// ターゲット切替が起きた瞬間に呼び、たまに一人称視点ショットにする。
// FPV はエージェント対象のときのみ (俯瞰では無効)。
function rollFPV() {
  camFPV = (camTargetIdx > 0) && (Math.random() < FPV_CHANCE);
}

// 次に映すターゲットを決める (モード別)。camTargetIdx を更新する。
function pickCameraTarget() {
  const now = Date.now();
  const timeUp = now - camSwitchTimer > CAM_INTERVAL_MS;

  if (CAM_MODE === 'B') {
    // 動いている(直近stepで移動した = stall が小さい)エージェントの index を集める
    const moving = [];
    for (let i = 0; i < agents.length; i++) if (agents[i].stall <= 1) moving.push(i);
    const cur = camTargetIdx > 0 ? agents[camTargetIdx - 1] : null;
    // 俯瞰中、または追跡中の対象がしばらく停止していて、他に動いてる人が居れば早めに切替
    const curStalled = !cur || cur.stall >= CAM_STALL_SWITCH;
    if (!(timeUp || (curStalled && moving.length > 0))) return;

    if (moving.length > 0) {
      // 動いている人を優先。できれば今と違う人を選ぶ (同じ人ばかり映さない)
      const others = moving.filter(i => i !== camTargetIdx - 1);
      const pool = others.length ? others : moving;
      camTargetIdx = pool[Math.floor(Math.random() * pool.length)] + 1;
    } else {
      // 誰も動いていない → ランダム (俯瞰 or いずれかのエージェント)
      camTargetIdx = Math.floor(Math.random() * (agents.length + 1));
    }
    camSwitchTimer = now;
    rollFPV();
  } else {
    // パターンA (既存): 俯瞰 → 各エージェントを順番に巡回
    if (timeUp) {
      camTargetIdx = (camTargetIdx + 1) % (agents.length + 1);
      camSwitchTimer = now;
      rollFPV();
    }
  }
}

function updateTrackingCamera(cam) {
  pickCameraTarget();
  if (camTargetIdx === 0 || agents.length === 0) {
    cam.up.set(0, 1, 0);
    cam.position.set(W*.5, W*.5, W*0.75);
    cam.lookAt(W*.5, W*.5 + 1, 0);
  } else {
    const a = agents[camTargetIdx - 1];
    if (!a) return;
    const tx = a.y * CELL + CELL * .5;   // world X (=足元)
    const ty = a.x * CELL + CELL * .5;   // world Y
    if (camFPV) {
      // ── 一人称視点 (キャラの目線) ──
      // world 進行方向 = (sin th, cos th) (stepAll の移動則より導出)。
      const dwx = Math.sin(a.th), dwy = Math.cos(a.th);
      // 目の高さ: キャラの頭の高さ (接地スケール準拠) を基準に、見やすさのため下限を設ける。
      const eyeZ = Math.max(CELL*0.5, CELL*0.66*CHAR_SCALE);
      const fwd  = CELL*0.3;   // 自分のメッシュに潜り込まないよう少し前へ出す
      cam.up.set(0, 0, 1);     // Z が上 → 水平線が水平に見える
      cam.position.set(tx + dwx*fwd, ty + dwy*fwd, eyeZ);
      cam.lookAt(tx + dwx*(fwd+4), ty + dwy*(fwd+4), eyeZ*0.85);   // 進行方向やや下向き
    } else {
      // ── 追跡カメラ (既存: 斜め後方から) ──
      cam.up.set(0, 1, 0);
      cam.position.set(tx, ty - CELL*5, CELL*7);
      cam.lookAt(tx, ty + CELL * 1.5, 0);
    }
  }
}

// ─── WebSocket クライアント管理 ────────────────────────────────────────────────
const clients = new Set();

// ─── HTTP + WebSocket サーバー ─────────────────────────────────────────────────
// 既存: / と /index.html は WebSocket版クライアント (client.html) を返す。
// 追加: /standalone.html で「ブラウザ単独版 (standalone/index.html)」を配信。これは
//       DINOv2/persona モデル + テクスチャをブラウザで直接ロードするため、data/ と
//       textures/ も静的配信する (これらは headless 側と共有)。URL を /standalone.html
//       に揃えてあるので、HTML 内の相対参照 ./data ./textures はルート直下に解決される。
//       WebSocket配信の仕組みには一切手を入れない。
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json',
  '.onnx':'application/octet-stream','.data':'application/octet-stream',
  '.png':'image/png','.jpg':'image/jpeg','.wasm':'application/wasm'};

function serveFile(res, filePath, cache){
  fs.stat(filePath,(err,st)=>{
    if(err||!st.isFile()){res.writeHead(404);res.end('Not Found');return;}
    const ext=path.extname(filePath).toLowerCase();
    const headers={'Content-Type':MIME[ext]||'application/octet-stream','Content-Length':st.size};
    if(cache) headers['Cache-Control']='public, max-age=86400';
    res.writeHead(200,headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const httpServer=http.createServer((req,res)=>{
  let urlPath=decodeURIComponent(req.url.split('?')[0]);

  // 既存の WebSocket版クライアント
  if(urlPath==='/'||urlPath==='/index.html'){
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(fs.readFileSync(path.join(__dirname,'client.html')));
    return;
  }

  // ── goal(z) 設定の口 (LLM/手動/外部制御用) ──
  //   設定: /goal?persona=A&type=7   (type=建物タイプ index / -1 or 省略でクリア)
  //   一覧: /goal                    (現在の各エージェントの goal を返す)
  //   goalDim 未対応(384)モデルでは保持のみで挙動には反映されない。
  if(urlPath==='/goal'){
    const q=new URL(req.url,'http://x').searchParams;
    res.setHeader('Content-Type','application/json');
    if(!q.has('persona')){
      res.writeHead(200);
      res.end(JSON.stringify({agents:agents.map(a=>({
        persona:a.def.id, name:a.def.name,
        goalDim:(personaMeta[a.def.id]&&personaMeta[a.def.id].goalDim)||0,
        goal:a.goalZ?Array.from(a.goalZ).indexOf(1):-1,
      }))}));
      return;
    }
    const pid=(q.get('persona')||'').toUpperCase();
    const type=parseInt(q.get('type'),10);
    const matched=agents.filter(ag=>ag.def.id===pid);   // 同ペルソナの個体すべてに適用
    if(!matched.length){ res.writeHead(404); res.end(JSON.stringify({ok:false,error:'persona not found',personas:[...new Set(agents.map(x=>x.def.id))]})); return; }
    const gd=(personaMeta[pid]&&personaMeta[pid].goalDim)||0;
    for(const a of matched){
      if(isNaN(type)||type<0){ a.goalZ=null; }
      else {
        const z=new Float32Array(gd||8); if(type<z.length) z[type]=1; a.goalZ=z;
        // 学習時は z=目的地建物のタイプ なので、目的地も同タイプの建物へ張り替える
        // (z と compass の指す先が食い違う入力は学習分布に無い)
        const cands=BUILDINGS.filter(b=>(BUILDING_TYPES[b[0]+'_'+b[1]]||0)===type);
        if(cands.length){ const g=cands[Math.floor(Math.random()*cands.length)]; a.gx=g[0]+0.5; a.gy=g[1]+0.5; }
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,persona:pid,type:(isNaN(type)?-1:type),goalDim:gd,
      note:gd>0?'applied':'保持のみ(このpersonaは384モデル。392に差し替えると有効)'}));
    return;
  }

  // ブラウザ単独版 (standalone/index.html)。/standalone.html という分かりやすい URL で配信。
  // URL がルート直下なので HTML 内の ./data ./textures は /data /textures に解決される。
  if(urlPath==='/standalone.html'||urlPath==='/standalone'||urlPath==='/standalone/'){
    return serveFile(res, path.join(__dirname,'standalone','index.html'));
  }
  // 旧 /client/ からの後方互換リダイレクト
  if(urlPath==='/client'||urlPath==='/client/'||urlPath==='/client/index.html'){
    res.writeHead(301,{'Location':'/standalone.html'}); res.end(); return;
  }

  // 静的資産は data/ textures/ のみ許可 (ディレクトリトラバーサル防止)
  if(urlPath.startsWith('/data/')||urlPath.startsWith('/textures/')){
    const safe=path.normalize(urlPath).replace(/^(\.\.[\/\\])+/,'');
    const fp=path.join(__dirname, safe);
    if(!fp.startsWith(__dirname)){res.writeHead(403);res.end();return;}
    return serveFile(res, fp, true);
  }

  res.writeHead(404);res.end();
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
  try{
    for(let s=0;s<speedMul;s++) await stepAll();
  }catch(e){
    console.error('[Sim]',e.message);
  }finally{
    simRunning = false;   // 例外が出てもフラグを必ず戻す (デッドロック防止)
  }
}

// render + JPEG 配信ループ
let frameCount=0, encoding=false;
async function renderLoop(){
  if(!scene) return;          // ★ scene null ガード (二重保険)
  if(encoding) return;
  encoding=true;

  try{
    // エージェントメッシュ更新
    const dt=1/FPS;
    agents.forEach((a,i)=>{
      const tx=a.y*CELL+CELL*.5,ty=a.x*CELL+CELL*.5,m=agentMeshes[i];
      if(!m) return;
      m.position.x+=(tx-m.position.x)*Math.min(1,dt*14);
      m.position.y+=(ty-m.position.y)*Math.min(1,dt*14);
      m.position.z=CELL*.26*CHAR_SCALE;   // 足元を地面に接地させる (足元ローカルz=-CELL*.26 をスケール分だけ持ち上げ)
      const tar=-a.th+Math.PI*.5;
      let dr=tar-m.rotation.z;
      while(dr>Math.PI)dr-=Math.PI*2;while(dr<-Math.PI)dr+=Math.PI*2;
      m.rotation.z+=dr*Math.min(1,dt*14);
    });

    updateTrackingCamera(mainCam);
    updateOcclusionFade();
    renderer.render(scene, mainCam);
    frameCount++;

    // WebSocket 視聴者も YouTube 配信も無ければエンコード自体を省略
    if(clients.size===0 && !YT.ready) return;

    const rgba=readPixels(glCtx);
    const jpeg=await rgbaToJpeg(rgba,WIDTH,HEIGHT);
    for(const ws of clients){
      if(ws.readyState===WebSocket.OPEN){
        ws.send(jpeg,(err)=>{if(err)clients.delete(ws);});
      }
    }
    pushYtFrame(jpeg);   // 同じフレームを YouTube へも横流し (YT_STREAM_KEY 設定時のみ)
    if(frameCount%(FPS*10)===0)console.log(`[Render] frame=${frameCount} clients=${clients.size} yt=${YT.ready?'on':'off'}`);
  }catch(e){
    console.error('[Render]',e.message);
  }finally{
    encoding=false;   // 例外時もフラグを必ず戻す (描画停止防止)
  }
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
  if (YT_ENABLED) startYtStream();
  else console.log('[YT] YT_STREAM_KEY 未設定 — YouTube 配信は無効 (WebSocket のみ)');
}

// ─── エントリポイント ──────────────────────────────────────────────────────────
(async()=>{
  console.log('[Init] loading ONNX sessions...');
  await loadOnnxSessions();

  console.log('[Init] preloading textures...');
  await preloadTextures();
  await loadRaycastTextures();   // エージェント観測(FPV)用の64×64テクスチャ

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