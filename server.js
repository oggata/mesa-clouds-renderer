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
  L: { h:320, fps:12, jpeg:80, ytk:1500  },   // 低負荷 (回線が不安定なとき)
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
// CPU負荷モード PERF=H|M|L → 推論頻度(INFER_EVERY)。下の MOVE/rot が INFER_EVERY に反比例して
// 自動スケールするので、どのモードでも「1意思決定あたりの変位」は学習時と同じ = 分布内に保たれる。
// 明示的な INFER_EVERY 環境変数があればそれを最優先。
const PERF_TIERS = { H:5, M:20, L:50 };   // H=高頻度(重い/滑らか) … L=低頻度(軽い)
const INFER_EVERY  = parseInt(process.env.INFER_EVERY) || PERF_TIERS[(process.env.PERF||'').toUpperCase()] || 20;
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
const CAM_STALL_SWITCH = parseInt(process.env.CAM_STALL_SWITCH) || 20;
// FPV_CHANCE: ターゲット切替時に、そのキャラの一人称視点(目線)ショットになる確率 (0..1, 既定0.25)。
//             A/B どちらでも「たまに挟む」形で入る。0 で無効。 例: FPV_CHANCE=0.3 node server.js
const FPV_CHANCE       = (()=>{ const v=parseFloat(process.env.FPV_CHANCE); return isNaN(v)?0.25:Math.max(0,Math.min(1,v)); })();
// CAM_DIST: 追跡カメラのプレイヤーまでの距離倍率 (1.0=従来)。小さいほど寄る。 例: CAM_DIST=0.5 node server.js
//const CAM_DIST         = (()=>{ const v=parseFloat(process.env.CAM_DIST); return isNaN(v)?1.0:Math.max(0.2,Math.min(3.0,v)); })();
const CAM_DIST = 0.6;
console.log(`[Config] ASPECT=${ASPECT} QUALITY=${QUALITY} → ${WIDTH}x${HEIGHT} @ ${FPS}fps (jpeg ${JPEG_Q}) | onnxThreads=${ONNX_THREADS} inferEvery=${INFER_EVERY} | camMode=${CAM_MODE} fpv=${FPV_CHANCE} camDist=${CAM_DIST}`);
const PORT   = process.env.PORT || 8080;
// 前進可否の判定方式: 既定はマップ配列(確実・学習と一致)。
// seg_head で学習し直した場合のみ SEG_GATE=1 で seg 判定に切替。
const SEG_GATE = process.env.SEG_GATE === '1';

// ─── YouTube ライブ配信 (任意) ─────────────────────────────────────────────────
// YT_STREAM_KEY がセットされている時だけ有効化。renderLoop の「生RGBAフレーム」を
// ffmpeg の stdin (rawvideo) へ直接流し込み、H.264/AAC(無音) で RTMP 送出する。
// JPEGを経由しないため sharp のエンコードが不要 = CPU減・画質向上。
// エンコーダは YT_VENC で変更可 (Mac: h264_videotoolbox でHWエンコード)。
const YT_STREAM_KEY = process.env.YT_STREAM_KEY || '';
const YT_RTMP_BASE  = process.env.YT_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2';
const YT_BITRATE_K  = parseInt(process.env.YT_VIDEO_BITRATE_K) || _preset.ytk;
const YT_ENABLED    = Boolean(YT_STREAM_KEY);

// ─── Sim constants ────────────────────────────────────────────────────────────
const GRID=30, CELL=2.0, TICK=parseInt(process.env.TICK)||150;
// 軌跡(trail)の最大点数。長いほど遠くまで残るが描画コスト(メッシュ数)が増える。
// 環境変数 MAX_TRAIL で可変。例: MAX_TRAIL=300 node server.js
const MAX_TRAIL=parseInt(process.env.MAX_TRAIL)||10;
// キャラクター / 軌跡マーカーの大きさ倍率 (1=従来)。街や建物に対して小さくしたい時に下げる。
// 環境変数 CHAR_SCALE / TRAIL_SCALE で可変。例: CHAR_SCALE=0.5 node server.js
const CHAR_SCALE =parseFloat(process.env.CHAR_SCALE) || 1/3;   // 人型の大きさ
const TRAIL_SCALE=parseFloat(process.env.TRAIL_SCALE)|| 1/3;   // 軌跡マーカーの大きさ
// INFER_EVERY / ONNX_THREADS は先頭の「CPU負荷」設定ブロックに移動
const OTHER=0, ROAD=1, BUILDING=2, TREE=3;
const PASSABLE = new Set([ROAD, BUILDING]);
// 学習時の「1意思決定あたり」の変位 (= move_dist × action_repeat / rot_decision_deg)。
// meta が無い/古いモデルのフォールバック。実際は persona ごとに meta から算出する(下記 personaMeta)。
const FWD_PER_DECISION_DEF = 0.25 * 10;              // = 2.5 セル/意思決定
const ROT_PER_DECISION_DEF = (40 * Math.PI) / 180;   // = 40°/意思決定
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

// meta(JSON) → personaMeta エントリ。個別モデル / 1モデル化 で共通に使う。
function buildPersonaMeta(m){
  const iw=m.img_w||IMG_W, ih=m.img_h||IMG_H, ic=m.img_ch||IMG_CH;
  const isize=m.input_size||(iw*ih*ic);
  const div=v=>v/255;
  return {
    inputSize: isize,
    goalDim: m.goal_dim||0,             // >0 なら goal条件付け (cls+z)。0=従来(clsのみ)
    goalClasses: m.goal_classes||[],    // z の index が意味する建物名の並び (モデル固有)
    bldgToZ: buildBldgToZ(m.goal_classes||[]),  // 正準index -> z index (名前で対応。-1=未対応)
    auxDim: m.aux_dim||0,               // >0 なら補助観測 (compass/visited/social/obstacle) 付き
    visitR: m.visit_radius||5,
    visitWin: m.visit_window_ticks||4000,
    socialRange: m.social_range||8,
    // 前方障害物センサ (aux_dim>=12 のとき有効)。学習側 OBST_* と一致させる。
    obstRayMax: m.obst_ray_max||3.0,
    obstStep:   m.obst_step||0.25,
    obstOff:    ((m.obst_off_deg!=null?m.obst_off_deg:40)*Math.PI)/180,
    // ── 1モデル化: 性格ベクトル (personaDim>0 なら入力の末尾に付く) ──
    personaDim: m.persona_dim||0,
    personaKeys: m.persona_keys||[],
    personaScale: m.persona_scale||[],
    personaVectors: m.persona_vectors||{},   // { 'A':[...], 'B':[...] }
    // 学習時の 1tick あたり旋回量。旧モデル(rot_deg=20)は 20°/tick のまま動かす
    rotPerTick: ((m.rot_per_tick_deg!=null?m.rot_per_tick_deg:(m.rot_deg||20))*Math.PI)/180,
    // 1意思決定あたりの変位 (INFER_EVERY で割って毎tick量にする)。train/deploy 一致の要。
    fwdPerDecision: (m.move_dist||0.25) * (m.action_repeat||10),
    rotPerDecision: (((m.rot_per_tick_deg!=null?m.rot_per_tick_deg:(m.rot_deg||20))*Math.PI)/180) * (m.action_repeat||10),
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
}

async function loadOnnxSessions(){
  if(!ort)return;
  await loadSharedSessions();
  // ── 1モデル化: data/persona_multi.* があれば全ペルソナで1セッションを共有 ──
  //   性格は入力末尾の persona ベクトルで切り替える (agent.personaVec で実行時変更可)。
  const mop=path.join(__dirname,'data','persona_multi.onnx');
  const mmp=path.join(__dirname,'data','persona_multi_meta.json');
  if(fs.existsSync(mop)&&fs.existsSync(mmp)){
    try{
      const m=JSON.parse(fs.readFileSync(mmp,'utf8'));
      const meta=buildPersonaMeta(m);
      const sess=await ort.InferenceSession.create(mop,ORT_OPTS);
      const dim=meta.inputSize, nm=sess.inputNames[0];
      await sess.run({[nm]:new ort.Tensor('float32',new Float32Array(dim),[1,dim])});
      for(const p of PERSONA_DEFS){ personaMeta[p.id]=meta; ortSessions[p.id]=sess; obsDims[p.id]=dim; }
      const have=Object.keys(meta.personaVectors);
      console.log(`[ONNX] persona_multi OK  DINOv2(${dim})  personaDim=${meta.personaDim}  性格=${have.join(',')||'(なし)'}`);
      const miss=PERSONA_DEFS.filter(p=>!meta.personaVectors[p.id]).map(p=>p.id);
      if(miss.length) console.warn(`[ONNX] persona_multi: 性格ベクトル未収録 ${miss.join(',')} → ゼロベクトルで動作`);
      return;
    }catch(e){ console.warn('[ONNX] persona_multi 読み込み失敗 → 個別モデルへフォールバック:',e.message); }
  }
  // ── 従来: ペルソナごとに個別モデル ──
  for(const p of PERSONA_DEFS){
    const op=path.join(__dirname,'data',`persona_${p.id}.onnx`);
    const mp=path.join(__dirname,'data',`persona_${p.id}_meta.json`);
    if(fs.existsSync(mp)){
      try{
        const m=JSON.parse(fs.readFileSync(mp,'utf8'));
        if(m.input_size)obsDims[p.id]=m.input_size;
        personaMeta[p.id]=buildPersonaMeta(m);
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
  // obstacle(3): front/left/right の通れないセル(木/空地/範囲外)までの距離 → clearance[0,1]
  //   学習側 PersonaVecEnvGoal.aux() と同一式。建物は通れるので壁にしない=移動を止める木/空地だけ拾う。
  if(meta.auxDim>=12){
    const oMax=meta.obstRayMax, oStep=meta.obstStep, offs=[0,-meta.obstOff,meta.obstOff];
    for(let k=0;k<3;k++){
      const ca=Math.cos(agent.th+offs[k]), sa=Math.sin(agent.th+offs[k]);
      let hitD=oMax;
      for(let od=oStep; od<=oMax+1e-6; od+=oStep){
        const px=agent.x+ca*od, py=agent.y+sa*od, r=Math.floor(px), c=Math.floor(py);
        if(px<0||px>=GRID||py<0||py>=GRID || !PASSABLE.has(MAP[r][c])){ hitD=od; break; }
      }
      aux[9+k]=Math.min(1, hitD/oMax);
    }
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
      if(meta.goalDim>0 || meta.auxDim>0 || meta.personaDim>0){
        inDim=cls.data.length+(meta.goalDim||0)+(meta.auxDim||0)+(meta.personaDim||0);
        const cat=new Float32Array(inDim);
        cat.set(cls.data,0);
        const z=agent.goalZ;                          // Float32Array(goalDim) をセットすれば誘導できる
        if(z && meta.goalDim>0 && z.length===meta.goalDim) cat.set(z, cls.data.length);
        if(meta.auxDim>0) cat.set(buildAux(agent,meta), cls.data.length+(meta.goalDim||0));
        // 1モデル化: 性格ベクトル。agent.personaVec があればそれを優先 (実行時の性格切替/ブレンド)。
        if(meta.personaDim>0){
          const pv=agent.personaVec||meta.personaVectors[agent.def.id];
          if(pv && pv.length===meta.personaDim)
            cat.set(pv, cls.data.length+(meta.goalDim||0)+(meta.auxDim||0));
        }
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
let inferWarmed = false;   // 初回の一括推論が済んだか (initAgents でリセット)

// 推論の位相分散 (配信のコマ落ち対策)。
//   旧: INFER_EVERY tick ごとに「全エージェントをまとめて」推論 → 50体ぶんの
//       FPVレイキャスト + DINOv2 が一気に走り、イベントループが数秒ブロックされる。
//       その間 renderLoop が1枚も描けず YouTube への供給が途切れていた。
//   新: エージェントに位相 (index % INFER_EVERY) を持たせ、自分の番のtickだけ推論する。
//       1エージェントあたりの推論間隔は INFER_EVERY tick のままなので、
//       「1意思決定=学習時と同じ変位」という前提は一切変わらない。実行タイミングが
//       ばらけるだけで、1tickあたりの負荷が 1/INFER_EVERY に平準化される。
async function prefetchAllActions(map, agents){
  // 初回だけ全員ぶん推論しておく (自分の位相が来るまでランダム行動になるのを防ぐ)
  if(!inferWarmed){
    inferWarmed = true;
    for(const a of agents) actionCache[a.aid] = await inferAction(map, a);
    return;
  }
  const phase = stepCount % INFER_EVERY;
  for(let i=0;i<agents.length;i++){
    if(i % INFER_EVERY !== phase) continue;   // 自分の番のtickだけ
    actionCache[agents[i].aid] = await inferAction(map, agents[i]);
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
  { label:'🍢 屋台',      name:'kiosk',       footprint:1, height:0.7, category:'eat',     persona:'CA', fallbackColor:0xd08030, textureFile:'./textures/v4/kiosk.jpg' },
  { label:'🏪 コンビニ',   name:'conbini',     footprint:1, height:0.9, category:'shop',    persona:'*',  fallbackColor:0x20a8e0, textureFile:'./textures/v4/conbini.jpg' },
  { label:'💊 薬局',      name:'pharmacy',    footprint:1, height:0.9, category:'shop',    persona:'B',  fallbackColor:0x30b070, textureFile:'./textures/v4/pharmacy.jpg' },
  { label:'☕ カフェ',    name:'cafe',        footprint:1, height:1.1, category:'eat',     persona:'C',  fallbackColor:0x8B5E3C, textureFile:'./textures/v4/cafe.jpg' },
  { label:'🥩 牛丼屋',    name:'gyudon',      footprint:1, height:1.1, category:'eat',     persona:'D',  fallbackColor:0xe8a020, textureFile:'./textures/v4/gyudon.jpg' },
  { label:'🍜 ラーメン屋', name:'ramen',       footprint:1, height:1.1, category:'eat',     persona:'*',  fallbackColor:0xe03030, textureFile:'./textures/v4/ramen.jpg' },
  { label:'🍱 弁当屋',    name:'bento',       footprint:1, height:1.1, category:'eat',     persona:'B',  fallbackColor:0x20a020, textureFile:'./textures/v4/bento.jpg' },
  { label:'🛍 商店',      name:'shop',        footprint:1, height:1.4, category:'shop',    persona:'E',  fallbackColor:0xc060a0, textureFile:'./textures/v4/shop.jpg' },
  { label:'🏠 住宅',      name:'house',       footprint:1, height:1.4, category:'home',    persona:'B',  fallbackColor:0xa06040, textureFile:'./textures/v4/house.jpg' },
  { label:'📮 郵便局',    name:'post',        footprint:1, height:1.4, category:'civic',   persona:'D',  fallbackColor:0xd04040, textureFile:'./textures/v4/post.jpg' },
  { label:'🏦 銀行',      name:'bank',        footprint:1, height:1.7, category:'civic',   persona:'D',  fallbackColor:0x808890, textureFile:'./textures/v4/bank.jpg' },
  { label:'🏬 マンション', name:'apartment',   footprint:1, height:2.1, category:'home',    persona:'B',  fallbackColor:0x9088a0, textureFile:'./textures/v4/apartment.jpg' },
  { label:'🏨 ホテル',    name:'hotel',       footprint:1, height:2.1, category:'tour',    persona:'E',  fallbackColor:0xc0a060, textureFile:'./textures/v4/hotel.jpg' },
  { label:'🏢 オフィス',  name:'office',      footprint:1, height:2.6, category:'work',    persona:'D',  fallbackColor:0x4060a0, textureFile:'./textures/v4/office.jpg' },
  { label:'🗼 タワー',    name:'tower',       footprint:1, height:3.3, category:'work',    persona:'AE', fallbackColor:0x6070b0, textureFile:'./textures/v4/tower.jpg' },
  // ── 2x2 ──
  { label:'🛒 スーパー',   name:'supermarket', footprint:2, height:1.1, category:'shop',    persona:'CB', fallbackColor:0x40a060, textureFile:'./textures/v4/supermarket.jpg' },
  { label:'⛩ 神社仏閣',   name:'temple',      footprint:2, height:1.1, category:'tour',    persona:'EA', fallbackColor:0xc04040, textureFile:'./textures/v4/temple.jpg' },
  { label:'🏫 学校',      name:'school',      footprint:2, height:1.4, category:'learn',   persona:'C',  fallbackColor:0xe0b040, textureFile:'./textures/v4/school.jpg' },
  { label:'🚉 駅',        name:'station',     footprint:2, height:1.4, category:'transit', persona:'CA', fallbackColor:0x7080a0, textureFile:'./textures/v4/station.jpg' },
  { label:'📚 図書館',    name:'library',     footprint:2, height:1.4, category:'learn',   persona:'BE', fallbackColor:0x8060a0, textureFile:'./textures/v4/library.jpg' },
  { label:'🏥 病院',      name:'hospital',    footprint:2, height:1.7, category:'health',  persona:'*',  fallbackColor:0xe0e0f0, textureFile:'./textures/v4/hospital.jpg' },
  { label:'🏛 市役所',    name:'cityhall',    footprint:2, height:1.7, category:'civic',   persona:'D',  fallbackColor:0xb0b4b8, textureFile:'./textures/v4/cityhall.jpg' },
  { label:'🖼 博物館',    name:'museum',      footprint:2, height:1.7, category:'tour',    persona:'E',  fallbackColor:0xa09060, textureFile:'./textures/v4/museum.jpg' },
  { label:'🏟 競技場',    name:'stadium',     footprint:2, height:2.1, category:'leisure', persona:'C',  fallbackColor:0x60a080, textureFile:'./textures/v4/stadium.jpg' },
  { label:'🏬 複合ビル',  name:'mall',        footprint:2, height:2.6, category:'shop',    persona:'CD', fallbackColor:0x5878a0, textureFile:'./textures/v4/mall.jpg' },
];
// footprint 別インデックス (型割当で使用)
const FP1_IDX = BLDG_TYPES.map((b,i)=>b.footprint===1?i:-1).filter(i=>i>=0);
const FP2_IDX = BLDG_TYPES.map((b,i)=>b.footprint===2?i:-1).filter(i=>i>=0);

// ─── 建物タイプの「正準体系」 ────────────────────────────────────────────────
// このサーバの正は BLDG_TYPES(25) の index。マップ/目的地/agent.goalType は全てこれ。
// 一方モデルの z の index は meta.goal_classes の並び (モデルごとに違う。旧モデルは8種)。
// 両者を index で兼用すると型がズレるため、必ず「名前」で変換する。
const BLDG_NAME_TO_IDX = Object.fromEntries(BLDG_TYPES.map((b,i)=>[b.name,i]));
// 正準index -> モデルのz index (そのモデルが知らないタイプは -1 = z条件付け不可)
function buildBldgToZ(goalClasses){
  const nameToZ = new Map((goalClasses||[]).map((n,i)=>[n,i]));
  return BLDG_TYPES.map(bt => nameToZ.has(bt.name) ? nameToZ.get(bt.name) : -1);
}

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
const FADE_DIST = CELL*2.3, FADE_OPACITY = 0.8;
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

// 道路網から PASSABLE(=ROAD|BUILDING) を辿って到達できるセルを塗る。
// 区画の奥で木/空地に四方を囲まれた建物は道路網から孤立する。そこに湧いたエージェントは
// 前進判定が常に false になり一生動けず、ナビも経路を引けない (unreachable)。
// → 湧き先/目的地の候補からは除外する。描画はされるので見た目は変わらない。
function computeReachable(map){
  const key=(r,c)=>r*GRID+c;
  const seen=new Uint8Array(GRID*GRID), q=[];
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
    if(map[r][c]===ROAD && !seen[key(r,c)]){ seen[key(r,c)]=1; q.push([r,c]); }
  const D=[[-1,0],[1,0],[0,-1],[0,1]];
  for(let head=0; head<q.length; head++){
    const [r,c]=q[head];
    for(const [dr,dc] of D){
      const nr=r+dr, nc=c+dc;
      if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
      const k=key(nr,nc);
      if(seen[k] || !PASSABLE.has(map[nr][nc])) continue;
      seen[k]=1; q.push([nr,nc]);
    }
  }
  return seen;
}
function rebuildBuildings(map){
  BUILDINGS.length=0;
  const reach=computeReachable(map);
  let isolated=0;
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(map[r][c]!==BUILDING) continue;
    if(reach[r*GRID+c]) BUILDINGS.push([r,c]); else isolated++;
  }
  if(isolated) console.log(`[Map] 孤立建物 ${isolated} 件を湧き先/目的地から除外 (道路網から到達不可)`);
}
rebuildBuildings(MAP);
function randB(ex){for(let i=0;i<500;i++){const b=BUILDINGS[Math.floor(Math.random()*BUILDINGS.length)];if(!ex||Math.abs(b[0]-ex[0])>1||Math.abs(b[1]-ex[1])>1)return[...b];}return[...BUILDINGS[0]];}

// ═══ 行動モード A/B ══════════════════════════════════════════════════════════
// ポリシー本体は A/B で共通。違いは「compass が指す (gx,gy) と z を誰が決めるか」だけ。
//   A: wander   … z=0 + ランダム建物へ。学習時 GOAL_NONE_PROB=0.4 の regime と同じ(分布内)。
//                 ペルソナの報酬で学んだ地の性格(探索/社交/寄り道)がそのまま出る。
//   B: navigate … A* の経路上の「先読み点」を (gx,gy) に送る。移動中は z=0(=Aと同じ regime)、
//                 最終区間だけ z=onehot(T) を立てて目的建物へ。どちらも学習分布内に収まる。
// 再学習は不要 (観測の形は一切変えていない)。
const WP_REACH  = 0.9;   // ウェイポイント通過とみなす距離
const LOOKAHEAD = 2;     // 経路上を何マス先取りして狙うか (pure pursuit の「ニンジン」)
const NAV_PICK_K = 3;    // 目的地は「近い方から k 軒」のランダム (最寄り固定だと往復しやすい)
const REPLAN_STALL = 8;  // これだけ足踏みしたら経路を引き直す

// 経路探索 (道路優先のダイクストラ)。
//   通れるのは PASSABLE(=ROAD|BUILDING) のみ。木/空地は実際の移動でも通れないので除外する。
//   道路を安く・建物を高くして「基本は道路を辿るが、必要なら建物を抜ける」ナビらしい経路にする。
//   ※ 道路のみに限定すると、区画の奥にある建物(道路に隣接していない)から出られず経路が引けない。
//     エージェントは建物上に湧くため、これだと大半がナビに入れなかった。
const COST_ROAD = 1, COST_BLDG = 6;
function planPath(sr, sc, gr, gc){
  const N=GRID*GRID, key=(r,c)=>r*GRID+c;
  const passable=(r,c)=> r>=0&&r<GRID&&c>=0&&c<GRID && PASSABLE.has(MAP[r][c]);
  if(!passable(sr,sc) || !passable(gr,gc)) return null;
  const dist=new Float64Array(N).fill(Infinity), prev=new Int32Array(N).fill(-1), done=new Uint8Array(N);
  const sk=key(sr,sc), gk=key(gr,gc);
  dist[sk]=0;
  const D=[[-1,0],[1,0],[0,-1],[0,1]];
  for(;;){
    let u=-1, best=Infinity;
    for(let i=0;i<N;i++) if(!done[i] && dist[i]<best){ best=dist[i]; u=i; }   // GRID=30 なので線形走査で十分
    if(u<0 || u===gk) break;
    done[u]=1;
    const r=(u/GRID)|0, c=u%GRID;
    for(const [dr,dc] of D){
      const nr=r+dr, nc=c+dc;
      if(!passable(nr,nc)) continue;
      const k=key(nr,nc); if(done[k]) continue;
      const nd=dist[u]+(MAP[nr][nc]===ROAD?COST_ROAD:COST_BLDG);
      if(nd<dist[k]){ dist[k]=nd; prev[k]=u; }
    }
  }
  if(dist[gk]===Infinity) return null;   // 到達不能 (木に囲まれた建物など)
  const path=[]; let cur=gk;
  while(cur>=0){ path.push([(cur/GRID)|0, cur%GRID]); cur=prev[cur]; }
  return path.reverse();
}

// そのタイプの建物を「近い方から k 軒」の中からランダムに選ぶ。現在地の隣は除外。
function pickBuildingOfType(a, T, k=NAV_PICK_K){
  const ar=Math.floor(a.x), ac=Math.floor(a.y);
  const cands=BUILDINGS.filter(b=>(BUILDING_TYPES[b[0]+'_'+b[1]]||0)===T
    && (Math.abs(b[0]-ar)>1 || Math.abs(b[1]-ac)>1));
  if(!cands.length) return null;
  cands.sort((p,q)=>((p[0]+0.5-a.x)**2+(p[1]+0.5-a.y)**2)-((q[0]+0.5-a.x)**2+(q[1]+0.5-a.y)**2));
  const pool=cands.slice(0, Math.min(k, cands.length));
  return pool[Math.floor(Math.random()*pool.length)];
}

// agent.goalType (正準index) からモデル用の z を名前対応で組み立てる。
// モデルが知らないタイプ (旧8モデルに school 等) は z=null = 誘導なし(目的地だけ有効)。
function applyGoalZ(a){
  const meta=personaMeta[a.def.id];
  if(a.goalType==null || !meta || !meta.goalDim){ a.goalZ=null; return false; }
  const zi=(meta.bldgToZ&&meta.bldgToZ[a.goalType]!=null)?meta.bldgToZ[a.goalType]:-1;
  if(zi<0){ a.goalZ=null; return false; }
  const z=new Float32Array(meta.goalDim); z[zi]=1; a.goalZ=z;
  return true;
}

// A: 自由行動へ。z=0 + ランダム建物を compass の的にする (現状の既定動作)。
function enterWander(a){
  a.mode='wander'; a.goalType=null; a.goalZ=null; a.path=null; a.pathIdx=0; a.rally=false;
  const g=randB([Math.floor(a.x),Math.floor(a.y)]);
  a.gx=g[0]+0.5; a.gy=g[1]+0.5;
}

// B: ナビ行動へ。T=正準の建物タイプindex。失敗したら A に落として理由を返す。
// 戻り値: 'ok' | 'no-building'(そのタイプが無い) | 'unreachable'(経路が引けない=周囲を木/空地に囲まれている等)
function enterNavigate(a, T){
  const dest=pickBuildingOfType(a, T);
  if(!dest){ enterWander(a); return 'no-building'; }
  const path=planPath(Math.floor(a.x), Math.floor(a.y), dest[0], dest[1]);
  if(!path || path.length<1){ enterWander(a); return 'unreachable'; }
  a.mode='navigate'; a.goalType=T; a.path=path; a.pathIdx=0; a.navDest=dest; a.rally=false;
  return 'ok';
}

// rally デバッグ用: 全員共通の1セル(dr,dc)へナビ。hold=true なら到着後その場に静止する。
function enterNavigateTo(a, dr, dc, T, hold){
  if(!(dr>=0&&dr<GRID&&dc>=0&&dc<GRID) || !PASSABLE.has(MAP[dr][dc])) return 'bad-cell';
  const path=planPath(Math.floor(a.x), Math.floor(a.y), dr, dc);
  if(!path || path.length<1){ enterWander(a); return 'unreachable'; }
  a.mode='navigate'; a.goalType=(T!=null&&T>=0?T:null); a.path=path; a.pathIdx=0;
  a.navDest=[dr,dc]; a.rally=!!hold;
  return 'ok';
}

// 経路上の先読み点を返し、(gx,gy) と z を更新する。最終区間でだけ z を立てる。
// 戻り値: 最終目的地に到着したか
function stepNavigate(a){
  if(!a.path || !a.path.length){ enterWander(a); return false; }
  // 通過済みウェイポイントを進める
  while(a.pathIdx < a.path.length-1){
    const [r,c]=a.path[a.pathIdx];
    if(Math.hypot(a.x-(r+0.5), a.y-(c+0.5)) < WP_REACH) a.pathIdx++; else break;
  }
  const ti=Math.min(a.pathIdx+LOOKAHEAD, a.path.length-1);
  const [tr,tc]=a.path[ti];
  a.gx=tr+0.5; a.gy=tc+0.5;
  // navigate 中は全区間で z(目的タイプ one-hot) を立てる。
  // 学習側の「z-set = 目標追従レジーム(探索報酬を止め接近報酬を優先)」に一致させ、
  // compass の先読み点を確実に追わせる。道中で z=0 に落とすと徘徊レジームに戻り目的地へ向かわない。
  applyGoalZ(a);
  // 到着判定は「最後のウェイポイント」でだけ行う (途中の点では trips を数えない)
  const last=a.path[a.path.length-1];
  const dlast=Math.hypot(a.x-(last[0]+0.5), a.y-(last[1]+0.5));
  if(a.pathIdx>=a.path.length-1 && dlast<0.8) return true;
  // 詰まったら引き直す (反応型ポリシーは経路から外れることがある)
  if(a.stall>=REPLAN_STALL){
    const p=planPath(Math.floor(a.x), Math.floor(a.y), last[0], last[1]);
    if(p&&p.length){ a.path=p; a.pathIdx=0; } else { enterWander(a); }
    a.stall=0;   // 連続再計画(毎tick BFS)を防ぐ
  }
  return false;
}

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
    agents.push({aid:`${def.id}#${i}`,x:b[0]+0.5,y:b[1]+0.5,th:Math.random()*Math.PI*2,gx:g[0]+0.5,gy:g[1]+0.5,trips:0,viols:0,steps:0,stall:0,def,trail:[],active:true,visited:new Set(),explored:0,visMem:new Map(),
      // 行動モード: 既定は A(自由)。/goal でタイプを指定すると B(ナビ) に入る。
      mode:'wander', goalType:null, goalZ:null, path:null, pathIdx:0, navDest:null, rally:false,
      personaVec:null});   // 1モデル化: null=既定の性格 / セットすると実行時に性格を上書き
    agentMeshes.push(createAgentMesh(S,def.color));
  }
  inferWarmed = false;   // エージェントが入れ替わったので推論キャッシュを温め直す
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
    if(a.mode==='hold') continue;   // rally 集合後は静止 (デバッグ用)
    const px=a.x,py=a.y;
    const action=selectAction(a);
    const meta=personaMeta[a.def.id];
    // 1意思決定あたりの変位を INFER_EVERY で割って毎tick量にする。これで INFER_EVERY をいくつにしても
    // 「1意思決定=学習時と同じ変位(前進2.5セル/旋回40°)」が保たれ、推論の狭間でのオーバーシュート/嵌りを防ぐ。
    const move=((meta&&meta.fwdPerDecision)||FWD_PER_DECISION_DEF)/INFER_EVERY;
    const rot =((meta&&meta.rotPerDecision)||ROT_PER_DECISION_DEF)/INFER_EVERY;
    if(action===1)a.th-=rot;else if(action===2)a.th+=rot;
    a.th=(a.th+Math.PI*2)%(Math.PI*2);
    if(action===0){
      const nx=Math.max(0.01,Math.min(GRID-0.01,a.x+Math.cos(a.th)*move));
      const ny=Math.max(0.01,Math.min(GRID-0.01,a.y+Math.sin(a.th)*move));
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
    // stall 判定の閾値も毎tick移動量に比例させる (INFER_EVERY 非依存に)。固定0.05だと
    // 高INFER_EVERY(=毎tick量が小)のとき移動中でも stall 誤検出してしまう。
    const moved=(Math.abs(a.x-px)+Math.abs(a.y-py))>move*0.5;
    a.stall=moved?0:Math.min(a.stall+1,10);
    // ── 行動モード別に compass の的 (gx,gy) と z を更新 ──
    if(a.mode==='navigate'){
      // B: 経路上の先読み点を追う。最終目的地に着いたら A(自由) に戻す。
      if(stepNavigate(a)){
        a.trips++;
        if(a.rally) a.mode='hold';   // rally: 集合点に到着したら静止 (解除は /rally?off=1)
        else enterWander(a);   // 用事が済んだら自由行動へ (滞在させたいならここで dwell を挟む)
      }
    }else{
      // A: z=0 のままランダム建物へ (学習時 GOAL_NONE regime と同じ)。到着で次を抽選。
      a.goalZ=null;
      if(Math.hypot(a.x-a.gx, a.y-a.gy)<0.8){
        a.trips++;
        const g=randB([Math.floor(a.x),Math.floor(a.y)]);
        a.gx=g[0]+0.5; a.gy=g[1]+0.5;
      }
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
// renderLoop が生成する生RGBAフレームを ffmpeg の stdin へ書き込み、RTMP 送出する。
// ffmpeg が死んでも指数バックオフで自動再起動する (demo の index.js と同方針)。
const YT = {
  child: null,
  shuttingDown: false,
  backoff: 2000,
  MAX_BACKOFF: 60000,
  ready: false,        // stdin が書き込み可能か
  backpressure: false, // ffmpeg が追いついていない間 true (このフレームは捨てる)
  // ── 固定レート送出 (YouTube 供給不足対策) ──
  //   rawvideo のパイプ入力にはタイムスタンプが無く、ffmpeg は「届いたフレーム=1/FPS秒」として
  //   PTS を振る。つまり実時間1秒に FPS 枚渡せないと、出力の時間軸が実時間より遅れていき
  //   YouTube から「受信している動画が少ない」と警告される。
  //   → renderLoop の出来に依存せず、ポンプが毎秒 FPS 枚を必ず書く (新しい絵が無ければ直前を複製)。
  //     複製フレームは x264 ではほぼゼロビットの P フレームになるので帯域はむしろ減る。
  lastFrame: null,     // 直近の描画結果 (Buffer。置き換えのみで in-place 変更はしない)
  hasNew: false,       // 前回のポンプ以降に新しい絵が来たか
  t0: 0, sent: 0,      // 送出の基準時刻と累計枚数 (実時間との同期に使う)
  statNew: 0, statDup: 0, statDrop: 0,
};

function buildYtArgs(){
  const gop = FPS * 2;   // 2秒に1キーフレーム (YouTube 推奨)
  // 映像エンコーダ。既定 libx264。Mac は YT_VENC=h264_videotoolbox でHWエンコード(CPUほぼ0)。
  const venc = process.env.YT_VENC || 'libx264';
  const vout = (venc === 'libx264')
    ? ['-c:v','libx264','-preset', process.env.YT_PRESET || 'veryfast','-tune','zerolatency','-pix_fmt','yuv420p']
    : ['-c:v', venc, '-pix_fmt','yuv420p','-realtime','1'];   // videotoolbox 等
  return [
    // --- 映像入力: stdin から流れてくる「生RGBAフレーム」(rawvideo) ---
    //     JPEGを挟まず生画素を直接渡す → sharpのJPEGエンコードが不要になりCPU減・画質向上。
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${WIDTH}x${HEIGHT}`,
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    // --- 音声入力: 無音 ---
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    // --- 映像出力 ---
    ...vout,
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
  console.log(`[YT] ffmpeg 起動 (${WIDTH}x${HEIGHT} @ ${FPS}fps, ${YT_BITRATE_K}k, venc=${process.env.YT_VENC||'libx264'}, rawvideo入力, rtmp=${YT_RTMP_BASE}/****)`);

  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  YT.child = child;
  YT.ready = true;
  YT.t0 = 0; YT.sent = 0; YT.hasNew = false;   // 送出タイムラインを再起動時にリセット

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

// renderLoop から呼ばれる: 最新フレームを保持するだけ (送出はポンプが固定レートで行う)。
// raw は毎フレーム使い回すバッファ(_flBuf)なので、必ずコピーして保持する (上書き対策)。
function setYtFrame(raw){
  if (!YT_ENABLED) return;
  YT.lastFrame = Buffer.from(raw);   // Uint8ClampedArray → コピー付き Buffer
  YT.hasNew = true;
}

// 固定レートポンプ: 実時間に対して「送るべき総枚数」との差分を埋める。
// イベントループが長時間ブロックされた後でも、複製フレームで追いついて実時間同期を保つ。
function ytPumpTick(){
  if (!YT_ENABLED || !YT.ready || !YT.child) return;
  const stdin = YT.child.stdin;
  if (!stdin || !stdin.writable) return;
  if (!YT.lastFrame) return;                 // まだ1枚も描けていない

  // ★ write() の戻り値を詰まり判定に使ってはいけない:
  //   Node のストリームは highWaterMark(既定16KB)超で false を返すため、1枚が数百KBある
  //   本用途では「毎回 false」になる。元実装はそれを backpressure とみなし drain まで
  //   フレームを捨てていたので、正常時でも大量にコマ落ちしていた。
  //   実際の滞留は writableLength(未送出バイト数) で見る。
  const FRAME_BYTES = WIDTH * HEIGHT * 4;
  YT.backpressure = stdin.writableLength > FRAME_BYTES * 3;   // 3枚ぶん以上溜まったら本当に詰まり
  if (YT.backpressure) { YT.statDrop++; return; }

  const now = Date.now();
  if (!YT.t0) { YT.t0 = now; YT.sent = 0; }
  const due = Math.floor((now - YT.t0) * FPS / 1000);   // 今までに送っておくべき総枚数
  let need = due - YT.sent;
  if (need <= 0) return;
  // 遅れが大きすぎるときは一気に埋めず、基準をずらして最大1秒ぶんに制限 (バースト暴走防止)
  if (need > FPS) { YT.sent = due - FPS; need = FPS; }

  for (let i = 0; i < need; i++){
    stdin.write(YT.lastFrame);               // 戻り値は見ない (上記の理由)
    if (YT.hasNew) { YT.statNew++; YT.hasNew = false; } else { YT.statDup++; }
    YT.sent++;
    if (stdin.writableLength > FRAME_BYTES * 3) break;   // 溜まってきたら今回はここまで
  }
}

// 診断ログ: 送出fps / 複製 / 詰まり。CPU不足か帯域不足かの切り分けに使う。
//   new が低く dup が高い  → 描画が追いついていない (CPU側)
//   drop が多い / bp=true  → ffmpeg・回線側が詰まっている (帯域側)
function ytStatsTick(){
  if (!YT_ENABLED || !YT.ready) return;
  const sec = 5;
  console.log(`[YT] 送出 ${((YT.statNew+YT.statDup)/sec).toFixed(1)}fps `
            + `(新規 ${(YT.statNew/sec).toFixed(1)} / 複製 ${(YT.statDup/sec).toFixed(1)}) `
            + `drop=${YT.statDrop} bp=${YT.backpressure} 目標=${FPS}fps`);
  YT.statNew = YT.statDup = YT.statDrop = 0;
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
      // ── 追跡カメラ (斜め後方から) ── CAM_DIST でプレイヤーまでの距離を調整 (小さいほど寄る)
      cam.up.set(0, 1, 0);
      cam.position.set(tx, ty - CELL*5*CAM_DIST, CELL*7*CAM_DIST);
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

  // ── 行動モード A/B の切り替え口 (LLM/手動/外部制御用) ──
  //   B(ナビ): /goal?persona=A&type=conbini  … 名前 or 正準index(0-24) で指定。A*経路で向かう
  //   A(自由): /goal?persona=A&type=-1       … type 省略/-1 で自由行動へ戻す
  //   一覧:   /goal                          … 各エージェントの mode/目的タイプを返す
  //   type は必ず BLDG_TYPES(25) の正準体系。モデルの z index へは名前で変換する(bldgToZ)。
  if(urlPath==='/goal'){
    const q=new URL(req.url,'http://x').searchParams;
    res.setHeader('Content-Type','application/json');
    if(!q.has('persona')){
      res.writeHead(200);
      res.end(JSON.stringify({types:BLDG_TYPES.map((b,i)=>({index:i,name:b.name})),
        agents:agents.map(a=>{
          const m=personaMeta[a.def.id]||{};
          return {aid:a.aid, persona:a.def.id, name:a.def.name, mode:a.mode,
            goalType:a.goalType, goalName:a.goalType!=null?BLDG_TYPES[a.goalType].name:null,
            zApplied:!!a.goalZ, pathLen:a.path?a.path.length:0, pathIdx:a.pathIdx,
            pos:[+a.x.toFixed(2), +a.y.toFixed(2)], goal:[+a.gx.toFixed(2), +a.gy.toFixed(2)],
            stall:a.stall, trips:a.trips, viols:a.viols, goalDim:m.goalDim||0};
        })}));
      return;
    }
    const pid=(q.get('persona')||'').toUpperCase();
    const raw=(q.get('type')||'').trim();
    // 名前(conbini)でも正準index(1)でも受ける。曖昧さを消すため名前推奨。
    let T = raw==='' ? -1 : (/^-?\d+$/.test(raw) ? parseInt(raw,10)
                            : (BLDG_NAME_TO_IDX[raw]!=null ? BLDG_NAME_TO_IDX[raw] : NaN));
    const matched=agents.filter(ag=>ag.def.id===pid);   // 同ペルソナの個体すべてに適用
    if(!matched.length){ res.writeHead(404); res.end(JSON.stringify({ok:false,error:'persona not found',personas:[...new Set(agents.map(x=>x.def.id))]})); return; }
    if(Number.isNaN(T) || T>=BLDG_TYPES.length){
      res.writeHead(400);
      res.end(JSON.stringify({ok:false,error:`unknown type: ${raw}`,types:BLDG_TYPES.map(b=>b.name)}));
      return;
    }
    const meta=personaMeta[pid]||{};
    const out=[];
    for(const a of matched){
      if(T<0){ enterWander(a); out.push({aid:a.aid,mode:a.mode,reason:'ok'}); }
      else {
        const r=enterNavigate(a, T);
        // z を張れるか (このモデルの goal_classes にそのタイプ名があるか) を先に判定して返す
        const zi=(meta.bldgToZ&&meta.bldgToZ[T]!=null)?meta.bldgToZ[T]:-1;
        out.push({aid:a.aid, mode:a.mode, reason:r, pathLen:a.path?a.path.length:0,
          dest:r==='ok'?a.navDest:null, zApplied:r==='ok'&&zi>=0});
      }
    }
    const zi=(meta.bldgToZ&&meta.bldgToZ[T]!=null)?meta.bldgToZ[T]:-1;
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,persona:pid,
      type:T, typeName:T>=0?BLDG_TYPES[T].name:null,
      goalDim:meta.goalDim||0, zIndex:zi, agents:out,
      note: T<0 ? 'A(自由行動)へ'
           : (zi>=0 ? 'B(ナビ)へ。経路追従＋最終区間で z 条件付け'
                    : `B(ナビ)へ。ただしこのモデルの goal_classes に "${BLDG_TYPES[T].name}" が無いため z 条件付けは無効(目的地誘導のみ)`)}));
    return;
  }

  // ── 1モデル化: 実行時のペルソナ切替 / ブレンド (persona_multi.onnx 使用時のみ) ──
  //   /persona                        … 性格ベクトルと各agentの状態を返す
  //   /persona?persona=A&as=C         … A のエージェントを C の性格で動かす
  //   /persona?persona=A&as=C&mix=0.3 … A:C = 0.7:0.3 でブレンド
  //   /persona?off=1                  … 既定の性格へ戻す (persona 省略で全員)
  if(urlPath==='/persona'){
    const q=new URL(req.url,'http://x').searchParams;
    res.setHeader('Content-Type','application/json');
    const meta=personaMeta[PERSONA_DEFS[0].id]||{};
    const P=meta.personaDim||0, PV=meta.personaVectors||{};
    if(!P){
      res.writeHead(400);
      res.end(JSON.stringify({ok:false,error:'このモデルは性格ベクトル非対応 (persona_multi.onnx が必要)'}));
      return;
    }
    if(!q.has('persona') && !q.has('as') && !q.has('off')){
      res.writeHead(200);
      res.end(JSON.stringify({ok:true, personaDim:P, keys:meta.personaKeys, available:Object.keys(PV),
        agents:agents.map(a=>({aid:a.aid, base:a.def.id, custom:!!a.personaVec}))}));
      return;
    }
    const pid=(q.get('persona')||'').toUpperCase();
    const targets=pid?agents.filter(a=>a.def.id===pid):agents;
    if(!targets.length){
      res.writeHead(404);
      res.end(JSON.stringify({ok:false,error:'persona not found',personas:[...new Set(agents.map(x=>x.def.id))]}));
      return;
    }
    if(q.has('off')){
      for(const a of targets) a.personaVec=null;
      res.writeHead(200); res.end(JSON.stringify({ok:true,reset:targets.length,persona:pid||'(all)'}));
      return;
    }
    const asId=(q.get('as')||'').toUpperCase();
    if(!PV[asId]){
      res.writeHead(400);
      res.end(JSON.stringify({ok:false,error:`unknown persona: ${asId}`,available:Object.keys(PV)}));
      return;
    }
    const mix=q.has('mix')?Math.max(0,Math.min(1,parseFloat(q.get('mix')))):1.0;
    for(const a of targets){
      const base=PV[a.def.id]||new Array(P).fill(0), tgt=PV[asId];
      a.personaVec=Float32Array.from({length:P},(_,i)=>base[i]*(1-mix)+tgt[i]*mix);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,applied:targets.length,persona:pid||'(all)',as:asId,mix,
      note:'/persona?off=1 で既定へ戻す'}));
    return;
  }

  // ── ルート指示デバッグ: 全ペルソナのエージェントを1か所に集合させる ──
  //   /rally?type=house   … その型の建物のうちマップ中心に最も近い1つへ全員集合(到着後は静止)
  //   /rally?r=12&c=5     … 指定セルへ全員集合 (建物 or 道路セル)
  //   /rally?off=1        … 解除 (全員 wander へ)。引数なしでも解除。
  if(urlPath==='/rally'){
    const q=new URL(req.url,'http://x').searchParams;
    res.setHeader('Content-Type','application/json');
    if(q.has('off') || (!q.has('type') && !q.has('r'))){
      for(const a of agents) enterWander(a);
      res.writeHead(200); res.end(JSON.stringify({ok:true,rally:'off',agents:agents.length}));
      return;
    }
    let dr, dc, T=null;
    if(q.has('r') && q.has('c')){
      dr=parseInt(q.get('r'),10); dc=parseInt(q.get('c'),10);
      if(!(dr>=0&&dr<GRID&&dc>=0&&dc<GRID) || !PASSABLE.has(MAP[dr][dc])){
        res.writeHead(400); res.end(JSON.stringify({ok:false,error:'r,c が範囲外 or 通行不可(木/空地)'})); return;
      }
      T = BUILDING_TYPES[dr+'_'+dc]; if(T==null) T=-1;
    } else {
      const raw=(q.get('type')||'').trim();
      T = /^-?\d+$/.test(raw)?parseInt(raw,10):(BLDG_NAME_TO_IDX[raw]!=null?BLDG_NAME_TO_IDX[raw]:NaN);
      if(Number.isNaN(T)||T<0||T>=BLDG_TYPES.length){
        res.writeHead(400); res.end(JSON.stringify({ok:false,error:`unknown type: ${raw}`,types:BLDG_TYPES.map(b=>b.name)})); return;
      }
      // その型の建物のうちマップ中心に最も近い1つ (全員がそこへ集合)
      const cen=GRID/2;
      const cands=BUILDINGS.filter(b=>(BUILDING_TYPES[b[0]+'_'+b[1]]||0)===T);
      if(!cands.length){ res.writeHead(404); res.end(JSON.stringify({ok:false,error:`到達可能な "${BLDG_TYPES[T].name}" がマップに無い`})); return; }
      cands.sort((p,z)=>((p[0]-cen)**2+(p[1]-cen)**2)-((z[0]-cen)**2+(z[1]-cen)**2));
      [dr,dc]=cands[0];
    }
    let ok=0; const fails={};
    for(const a of agents){ const r=enterNavigateTo(a, dr, dc, T, true); if(r==='ok')ok++; else fails[r]=(fails[r]||0)+1; }
    res.writeHead(200);
    res.end(JSON.stringify({ok:true, rally:{cell:[dr,dc], type:(T!=null&&T>=0?BLDG_TYPES[T].name:'(road)')},
      agents:agents.length, navigating:ok, failed:fails,
      note:'全員が集合点へナビ→到着後は静止。/rally?off=1 で解除'}));
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

    // WebSocket 視聴者も YouTube 配信も無ければ読み出し/エンコード自体を省略
    if(clients.size===0 && !YT.ready) return;

    const rgba=readPixels(glCtx);
    // YouTube: 生RGBAフレームを直接 ffmpeg へ (JPEGを経由しない)
    if(YT.ready) setYtFrame(rgba);
    // ブラウザ視聴者がいる時だけ JPEG 化して送る (視聴者0なら JPEGエンコードもしない)
    if(clients.size>0){
      const jpeg=await rgbaToJpeg(rgba,WIDTH,HEIGHT);
      for(const ws of clients){
        if(ws.readyState===WebSocket.OPEN){
          ws.send(jpeg,(err)=>{if(err)clients.delete(ws);});
        }
      }
    }
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
  if(YT_ENABLED){
    // 固定レートで ffmpeg へ送出 (renderLoop の出来に依存させない)
    setInterval(ytPumpTick,  Math.max(1, Math.round(1000/FPS)));
    setInterval(ytStatsTick, 5000);
  }
  console.log('[Loops] sim / render / stats loops started'
    + (YT_ENABLED ? ` / yt pump ${FPS}fps` : ''));
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