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
  L: { h:520, fps:15, jpeg:80, ytk:1500  },   // 低負荷 (回線が不安定なとき)
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
// 環境変数の数値読み。`parseInt(x)||既定` は 0 を指定できないので使わない。
const envNum=(k,d)=>{ const v=parseFloat(process.env[k]); return Number.isFinite(v)?v:d; };
const GRID=30, CELL=2.0, TICK=parseInt(process.env.TICK)||150;
// 軌跡(trail)の最大点数。長いほど遠くまで残るが描画コスト(メッシュ数)が増える。
// 環境変数 MAX_TRAIL で可変。例: MAX_TRAIL=300 node server.js
const MAX_TRAIL=parseInt(process.env.MAX_TRAIL)||10;
// キャラクター / 軌跡マーカーの大きさ倍率 (1=従来)。街や建物に対して小さくしたい時に下げる。
// 環境変数 CHAR_SCALE / TRAIL_SCALE で可変。例: CHAR_SCALE=0.5 node server.js
const CHAR_SCALE =parseFloat(process.env.CHAR_SCALE) || 1/3;   // 人型の大きさ
const TRAIL_SCALE=parseFloat(process.env.TRAIL_SCALE)|| 1/3;   // 軌跡マーカーの大きさ
// INFER_EVERY / ONNX_THREADS は先頭の「CPU負荷」設定ブロックに移動
// ─── 世界の物理 (world.js に一本化) ─────────────────────────────────────────
// マップ生成・通行判定・マップ補修・屋内状態は world.js が持つ。Python 側
// (mesa_env) と同じ実装で、js/map_conformance.cjs が一致を検証する。
// 変数名は MW (mesa world)。W は既存の const W=GRID*CELL と衝突する。
const MW = require('./world.js');
const { OTHER, ROAD, BUILDING, TREE } = MW;
// フィールド外。makeMap は 0〜3 しか返さないので、実行時にだけ現れる4つ目の種別。
//   街は GRID×GRID の一部 (CITY.size 四方) だけを使い、外側は VOID にして
//   「まだ世界が無い」状態にする。通行不可・描画なし・レイを止める。
//   makeMap 自体は触っていないので学習側との bit 一致は保たれる。
const VOID = 4;

// ALIGNED: 建物が通行不可 / 木が可視 / 空き地が通行可。
//   見えるもの   = {建物, 木}     = 通れない
//   見えないもの = {道路, 空き地} = 通れる
// が成立し、描画レイの距離がそのまま進行可能距離になる (実測誤差 0.017 セル)。
// LEGACY ではこれが反転していて相関 0.19 しかなく、画像から通行可否を導けない。
//
// 【既定を ALIGNED にした理由】街の進化 (docs/city-evolution-spec.md) は
// 「人が空き地を踏む → 踏み跡が道になる」が起点なので、空き地が通行不可な
// LEGACY では踏み跡が1つも付かず、機能が原理的に成立しない。
// なお MOVE_MODE='pursuit' 固定のあいだ ONNX 方策は移動に使われない
// (prefetchAllActions が即 return する) ため、「LEGACY で学習した重みが
// ALIGNED で壊れる」問題は現構成では起きない。policy モードへ戻すときは
// ALIGNED で学習し直した重みが要る (理想は meta.json から
// MW.worldFromMeta(meta) で自動判定する形)。
// WORLD_ALIGNED=0 で従来の LEGACY に戻せる。
const WORLD = process.env.WORLD_ALIGNED === '0' ? MW.LEGACY : MW.ALIGNED;
const PASSABLE = MW.passableSet(WORLD);
const OPTICS_OK = WORLD.solidBuildings && WORLD.visibleTrees && WORLD.walkableEmpty;
console.log(`[World] ${WORLD.solidBuildings?'ALIGNED':'LEGACY'} `
          + `passable={${[...PASSABLE].join(',')}} 光学=物理:${OPTICS_OK}`);
// FREE_MOVE: 物理的な通行判定を無効化 (木/空地も通れる)。詰まりが原理的に消えて活性が上がる。
//   A* 経路探索は道路優先のまま残すので「狙いは道路沿い・でも外れても固まらない」挙動になる。
//   既定ON。FREE_MOVE=0 で従来の通行判定に戻す。
const FREE_MOVE = process.env.FREE_MOVE === '1';   // 既定OFF (センサ修正で通行判定を活用)
// 診断/調整: 障害物クリアランスを強気側へスケール (過度に臆病で前進しない対策)。既定1.0。
const OBST_BOLD = parseFloat(process.env.OBST_BOLD)||1.0;
// 障害物レイに『目的地でない建物』を含めるか。既定ON = 学習側 aux() と同じ判定。
// OBST_BLDG=0 で「通れないセルだけを障害物にする」旧挙動に戻せる (A/B 検証用)。
const OBST_BLDG = process.env.OBST_BLDG !== '0';
// 学習時の「1意思決定あたり」の変位 (= move_dist × action_repeat / rot_decision_deg)。
// meta が無い/古いモデルのフォールバック。実際は persona ごとに meta から算出する(下記 personaMeta)。
const FWD_PER_DECISION_DEF = 0.25 * 10;              // = 2.5 セル/意思決定
const ROT_PER_DECISION_DEF = (40 * Math.PI) / 180;   // = 40°/意思決定
const RAY_MAX=6.0, RAY_STEP=0.15;
const W=GRID*CELL;
// いま使っているフィールドの範囲 [lo,hi] (常に中央寄せの正方形)。CITY.size が幅。
const fieldSize = () => (CITY && CITY.size) ? CITY.size : GRID;
const fieldLo   = () => Math.floor((GRID-fieldSize())/2);
const fieldHi   = () => fieldLo()+fieldSize()-1;
const inField   = (r,c) => { const lo=fieldLo(), hi=fieldHi(); return r>=lo&&r<=hi&&c>=lo&&c<=hi; };
// フィールド中心のワールド座標 (カメラの俯瞰位置)
const fieldCenterW = () => ((fieldLo()+fieldSize()/2)*CELL);
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
      // 起業性向 [0,1]。街に足りない業種を自分で開くかどうかの重み (0=絶対に起業しない)。
      enterprise: Number.isFinite(+p.enterprise) ? Math.max(0,Math.min(1,+p.enterprise)) : 0.3,
    };
  });
}
const PERSONA_DEFS = loadPersonaDefs();
// キャラクター数 (1-50)。未設定ならペルソナ数。ペルソナ数より多い場合は一覧を巡回して割り当てる。
const _numAgentsEnv = parseInt(process.env.CAM_INTERVAL_MS)  || 1000;
const NUM_AGENTS = Number.isFinite(_numAgentsEnv)
  ? Math.max(1, Math.min(_numAgentsEnv, _numAgentsEnv))
  : PERSONA_DEFS.length;
console.log(`[Persona] ${PERSONA_DEFS.length} personas loaded | NUM_AGENTS=${NUM_AGENTS}`);

// ─── マップ生成 ───────────────────────────────────────────────────────────────
// world.js に移動。旧実装は道路削除率が 0.30+rng*0.25 で、学習側 (0.25+rng*0.25)
// とズレていた — 本番のほうが道路が少なく街が詰まっていた。golden vector は
// マップを「データとして」受け取るのでこのズレを検出できず長く残っていた。
// 実装は world.js に一本化し、js/map_conformance.cjs で Python と照合する。
function makeMap(size, seed){
  const g = MW.makeMap(size, seed);
  // solidBuildings では建物に立てない。通行可能領域に接していない建物は
  // ゴールにも拠点にもできないので、隣の木を空き地に変えて入口を作る。
  // 抽選から外す (建物が減る) のではなく補修する: 実測 93.7% -> 100%、
  // 建物数はほぼ維持 (3814 -> 3774)。
  return WORLD.solidBuildings ? MW.ensureAllBuildingsReachable(g, WORLD) : g;
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
      const ct=map[r][c];if(ct!==ROAD){ht=Math.min(ct,3);hd=d;break;}   // VOID は木として扱う
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
    // 視界判定 (社交行動)。学習側 SOCIAL_FOV_DEG / SOCIAL_LOS_SAMPLES と一致させる。
    socialFovDeg: m.social_fov_deg||120,
    socialLosSamples: m.social_los_samples||16,
    // 前方障害物センサ (aux_dim>=12 のとき有効)。学習側 OBST_* と一致させる。
    obstRayMax: m.obst_ray_max||3.0,
    obstStep:   m.obst_step||0.25,
    obstOff:    ((m.obst_off_deg!=null?m.obst_off_deg:40)*Math.PI)/180,
    // 学習側 aux() の障害物レイは『目的地でない建物』もブロック扱いにする (NB の _isb & ~_isgoal)。
    // 既定を true にしているのは、obstacle センサを持つモデル(aux_dim>=12)は歴代すべて
    // この判定で学習されているため。ここを false にすると建物が clearance に現れず、
    // 「学習では壁だった物が本番では見えない」ズレになる。OBST_BLDG=0 で従来式に戻せる。
    obstBlocksBldg: OBST_BLDG && m.obst_blocks_buildings!==false,
    // compass の的の作り方。学習側 (NB aux()) が経路ウェイポイントを見ているモデルは
    // compass_mode='route_waypoint' を持つ。lookahead も meta 側を真とする。
    compassMode:      m.compass_mode||'goal',
    compassLookahead: m.compass_lookahead||null,
    // ── 1モデル化: 性格ベクトル (personaDim>0 なら入力の末尾に付く) ──
    personaDim: m.persona_dim||0,
    personaKeys: m.persona_keys||[],
    personaScale: m.persona_scale||[],
    personaVectors: m.persona_vectors||{},   // { 'A':[...], 'B':[...] }
    // 学習時の 1tick あたり旋回量。旧モデル(rot_deg=20)は 20°/tick のまま動かす
    rotPerTick: ((m.rot_per_tick_deg!=null?m.rot_per_tick_deg:(m.rot_deg||20))*Math.PI)/180,
    // 1意思決定あたりの変位 (INFER_EVERY で割って毎tick量にする)。train/deploy 一致の要。
    actionRepeat: m.action_repeat||null,   // 学習時の 1意思決定 = 何tick か (歩行速度の基準)
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
      // personas.json に居るのに学習に含まれていない id への手当て。
      // ここを放置すると inferAction がゼロベクトルを渡すが、それは学習中に一度も
      // 現れない入力 (全報酬係数=0 の性格) なので挙動が未定義になり、止まりやすい。
      // 暫定として学習済みベクトルを巡回で借りる。恒久対応は NB の persona_rewards.json に
      // その id を足して再学習すること。
      const miss=PERSONA_DEFS.filter(p=>!meta.personaVectors[p.id]).map(p=>p.id);
      if(miss.length){
        if(have.length){
          miss.forEach((id,i)=>{ meta.personaVectors[id]=meta.personaVectors[have[i%have.length]]; });
          console.warn(`[ONNX] persona_multi: 性格ベクトル未収録 ${miss.join(',')} → 学習済み(${have.join(',')})を巡回で代用。`
                     + ` 個別の性格を出すには persona_rewards.json に追加して再学習すること`);
        }else{
          console.warn(`[ONNX] persona_multi: persona_vectors が空 → 全ペルソナがゼロベクトル (挙動未定義)`);
        }
      }
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
// 木の描画タイプ = 建物 25 タイプの次。**goal の 25 クラスではない**ので
// BUILDING_TYPES には入れないこと (入れると到着判定と z の組み立てが壊れる)。
// BLDG_TYPES はこの下で定義されるため、関数にして評価を実行時まで遅らせる
// (const で即時評価すると TDZ で ReferenceError になる)。
const treeTexIndex = () => BLDG_TYPES.length;
let rcTex=[], rcTexReady=false;
async function loadRaycastTextures(){
  if(!sharp){ console.warn('[Raycast] sharp 無し → テクスチャ観測不可'); return; }
  // +1 は木。visibleTrees のときレイを止めるので専用テクスチャが要る。
  rcTex=new Array(BLDG_TYPES.length+1).fill(null);
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
  // 木: mesa_textures/tree.jpg があれば使い、無ければ緑の無地で代替する。
  // 「見える」ことが本質で、絵柄は二次的。
  const treeFp = path.join(__dirname, 'mesa_textures', 'tree.jpg');
  if(sharp && fs.existsSync(treeFp)){
    try{
      const {data}=await sharp(treeFp).resize(RC_TW,RC_TH,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const f=new Float32Array(RC_TW*RC_TH*3);
      for(let k=0;k<f.length;k++) f[k]=data[k]/255;
      rcTex[treeTexIndex()]=f;
    }catch(e){ console.warn('[Raycast] tree tex:', e.message); }
  }
  if(!rcTex[treeTexIndex()]){
    const f=new Float32Array(RC_TW*RC_TH*3);
    for(let k=0;k<f.length;k+=3){ f[k]=0.14; f[k+1]=0.41; f[k+2]=0.16; }
    rcTex[treeTexIndex()]=f;
    console.log('[Raycast] tree.jpg 無し → 無地で代替');
  }
  rcTexReady = rcTex.length>0 && rcTex.every(t=>t);
  console.log(`[Raycast] textures ${rcTex.filter(t=>t).length}/${rcTex.length} loaded  ready=${rcTexReady}`);
}

// テクスチャ付きDDAレイキャスタ (学習 render_fp_batch と一致)。返り値 CHW [0,1]。
// 壁=建物セルのみ (BUILDING_TYPES でタイプ決定)。木/空地/道路は通過。
// 他エージェントをビルボードとして壁の手前に重ねる。
// **social aux と同じ相手を描くこと。** 視覚と数値センサが別の相手を指すと、
// 方策が両者を結び付けられない。
function drawAgentSprites(buf, cfg, self, others, zbuf){
  const W=cfg.w, H=cfg.h, HW=H*W, half=Math.tan(cfg.fov/2);
  for(const o of others){
    if(o===self || o.indoors) continue;                  // 屋内の人は見えない
    const dx=o.x-self.x, dy=o.y-self.y;
    // 重なったエージェント (距離ほぼ 0) は描かない。そのまま射影すると
    // スプライトが画面全体を埋め、観測が壊れる。
    const dist=Math.hypot(dx,dy);
    if(dist<SPRITE_MIN_DIST || dist>SPRITE_MAX_DIST) continue;
    let b=Math.atan2(dy,dx)-self.th;
    b=Math.atan2(Math.sin(b),Math.cos(b));
    if(Math.abs(b)>cfg.fov/2*1.2) continue;
    const colc=W/2*(1+Math.tan(b)/half);
    const wpx=(AGENT_SPRITE_W/dist)*(W/2)/half;
    const bot=H/2+(H/dist)*EYE_HEIGHT, top=bot-(AGENT_SPRITE_H/dist)*H;
    const sh=Math.min(1,Math.max(0.35,1-dist/9));
    const x0=Math.max(0,Math.ceil(colc-wpx/2)), x1=Math.min(W-1,Math.floor(colc+wpx/2));
    const y0=Math.max(0,Math.ceil(top)),        y1=Math.min(H-1,Math.floor(bot));
    for(let x=x0;x<=x1;x++){
      if(zbuf && dist>=zbuf[x]) continue;                // 壁の裏なら描かない
      for(let y=y0;y<=y1;y++){
        const pi=y*W+x;
        buf[pi]=AGENT_SPRITE_RGB[0]*sh;
        buf[HW+pi]=AGENT_SPRITE_RGB[1]*sh;
        buf[2*HW+pi]=AGENT_SPRITE_RGB[2]*sh;
      }
    }
  }
}

function renderFPImageCfg(map, agent, cfg, others){
  const W=cfg.w, H=cfg.h, HW=H*W;
  const zbuf = FPV_AGENTS ? new Float32Array(W).fill(1e9) : null;
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
      const cell=map[mapX][mapY];
      if(cell===VOID){ hit=treeTexIndex(); break; }   // 世界の果て (木と同じ見た目で塞ぐ)
      if(cell===BUILDING){ const ti=BUILDING_TYPES[mapX+'_'+mapY]; hit=(ti==null?0:ti); break; }
      // 木もレイを止める。これが無いと「見えないのに通れない」が残り、
      // 画像から通行可否を導けない (木を出すと相関 0.68 -> 1.00)。
      if(WORLD.visibleTrees && cell===TREE){ hit=treeTexIndex(); break; }
    }
    const perp0=Math.max(1e-4, side===0?(sdx-ddx):(sdy-ddy));
    if(zbuf) zbuf[x]=(hit<0?1e9:perp0);         // スプライトの奥行き判定に使う
    if(hit<0) continue;
    const tex=rcTex[hit % rcTex.length]; if(!tex) continue;
    const perp=perp0;
    // 1 セル分の高さが画面上で何 px か。壁は床から高さ h まで立ち上がる。
    // h=1, eye=0.5 のとき従来の「中央に lineH」と一致する (後方互換)。
    const unit=H/perp;
    const bh = FPV_HEIGHTS ? (hit===treeTexIndex()?TREE_HEIGHT
                             :(BLDG_TYPES[hit]?BLDG_TYPES[hit].height:1.0)) : 1.0;
    const top=H/2-unit*(bh-EYE_HEIGHT), bot=H/2+unit*EYE_HEIGHT;
    const lineH=Math.max(1e-6, bot-top);
    const dsC=Math.min(H-1, Math.max(0, top));
    const deC=Math.min(H-1, Math.max(0, bot));
    let wallX=side===0?agent.y+perp*rdy:agent.x+perp*rdx; wallX-=Math.floor(wallX);
    let texXi=Math.floor(wallX*RC_TW);
    if((side===0&&rdx>0)||(side===1&&rdy<0)) texXi=RC_TW-1-texXi;
    if(texXi<0)texXi=0; if(texXi>=RC_TW)texXi=RC_TW-1;
    const br=Math.min(1.0, Math.max(0.35, 1.0-perp/9));
    for(let yi=Math.ceil(dsC); yi<=deC; yi++){
      // 縦は「切り取られる前の壁全体」に対して張る。画面外にはみ出した高い
      // 建物でも模様が縦に潰れないようにするため (top は負になりうる)。
      let texYi=Math.floor((yi-top)/lineH*RC_TH);
      if(texYi<0)texYi=0; if(texYi>=RC_TH)texYi=RC_TH-1;
      const ti=(texYi*RC_TW+texXi)*3, pi=yi*W+x;
      buf[pi]=tex[ti]*br; buf[HW+pi]=tex[ti+1]*br; buf[2*HW+pi]=tex[ti+2]*br;
    }
  }
  if(FPV_AGENTS && others) drawAgentSprites(buf, cfg, agent, others, zbuf);
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

// ─── 補助観測 aux(12) の組み立て ──────────────────────────────────────────────
// 学習側 PersonaVecEnvGoal.aux() と同一レイアウト・同一式にすること。
//   compass(3) : 目的地の相対方位 sin/cos + 距離/GRID
//   visited(4) : 前/左/右/後セクタ(半径 visitR)の訪問済みセル率 (範囲外=訪問済み扱い)
//   social(2)  : 最寄りの他エージェントの相対方位 sin/cos × 近接度
//   obstacle(3): 前/左/右の clearance (1=開けている, 0=直前が障害物)
// 2点間に建物が無いか (視界の遮蔽判定)。両端のセルは除外 = 建物は通行可なので人が建物上に立ち得る。
// 学習側 _los_clear() と同一式。
function losClear(x0,y0,x1,y1,samples){
  const S=samples||16;
  const r0=Math.floor(x0), c0=Math.floor(y0), r1=Math.floor(x1), c1=Math.floor(y1);
  for(let i=0;i<S;i++){
    const t=i/(S-1);
    const r=Math.floor(x0+(x1-x0)*t), c=Math.floor(y0+(y1-y0)*t);
    if(r<0||r>=GRID||c<0||c>=GRID) continue;
    if((r===r0&&c===c0)||(r===r1&&c===c1)) continue;   // 両端セルは遮蔽とみなさない
    if(MAP[r][c]===BUILDING) return false;
  }
  return true;
}

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
  // social(2): 「視界に入っている」最寄りの他エージェント。
  //   見える = (a) socialRange内 (b) 視界角内 (c) 建物に遮られていない。学習側 social_visible() と同一条件。
  //   誰も見えていなければ 0 のまま (= 人が視界に入って初めて反応する)。
  const sHalf=(meta.socialFovDeg*Math.PI/180)*0.5;
  let best=Infinity,ox=0,oy=0;
  for(const o of agents){
    if(o===agent||!o.active) continue;
    const dx=o.x-agent.x, dy=o.y-agent.y, dd=dx*dx+dy*dy;
    if(dd>=best) continue;                                  // より近い候補だけ調べる
    const d=Math.sqrt(dd);
    if(d>meta.socialRange) continue;                        // (a) 距離
    let b=Math.atan2(dy,dx)-agent.th; b=Math.atan2(Math.sin(b),Math.cos(b));
    if(Math.abs(b)>sHalf) continue;                         // (b) 視界角
    if(!losClear(agent.x,agent.y,o.x,o.y,meta.socialLosSamples)) continue;   // (c) 遮蔽
    best=dd; ox=o.x; oy=o.y;
  }
  if(best<Infinity){
    const sd=Math.sqrt(best);
    let sb=Math.atan2(oy-agent.y,ox-agent.x)-agent.th; sb=Math.atan2(Math.sin(sb),Math.cos(sb));
    const prox=Math.max(0,1-sd/meta.socialRange);
    aux[7]=Math.sin(sb)*prox; aux[8]=Math.cos(sb)*prox;
  }
  // obstacle(3): front/left/right の「入るべきでないセル」までの距離 → clearance[0,1]
  //   学習側 PersonaVecEnvGoal.aux() と同一式にすること。ここがズレると、SAFE_BC で
  //   「前が塞がったら曲がる」を教えた方策に学習時と違う clearance が入り、
  //   建物前で止まらない / 何もない所で回り続ける といった破綻になる。
  //   判定内容はモデルの meta が決める:
  //     obst_blocks_buildings=true (persona_multi 系) → 通行不可セル ∪ 目的地でない建物
  //     フラグ無し (旧モデル)                        → 通行不可セル(木/空地/範囲外)のみ
  if(meta.auxDim>=12){
    const oMax=meta.obstRayMax, oStep=meta.obstStep, offs=[0,-meta.obstOff,meta.obstOff];
    // 目的地セル: ここだけは建物でも「避ける対象」から外す (目的として入るのは許す)
    const gr=Math.floor(agent.gx), gc=Math.floor(agent.gy);
    // 自分が今いるセルは障害物にしない。レイは oStep(0.25) で自セルに当たるので、
    // これが無いと建物の上に立った瞬間 front≈0.08 になる (obstBlocksBldg 時)。
    const cr=Math.floor(agent.x), cc=Math.floor(agent.y);
    for(let k=0;k<3;k++){
      const ca=Math.cos(agent.th+offs[k]), sa=Math.sin(agent.th+offs[k]);
      let hitD=oMax;
      for(let od=oStep; od<=oMax+1e-6; od+=oStep){
        const px=agent.x+ca*od, py=agent.y+sa*od, r=Math.floor(px), c=Math.floor(py);
        if(px<0||px>=GRID||py<0||py>=GRID){ hitD=od; break; }
        if(r===cr&&c===cc) continue;
        const cell=MAP[r][c];
        const bldgBlock = meta.obstBlocksBldg && cell===BUILDING && !(r===gr&&c===gc);
        if(!PASSABLE.has(cell) || bldgBlock){ hitD=od; break; }
      }
      aux[9+k]=Math.min(1, hitD/oMax*OBST_BOLD);
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
      // 他エージェントを見せる場合は全体を渡す (自分と屋内は drawAgentSprites 側で除外)
      const img=renderFPImageCfg(map, agent, meta.cfg, FPV_AGENTS?agents:null);
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
  if(MOVE_MODE==='pursuit' || !agents.some(hasUsablePolicy)) return;
  // 決定論追従、または対応するONNX/DINOv2が無い場合は推論不要。
  // 後者は stepAll() 側で pursuit に安全フォールバックする。
  // 初回だけ全員ぶん推論しておく (自分の位相が来るまでランダム行動になるのを防ぐ)
  if(!inferWarmed){
    inferWarmed = true;
    for(const a of agents){
      if(hasUsablePolicy(a)) actionCache[a.aid] = await inferAction(map, a);
    }
    return;
  }
  const phase = stepCount % INFER_EVERY;
  for(let i=0;i<agents.length;i++){
    if(i % INFER_EVERY !== phase) continue;   // 自分の番のtickだけ
    if(hasUsablePolicy(agents[i])) actionCache[agents[i].aid] = await inferAction(map, agents[i]);
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
// 建物の型割当。**街の創世時に一度だけ**走る (以降の正は CITY.structs)。
//   以前はこの処理が buildScene の中にあり、シーンを作り直すたびに全建物の用途が
//   振り直されていた。それでは「あの店が潰れた」という履歴が一切積み上がらない。
//   1軒の追加/閉店でシーン全体を作り直さないための土台でもある。
function planStructures(map){
  const rng=(()=>{let s=CITY_SEED;return()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff;};})();
  // 全4セルが BUILDING の正方形を貪欲に 2x2 として検出し、残りは 1x1。
  const assigned=new Set(), structs=[];
  const isB=(r,c)=>r>=0&&r<GRID&&c>=0&&c<GRID&&map[r][c]===BUILDING;
  for(let r=0;r<GRID-1;r++)for(let c=0;c<GRID-1;c++){
    if(assigned.has(r+'_'+c))continue;
    if(isB(r,c)&&isB(r+1,c)&&isB(r,c+1)&&isB(r+1,c+1)
       && !assigned.has((r+1)+'_'+c) && !assigned.has(r+'_'+(c+1)) && !assigned.has((r+1)+'_'+(c+1))){
      const typeIdx=FP2_IDX[Math.floor(rng()*FP2_IDX.length)];
      for(let dr=0;dr<2;dr++)for(let dc=0;dc<2;dc++) assigned.add((r+dr)+'_'+(c+dc));
      structs.push(newStruct(r,c,2,typeIdx,0));
    }
  }
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(map[r][c]!==BUILDING || assigned.has(r+'_'+c))continue;
    const typeIdx=FP1_IDX[Math.floor(rng()*FP1_IDX.length)];
    assigned.add(r+'_'+c);
    structs.push(newStruct(r,c,1,typeIdx,0));
  }
  return structs;
}

function buildScene(map){
  buildingMatCache = {};
  occluders = {};
  boxGeoByH = {};
  syncCity();          // CITY.structs -> BUILDING_TYPES / cellStruct を作り直す

  const S=new THREE.Scene();S.background=new THREE.Color(0xeaf2f7);
  const amb=new THREE.AmbientLight(0xbcd0e0,1.3);   S.add(amb);
  const hemi=new THREE.HemisphereLight(0xeaf2f7,0xc8c0b0,1.1); S.add(hemi);
  const sun=new THREE.DirectionalLight(0xfff4e0,1.7);
  sun.position.set(W*.4,-W*.3,W*.8);S.add(sun);
  // 昼夜表現のため参照を保持 (updateDayNight が毎フレーム色/強度を更新)
  S.userData.lights={amb,hemi,sun};
  // 建物/木はキャラクター近接フェードのため個別メッシュとして生成する
  // (ジオメトリ/一部マテリアルは種類ごとに共有し、ドローコール増加を抑える)。
  // 木のジオメトリ/マテリアルはシーンに持たせる。フィールドが広がったときに
  // addTreeMesh で後から生やすため (モジュール共有だと disposeScene で壊れる)。
  S.userData.tree={
    trunkGeo:new THREE.BoxGeometry(CELL*.15,CELL*.15,CELL*.4),
    coneGeo :new THREE.BoxGeometry(CELL*.55,CELL*.55,CELL*.45),
    trunkMat:new THREE.MeshLambertMaterial({color:0x8a5a32}),
    coneMat :new THREE.MeshLambertMaterial({color:0x4f9e44}),
  };
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
    if(map[r][c]===TREE) addTreeMesh(S, r, c);

  // 建物は構造単位 (1x1 / 2x2) の個別メッシュ。開業/閉店/取り壊しで1軒だけ
  // 差し替えられるよう addStructMesh に集約する。
  for(const st of CITY.structs) addStructMesh(S, st);
  rebuildGround(S);   // 道路 / 草地 / 摩耗 の板 (踏み跡で変わるので別関数)

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
// ── 昼夜: 時刻に応じて空の色・光の色/強さを変える ────────────────────────────
//   d=1(正午) 昼白色で明るい / d=0(深夜) 青く暗い。夕方は朝焼け/夕焼け色を混ぜる。
const _cDay=new THREE.Color(0xeaf2f7), _cNight=new THREE.Color(0x0b1a33);
const _sDay=new THREE.Color(0xfff4e0), _sDusk =new THREE.Color(0xff9a5c), _sNight=new THREE.Color(0x2a4a8a);
const _gDay=new THREE.Color(0xbcd0e0), _gNight=new THREE.Color(0x24304a);
const _cWeather=new THREE.Color();
function updateDayNight(S){
  const L=S&&S.userData&&S.userData.lights; if(!L) return;
  const d=daylight();
  const w=weatherNow();
  // 朝夕(d が中間)のときだけ夕焼け色を強く混ぜる
  const dusk=Math.max(0,1-Math.abs(d-0.5)*4);
  S.background.copy(_cNight).lerp(_cDay,d);
  // 曇り/雨は空を鈍色へ寄せ、光を落とす (昼ほど効きが分かりやすい)
  if(w.sky!=null) S.background.lerp(_cWeather.setHex(w.sky), 0.25+0.5*d);
  L.sun.color.copy(_sNight).lerp(_sDay,d).lerp(_sDusk,dusk*0.55*w.light);
  L.sun.intensity  = (0.15+1.55*d)*w.light;
  L.amb.color.copy(_gNight).lerp(_gDay,d);
  L.amb.intensity  = (0.45+0.85*d)*(0.65+0.35*w.light);
  L.hemi.intensity = (0.25+0.85*d)*(0.65+0.35*w.light);
}

// ── 欲求アイコン: キャラの頭上に絵文字を出す ──────────────────────────────
//   絵文字は sharp で SVG→PNG にラスタライズしてテクスチャ化する (canvas 依存を増やさない)。
//   フォントが無い環境では描画が空になるので、その場合は色板にフォールバックする。
const NEED_EMOJI={eat:'🍚', sleep:'😴', work:'💼', sick:'🤒', shop:'🛒', bored:'🥱'};
const NEED_LABEL_JA={eat:'お腹が空いている', sleep:'眠い', work:'仕事中', sick:'体調が悪い', shop:'買い物に行きたい', bored:'退屈'};
const ICON_COLORS={eat:0xff8c3a, sleep:0x4a7bff, work:0x35c07a,
                   sick:0xff5a5a, shop:0xffd23a, bored:0xb07aff};
const ICON_PX=72;
const _iconGeo=new THREE.PlaneGeometry(CELL*.3,CELL*.3);
const _iconMats={};

// 起動時に全絵文字をテクスチャ化しておく (毎フレーム生成しない)
async function buildNeedIcons(){
  for(const [kind,emoji] of Object.entries(NEED_EMOJI)){
    let mat=null;
    try{
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}">`
        +`<circle cx="${ICON_PX/2}" cy="${ICON_PX/2}" r="${ICON_PX/2-2}" fill="#ffffff" fill-opacity="0.82"/>`
        +`<text x="${ICON_PX/2}" y="${ICON_PX*0.74}" font-size="${ICON_PX*0.62}" text-anchor="middle"`
        +` font-family="Apple Color Emoji, Noto Color Emoji, Segoe UI Emoji, sans-serif">${emoji}</text></svg>`;
      const png=await sharp(Buffer.from(svg)).png().toBuffer();
      const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      let opaque=0; for(let i=3;i<data.length;i+=4) if(data[i]>10) opaque++;
      if(opaque>50){
        const tex=new THREE.DataTexture(new Uint8Array(data), info.width, info.height, THREE.RGBAFormat);
        tex.flipY=true; tex.needsUpdate=true;
        mat=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthTest:false});
      }
    }catch(e){ /* フォント無し等 → 色板へ */ }
    if(!mat) mat=new THREE.MeshBasicMaterial(
      {color:ICON_COLORS[kind],transparent:true,opacity:0.95,depthTest:false});
    _iconMats[kind]=mat;
  }
  const emojiOk=Object.values(_iconMats).filter(m=>m.map).length;
  console.log(`[Life] 欲求アイコン生成: ${emojiOk}/${Object.keys(NEED_EMOJI).length} 種が絵文字`
            + (emojiOk<Object.keys(NEED_EMOJI).length ? ' (残りは色板フォールバック)' : ''));
}
function iconMat(kind){
  if(!_iconMats[kind]) _iconMats[kind]=new THREE.MeshBasicMaterial(
    {color:ICON_COLORS[kind]||0xffffff,transparent:true,opacity:0.95,depthTest:false});
  return _iconMats[kind];
}
// 頭上アイコンを現在の欲求に合わせて更新 (カメラの方を向かせる)
function updateNeedIcons(cam){
  for(let i=0;i<agents.length;i++){
    const a=agents[i], m=agentMeshes[i]; if(!m) continue;
    const kind=needOf(a);
    if(a.needIcon && a.needIcon.userData.kind!==kind){ m.remove(a.needIcon); a.needIcon=null; }
    if(!kind){ continue; }
    if(!a.needIcon){
      const ic=new THREE.Mesh(_iconGeo, iconMat(kind));
      ic.userData.kind=kind;
      ic.position.set(0,0,CELL*1.05);      // 頭上
      m.add(ic); a.needIcon=ic;
    }
    // 板を常にカメラへ向ける (親の回転を打ち消す)
    if(cam) a.needIcon.quaternion.copy(cam.quaternion).premultiply(m.getWorldQuaternion(new THREE.Quaternion()).invert());
  }
}

// ═══ 配信画面の HUD (Day カウンタ / ニュースティッカー) ═════════════════════
// YouTube に出ているのは 3D をそのまま rawvideo にしたフレームで、文字は一切乗らない。
// そこで描画を2パスにし、正射影カメラで板を重ねる。文字のラスタライズは
// SVG→sharp→DataTexture (上の欲求アイコンと同じ手。canvas 依存を増やさない)。
const HUD_ON        = process.env.HUD !== '0';
// 配信画面に焼き込む文字は **ASCII だけ**。本番 (Linux) に日本語フォントが無いと
// 豆腐になるため。表示領域も控えめにして街を隠さないようにする。
const HUD_DAY_W     = 250, HUD_DAY_H = 54;
const HUD_TICKER_H  = 30;
const HUD_SPEED     = envNum('HUD_SPEED', 90);      // ティッカーの流れる速さ (px/秒)
// 絵文字フォントを最後に足しておかないと 💊 や 🏛 が豆腐になる (欲求アイコンと同じ理由)。
// 配信画面には ASCII だけを描く (_ascii)。絵文字も日本語も落ちる。
//   sharp(librsvg) はカラー絵文字を確実には描けず、日本語は本番 (Linux) に
//   フォントが無いと豆腐になる。ニュース本文 (ログ / /city / WebSocket) は日本語のまま。
const HUD_FONT      = 'Helvetica Neue, Helvetica, DejaVu Sans, Arial, sans-serif';
const HUD_MONO      = 'Menlo, DejaVu Sans Mono, monospace';
let hudScene=null, hudCam=null, hudDay=null, hudTicker=null, hudBar=null;
// 日付板とティッカーは別々の busy フラグで管理する。1つにまとめていたら、
// ゲーム内時刻が速い設定 (DAY_MINUTES が小さい) で日付板が毎フレーム作り直され、
// ティッカーが永久に更新されなかった。
let hudDayText='', hudDayBusy=false, hudTickerBusy=false, hudTickerW=0, hudDayAt=0;

const _esc = t => String(t).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// 配信画面に焼き込む文字は **ASCII だけ**に落とす。日本語フォントが無い環境では
// 非 ASCII が全部豆腐になるので、混ざったら描く前に落としてしまう (最後の砦)。
const _ascii = t => String(t).replace(/[^\x20-\x7E]/g,'').replace(/\s{2,}/g,' ').trim();

async function svgTexture(svg){
  const png=await sharp(Buffer.from(svg)).png().toBuffer();
  const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const tex=new THREE.DataTexture(new Uint8Array(data), info.width, info.height, THREE.RGBAFormat);
  tex.flipY=true; tex.needsUpdate=true;
  let opaque=0; for(let i=3;i<data.length;i+=4) if(data[i]>10) opaque++;
  return {tex, opaque, w:info.width, h:info.height};
}

function hudPlane(w,h,tex){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),
    new THREE.MeshBasicMaterial({map:tex, transparent:true, depthTest:false}));
  return m;
}

async function initHud(){
  if(!HUD_ON || !sharp) return;
  hudScene=new THREE.Scene();
  hudCam=new THREE.OrthographicCamera(-WIDTH/2, WIDTH/2, HEIGHT/2, -HEIGHT/2, -10, 10);
  // ティッカーの下敷き (文字板は透過。スクロールしても帯は動かない)
  hudBar=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH, HUD_TICKER_H),
    new THREE.MeshBasicMaterial({color:0x050b10, transparent:true, opacity:0.55, depthTest:false}));
  hudBar.position.set(0, -HEIGHT/2+HUD_TICKER_H/2+6, 0);
  hudScene.add(hudBar);
  // 焼き込む文字は ASCII のみなので、日本語フォントの有無に依存しない。
  // (以前は日本語を描いていて、フォントの無い環境で全部豆腐になっていた)
  await refreshHudDay();
  await refreshHudTicker();
  console.log('[HUD] Day カウンタ / ニュースティッカーを配信画面に描画');
}

// 「DAY 12  08:30 / POP 34  TOWN  SUNNY」の2行。人口と発展段階と天気が
// 上がったり変わったりするのが見えること自体が、この街を見続ける理由になる。
function hudDayLines(){
  const h=gameHour();
  const hh=String(Math.floor(h)).padStart(2,'0'), mm=String(Math.floor(h%1*60)).padStart(2,'0');
  return [`DAY ${gameDay()+1}  ${hh}:${mm}`,
          CITY ? `POP ${agents.length}  ${levelSpec().en}  ${weatherNow().en}` : ''];
}
async function refreshHudDay(){
  const [l1,l2]=hudDayLines();
  const txt=l1+'|'+l2;
  if(txt===hudDayText || !hudScene) return;
  hudDayText=txt;
  const {tex}=await svgTexture(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${HUD_DAY_W}" height="${HUD_DAY_H}">`
    +`<rect width="${HUD_DAY_W}" height="${HUD_DAY_H}" rx="6" fill="#050b10" fill-opacity="0.58"/>`
    +`<text x="12" y="24" font-size="17" font-weight="bold" fill="#00d2a0"`
    +` font-family="${HUD_MONO}">${_esc(_ascii(l1))}</text>`
    +`<text x="12" y="43" font-size="13" fill="#9fd8c8"`
    +` font-family="${HUD_MONO}">${_esc(_ascii(l2))}</text></svg>`);
  if(hudDay){ hudScene.remove(hudDay); hudDay.material.map.dispose(); hudDay.material.dispose(); hudDay.geometry.dispose(); }
  hudDay=hudPlane(HUD_DAY_W, HUD_DAY_H, tex);
  hudDay.position.set(-WIDTH/2+HUD_DAY_W/2+12, HEIGHT/2-HUD_DAY_H/2-10, 1);
  hudScene.add(hudDay);
}

async function refreshHudTicker(){
  if(!hudScene) return;
  // en を持たないニュース (英語化する前に保存された街の記録) は**流さない**。
  // 日本語のまま描くとフォントの無い環境で豆腐になるため。
  const items=latestNews(12, true).filter(n=>n.en).slice(-6).map(n=>`D${n.day+1}  ${_ascii(n.en)}`);
  const txt=items.length ? items.reverse().join('   *   ')
                         : 'No records yet in this town';
  // 文字幅の見積り (ASCII のみ)。板の幅がズレると途中で切れる。
  const w=Math.min(6000, Math.max(WIDTH, Math.ceil(40 + txt.length*8.6)));
  const {tex}=await svgTexture(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${HUD_TICKER_H}">`
    +`<text x="16" y="21" font-size="16" fill="#dfeee9"`
    +` font-family="${HUD_FONT}">${_esc(_ascii(txt))}</text></svg>`);
  if(hudTicker){ hudScene.remove(hudTicker); hudTicker.material.map.dispose(); hudTicker.material.dispose(); hudTicker.geometry.dispose(); }
  hudTickerW=w;
  hudTicker=hudPlane(w, HUD_TICKER_H, tex);
  hudTicker.position.set(WIDTH/2+w/2, -HEIGHT/2+HUD_TICKER_H/2+6, 1);
  hudScene.add(hudTicker);
  hudNewsDirty=false;
}

// ── イベントの一言バナー ────────────────────────────────────────────────────
//   「〇〇が建ちました」「〇〇がなくなりました」を数秒だけ大きく出す。
//   ティッカーは一周に時間がかかるので、その瞬間に見せたいものは別枠にする。
let hudBanner=null, hudBannerT0=0, hudBannerUntil=0, hudBannerBusy=false;

async function setBanner(text, secs){
  if(!hudScene) return;
  const w=Math.min(WIDTH-40, Math.max(240, Math.ceil(44 + text.length*11.5))), h=48;
  const {tex}=await svgTexture(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    +`<rect width="${w}" height="${h}" rx="6" fill="#050b10" fill-opacity="0.74"/>`
    +`<rect x="0" y="0" width="3" height="${h}" fill="#00d2a0"/>`
    +`<text x="18" y="31" font-size="21" fill="#eaf6f2"`
    +` font-family="${HUD_FONT}">${_esc(_ascii(text))}</text></svg>`);
  if(hudBanner){ hudScene.remove(hudBanner); hudBanner.material.map.dispose(); hudBanner.material.dispose(); hudBanner.geometry.dispose(); }
  hudBanner=hudPlane(w, h, tex);
  hudBanner.material.opacity=0;
  hudBanner.position.set(0, HEIGHT/2-h/2-74, 2);
  hudScene.add(hudBanner);
  hudBannerT0=Date.now(); hudBannerUntil=hudBannerT0+secs*1000;
}
function showBanner(text, secs){
  if(!hudScene || hudBannerBusy) return;
  hudBannerBusy=true;
  setBanner(_ascii(text), secs||6)
    .catch(e=>console.warn('[HUD]',e.message))
    .finally(()=>{ hudBannerBusy=false; });
}
function updateBanner(){
  if(!hudBanner) return;
  const now=Date.now(), left=hudBannerUntil-now;
  if(left<=0){
    hudScene.remove(hudBanner);
    hudBanner.material.map.dispose(); hudBanner.material.dispose(); hudBanner.geometry.dispose();
    hudBanner=null; return;
  }
  // 0.3秒でフェードイン / 0.6秒でフェードアウト
  hudBanner.material.opacity=Math.max(0, Math.min(1, Math.min((now-hudBannerT0)/300, left/600)));
}

// 毎フレーム呼ばれる。テクスチャの作り直しは「文字が変わったとき」だけで、
// スクロールは板を動かすだけ (sharp を毎フレーム回さない)。
function updateHud(dt){
  if(!hudScene) return;
  updateBanner();
  // 時計は最短1秒に1回だけ作り直す (SVG のラスタライズを毎フレーム回さない)
  const now=Date.now();
  if(!hudDayBusy && now-hudDayAt>900){
    const want=hudDayLines().join('|');
    if(want!==hudDayText){
      hudDayBusy=true; hudDayAt=now;
      refreshHudDay().catch(e=>console.warn('[HUD]',e.message)).finally(()=>{hudDayBusy=false;});
    }
  }
  if(hudTicker){
    hudTicker.position.x -= HUD_SPEED*dt;
    if(hudTicker.position.x + hudTickerW/2 < -WIDTH/2){        // 流れ切った
      if(hudNewsDirty && !hudTickerBusy){                      // 新しいニュースがあれば作り直す
        hudTickerBusy=true;
        refreshHudTicker().catch(e=>console.warn('[HUD]',e.message)).finally(()=>{hudTickerBusy=false;});
      }else{
        hudTicker.position.x = WIDTH/2 + hudTickerW/2;
      }
    }
  }
}

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

// 到達可能性の判定は world.js の largestComponent / reachableBuildings に統合。
// 区画の奥で四方を囲まれた建物は通行可能領域から孤立し、湧いても動けず経路も
// 引けない。ALIGNED では makeMap が入口を作って補修するので発生しない。
function rebuildBuildings(map){
  BUILDINGS.length=0;
  // 通行可能領域の最大連結成分に接する建物だけがゴール/拠点になれる。
  // ALIGNED では makeMap が補修済みなので全建物が該当するはず。
  const usable = MW.reachableBuildings(map, WORLD);
  for(const b of usable) BUILDINGS.push(b);
  let total=0;
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++) if(map[r][c]===BUILDING) total++;
  const isolated = total - BUILDINGS.length;
  if(isolated) console.log(`[Map] 孤立建物 ${isolated}/${total} 件を湧き先/目的地から除外`);
  else console.log(`[Map] ゴール可能な建物 ${BUILDINGS.length}/${total}`);
}
rebuildBuildings(MAP);
// ═══ 生活シミュレーション (拠点 / 内部状態 / 時刻) ═════════════════════════════
//   ポリシーの観測は一切変えない。内部状態は「目的地の抽選確率」だけを動かすので
//   再学習は不要 (ポリシーから見れば compass の指す先が変わるだけ)。
//   ※ 将来ここを観測(aux)にも入れると、方策自身が空腹/疲労を理解して動けるようになる。
const DAY_MINUTES   = parseFloat(process.env.DAY_MINUTES) || 24;  // 実時間 何分で 24h が一周するか
const HUNGER_RATE   = 1/(9*60);    // 1秒あたりの空腹上昇 (約9分で満腹→空腹)
const FATIGUE_RATE  = 1/(14*60);   // 1秒あたりの疲労上昇
const EAT_RECOVER   = 0.75;        // 飲食店に着いたときの空腹回復量
const SLEEP_RECOVER = 0.55;        // 自宅に着いたときの疲労回復量
const NEED_HI       = 0.62;        // これを超えると「その欲求で目的地を選ぶ」
const SUPPLY_RATE   = 1/(16*60);   // 日用品の消費 (買い物欲)
const BORED_RATE    = 1/(11*60);   // 退屈の蓄積 (人と会う/娯楽で解消)
const SICK_PROB     = 1/(60*90);   // 1秒あたりの発症確率 (平均90分に1回)
const SICK_HEAL     = 1/(4*60);    // 病院/薬局での回復速度
const BUY_RECOVER   = 0.85;        // 店に着いたときの補充量
const FUN_RECOVER   = 0.5;         // 娯楽施設での退屈解消
const SICK_HI       = 0.35;        // これを超えたら病院へ (低めの閾値=すぐ向かう)

// 建物カテゴリ → 正準index (BLDG_TYPES から動的に引く。名前変更に強い)
const IDX_OF   = n => BLDG_NAME_TO_IDX[n];
const FOOD_IDX = ['kiosk','ramen','gyudon','cafe','bento'].map(IDX_OF).filter(v=>v!=null);
const HOME_IDX = ['house','apartment'].map(IDX_OF).filter(v=>v!=null);
const WORK_IDX = ['office','tower','bank','post','cityhall'].map(IDX_OF).filter(v=>v!=null);
const CARE_IDX = ['hospital','pharmacy'].map(IDX_OF).filter(v=>v!=null);        // 病気
const BUY_IDX  = ['conbini','supermarket','shop','mall'].map(IDX_OF).filter(v=>v!=null); // 買い物
const FUN_IDX  = ['stadium','temple','museum','library'].map(IDX_OF).filter(v=>v!=null);  // 退屈しのぎ

// ゲーム内時刻 [0,24)。起動時刻は START_HOUR から始まる (既定 8時 = 朝の活動時間)。
//   実時間に直接紐づけると、起動タイミング次第で深夜(=全員sleep)から始まってしまうため。
const START_HOUR = (()=>{ const v=parseFloat(process.env.START_HOUR); return isNaN(v)?8:((v%24)+24)%24; })();
const _bootMs = Date.now();
function gameHour(){
  const elapsed=(Date.now()-_bootMs)/1000;
  return (START_HOUR + elapsed/(DAY_MINUTES*60)*24) % 24;
}
// 昼夜の明るさ [0,1] (0=真夜中, 1=正午)。日の出6時/日の入18時あたりで滑らかに遷移。
function daylight(){
  const h=gameHour();
  return Math.max(0, Math.min(1, (Math.cos((h-13)/24*Math.PI*2)+1)/2 ));
}

// ═══ 街の恒久状態 CITY (不可逆な蓄積) ══════════════════════════════════════════
//   仕様: docs/city-evolution-spec.md
//   踏み跡が道になり、足りない業種を住民が起業し、客の来ない店は閉店する。
//   変化はすべて「日次のまとめ」で起こす (dailyRollover)。理由は2つ:
//     1. 変化量が agent 数や TICK に依存しなくなる (絶対閾値だと調整不能)
//     2. 「朝起きたら道が伸びている」という配信のリズムになる
const CITY_EVOLVE  = process.env.CITY_EVOLVE !== '0';
const CITY_SEED    = envNum('CITY_SEED', 42);
const CITY_FILE    = process.env.CITY_STATE_FILE || path.join(__dirname,'data','city_state.json');
const CITY_SAVE_SEC= envNum('CITY_SAVE_SEC', 60);
const DAY_ROLL_H   = envNum('DAY_ROLL_H', 5);       // 日付が変わる時刻 (朝5時)
// 踏み跡 → 道
const ROAD_PER_DAY = envNum('ROAD_PER_DAY', 2);     // 1日に昇格する空き地の本数
const FOOT_MIN     = envNum('FOOT_MIN', 300);       // 昇格に必要な最低踏み跡数
const FOOT_DECAY   = envNum('FOOT_DECAY', 0.9);     // 昇格しなかったセルの日次減衰
// 地面の摩耗表現。踏み跡の絶対数だけで塗ると、人数が多い街では空き地が全部
// 茶色になってしまう (300体で1分で 500 踏み)。**上位何%か**で塗り、
// WEAR_1/WEAR_2 は「これ以下では塗らない」下限として使う。
const WEAR_1       = envNum('WEAR_1', 60);          // 踏み固めの下限
const WEAR_2       = envNum('WEAR_2', 160);         // 土が露出する下限
const WEAR_TOP1    = envNum('WEAR_TOP1', 0.20);     // 踏み跡のある空き地の上位20%まで踏み固め
const WEAR_TOP2    = envNum('WEAR_TOP2', 0.05);     // 上位5%は土が露出
// 起業
const FOUND_PER_POP   = envNum('FOUND_PER_POP', 40);    // 何人につき1日1軒 建てられるか
// 発火は「その場所を通った未充足需要の濃さ」で決める。単位は agent-day
// (= 何人日ぶんの『遠くて満たせない欲求』がそこを通ったか)。
//   不満の合計を供給軒数で割る形も試したが、この街は 900セルに 139軒と密で
//   「最寄りが遠い」人がほとんど居らず、合計は常にゼロに潰れた。場所ごとに見れば
//   「この一帯にだけ飲食店が無い」が拾える。開店すればその一帯の人は D_OK 以内に
//   店を持つので需要が止まり、飽和も自動的に収まる。
const FOUND_SITE      = envNum('FOUND_SITE', 0.5);
const CONSTRUCT_HOURS = envNum('CONSTRUCTION_HOURS', 2);// 工事中の長さ (ゲーム内時間)
// 「遠い」の基準。街が密なので既定は小さめ。実測値 (平均最寄り距離) は毎日ログに出る。
const DEMAND_D_OK     = envNum('DEMAND_D_OK', 3);       // これより近ければ需要ゼロ
const DEMAND_D_FAR    = envNum('DEMAND_D_FAR', 10);     // これより遠ければ需要最大
const DEMAND_DECAY    = envNum('DEMAND_DECAY', 0.75);   // ヒートマップの日次減衰
// 閉店
// 演出 (建物がせり上がる / 沈む + カメラを寄せる時間)
const ANIM_RISE_SEC  = envNum('ANIM_RISE_SEC', 3.5);
const ANIM_SINK_SEC  = envNum('ANIM_SINK_SEC', 3.0);
const EVENT_CAM_SEC  = envNum('EVENT_CAM_SEC', 9);      // 1イベントを映す秒数
// 閉店
const CLOSE_PER_DAY   = envNum('CLOSE_PER_DAY', 1);
const GRACE_DAYS      = envNum('GRACE_DAYS', 3);        // 開業直後は閉店判定を免除
const CLOSE_FRAC      = envNum('CLOSE_FRAC', 0.25);     // 同業の来客平均のこの割合を下回ると閉店
const MIN_PER_CAT     = envNum('MIN_PER_CAT', 2);       // カテゴリごとに残す最低軒数
const DEMOLISH_DAYS   = envNum('DEMOLISH_DAYS', 5);     // 閉店から取り壊しまで
// ═══ 村から始めて育てる ══════════════════════════════════════════════════════
//   makeMap は学習側 (mesa_env) と bit-identical でなければならないので触らない。
//   生成された「完成した街」から間引いて村に戻す後処理として実装する。
const START_VILLAGE   = process.env.START_VILLAGE !== '0';
const START_SIZE      = envNum('START_SIZE', 10);        // 最初のフィールドの一辺 (最大 GRID)
const START_BUILDINGS = envNum('START_BUILDINGS', 12);   // 最初に建っている建物の数
const START_POP       = envNum('START_POP', 8);          // 最初の人口
// 土地が足りなくなったらフィールドを広げる (1日1回まで)
const EXPAND_STEP     = envNum('EXPAND_STEP', 2);        // 1回に広げる幅 (両側に1セルずつ)
// 拡張の主な判断は**建て込み具合**。空き区画の数で見ると、建物が増えるほど
// 「建物に接した空き地」も増えてしまい、いつまでも広がらない。
const EXPAND_DENSITY  = envNum('EXPAND_DENSITY', 0.28);  // 建物がフィールドのこの割合を超えたら広げる
const EXPAND_FREE     = envNum('EXPAND_FREE', 6);        // 空き区画がこれ以下でも広げる (保険)
const EXPAND_TREES    = envNum('EXPAND_TREES', 3);       // 新しい土地の木の間引き (n セルに1本)
// 住居/職場の定員 (人口の上限を決める = 家が建つと人が増える)
const HOUSE_CAP       = envNum('HOUSE_CAP', 2);
const APT_CAP         = envNum('APT_CAP', 12);
const WORK_CAP        = envNum('WORK_CAP', 6);           // 1つの職場が受け入れる人数
const POP_GROWTH      = envNum('POP_GROWTH', 0.15);      // 1日の転入は人口の何割か
const MOVEIN_MAX      = envNum('MOVEIN_MAX', 8);         // 1日の転入の上限
const HOME_PRESSURE   = envNum('HOME_PRESSURE', 0.85);   // 定員のこの割合を超えたら住宅を建てる
const WORK_PRESSURE   = envNum('WORK_PRESSURE', 0.9);    // 同上 (職場)

// 発展段階。経済活動 (店への来店の累計) が溜まると上がり、**背の高い建物と 2x2 が解禁**される。
//   高さは BLDG_TYPES の height。低い順に 0.7(屋台) … 3.3(タワー)。
//   「経済が回ると街が高くなる」を、建てられるものの制限だけで表現する。
//   ECON_SCALE で発展の速さをまとめて調整できる (小さいほど早く育つ)。
const ECON_SCALE = envNum('ECON_SCALE', 1);
const CITY_LEVELS = [
  { name:'集落', en:'HAMLET',     maxH:1.4, fp2:false, econ:0     },
  { name:'村',   en:'VILLAGE',    maxH:1.7, fp2:false, econ:400   },
  { name:'町',   en:'TOWN',       maxH:2.1, fp2:true,  econ:2000  },
  { name:'市',   en:'CITY',       maxH:2.6, fp2:true,  econ:8000  },
  { name:'都市', en:'METROPOLIS', maxH:3.3, fp2:true,  econ:25000 },
].map(L=>({...L, econ:L.econ*ECON_SCALE}));

// ═══ 天気 ══════════════════════════════════════════════════════════════════
//   晴れ / 曇り / 雨。空の色と光の強さ、雨粒、HUD 表示、そして「雨の日は外を歩くと
//   疲れる」という小さな効果まで。WEATHER_HOURS ゲーム時間ごとに抽選し直す。
const WEATHER_HOURS = envNum('WEATHER_HOURS', 6);   // 何ゲーム時間ごとに抽選し直すか
const WEATHERS = {
  sunny : { ja:'晴れ', en:'SUNNY',  p:0.55, light:1.00, sky:null,     fatigue:1.0  },
  cloudy: { ja:'曇り', en:'CLOUDY', p:0.30, light:0.74, sky:0x9aa6b2, fatigue:1.0  },
  rain  : { ja:'雨',   en:'RAIN',   p:0.15, light:0.52, sky:0x6d7782, fatigue:1.35 },
};
const WEATHER_KEYS = Object.keys(WEATHERS);
const weatherNow = () => WEATHERS[(CITY && CITY.weather) || 'sunny'] || WEATHERS.sunny;

function stepWeather(){
  if(!CITY) return;
  const now=Date.now();
  if(CITY.weatherUntil && now < CITY.weatherUntil) return;
  let r=Math.random(), pick=WEATHER_KEYS[0];
  for(const k of WEATHER_KEYS){ r-=WEATHERS[k].p; if(r<=0){ pick=k; break; } }
  const changed = pick!==CITY.weather;
  CITY.weather=pick;
  CITY.weatherUntil = now + WEATHER_HOURS*(DAY_MINUTES*60/24)*1000;
  if(changed) news('weather', `天気が ${WEATHERS[pick].ja} になった`, `Weather: ${WEATHERS[pick].en}`);
}

// 需要カテゴリ (欲求 → 建物カテゴリ)
const CATS      = ['eat','shop','fun','care'];
const BUILD_CATS= ['home','work','eat','shop','fun','care'];   // 建てられるもの (優先順)
const NEED_CAT  = { eat:'eat', shop:'shop', bored:'fun', sick:'care' };
const CAT_IDX   = { eat:FOOD_IDX, shop:BUY_IDX, fun:FUN_IDX, care:CARE_IDX,
                    home:HOME_IDX, work:WORK_IDX };
const CAT_LABEL = { eat:'飲食店', shop:'買い物する場所', fun:'遊ぶ場所', care:'医療',
                    home:'住むところ', work:'働くところ' };

// 配信画面 (HUD) は英語で描く。Linux に日本語フォントが無いと豆腐になるため、
// 焼き込む文字は ASCII に統一する。ログ / /city / WebSocket は日本語のまま。
const BLDG_EN = {
  kiosk:'Food Stall', conbini:'Convenience Store', pharmacy:'Pharmacy', cafe:'Cafe',
  gyudon:'Beef Bowl Shop', ramen:'Ramen Shop', bento:'Bento Shop', shop:'Shop',
  house:'House', post:'Post Office', bank:'Bank', apartment:'Apartment', hotel:'Hotel',
  office:'Office', tower:'Tower', supermarket:'Supermarket', temple:'Shrine',
  school:'School', station:'Station', library:'Library', hospital:'Hospital',
  cityhall:'City Hall', museum:'Museum', stadium:'Stadium', mall:'Mall',
};
const enOf = t => BLDG_EN[BLDG_TYPES[t].name] || BLDG_TYPES[t].name;
const CAT_EN = { eat:'food', shop:'shops', fun:'leisure', care:'healthcare',
                 home:'housing', work:'workplaces' };

// いまの発展段階で建てられるか。方策の goal は BLDG_TYPES(25) の one-hot なので、
// **新種を作らない限り再学習は不要**。増えるのは「いつ建つか」だけ。
function cityLevel(){
  if(!CITY) return 0;
  let lv=0;
  for(let i=0;i<CITY_LEVELS.length;i++) if(CITY.econ>=CITY_LEVELS[i].econ) lv=i;
  return lv;
}
const levelSpec = () => CITY_LEVELS[cityLevel()];
function typeAllowed(t){
  const bt=BLDG_TYPES[t], L=levelSpec();
  return bt.height <= L.maxH+1e-6 && (bt.footprint===1 || L.fp2);
}
const foundableTypes = cat => (CAT_IDX[cat]||[]).filter(typeAllowed);

// 閉店しうるのは「いま建て直せる業種」だけ。住宅と職場は潰さない
// (自宅が消えると拠点割当が壊れ、職場が消えると全員が失業する)。
const CLOSABLE_CATS = ['eat','shop','fun','care'];
const isClosable = t => CLOSABLE_CATS.some(c=>(CAT_IDX[c]||[]).includes(t)) && typeAllowed(t);

let CITY = null;             // 街の恒久状態 (initCity で作るか読み込む)
let cityStamp = 0;           // 建物の状態が変わるたびに増やす (カテゴリ一覧キャッシュの無効化)
let boxGeoByH = {};          // 高さ別 BoxGeometry (建物メッシュで共有)
let groundDirty = false;     // 地面の板を作り直す必要があるか
const cellStruct = {};       // "r_c" -> struct (2x2 は4セルとも同じ struct を指す)

function newStruct(r,c,fp,typeIdx,born){
  return { r, c, fp, typeIdx,
    state:'open',            // 'open' | 'construction' | 'closed' | 'gone'
    born: born||0,           // 建った日 (0 = 創世時からある)
    openedBy: null,          // 起業した住民の aid
    visits: 0, visitsToday: 0, ema: 0,
    firstCustomer: null, doneAt: null, closedDay: null };
}

function structAt(r,c){ return cellStruct[r+'_'+c] || null; }

// CITY.structs から派生テーブルを作り直す。建物の状態を変えたら必ず呼ぶ。
//   BUILDING_TYPES は「見た目/レイキャスト用」なので閉店中・工事中も載せる。
//   「行き先に選べるか」は state で判定する (buildingsOfTypes / pickBuildingOfType)。
function syncCity(){
  for(const k in cellStruct) delete cellStruct[k];
  BUILDING_TYPES = {};
  if(!CITY) return;
  for(const st of CITY.structs){
    if(st.state==='gone') continue;
    for(let dr=0;dr<st.fp;dr++)for(let dc=0;dc<st.fp;dc++){
      const k=(st.r+dr)+'_'+(st.c+dc);
      cellStruct[k]=st; BUILDING_TYPES[k]=st.typeIdx;
    }
  }
  cityStamp++;
}

// カテゴリ別の「営業中の建物」一覧。1秒ごとに全エージェントぶん引くので、
// 建物の状態が変わったときだけ作り直す (cityStamp でキャッシュを無効化)。
let _catCache={stamp:-1, cells:{}, count:{}};
function catBuildings(cat){
  if(_catCache.stamp!==cityStamp){
    _catCache={stamp:cityStamp, cells:{}, count:{}};
    for(const c of BUILD_CATS){ _catCache.cells[c]=[]; _catCache.count[c]=0; }
    if(CITY) for(const st of CITY.structs){
      if(st.state!=='open') continue;
      for(const c of BUILD_CATS){
        if(!(CAT_IDX[c]||[]).includes(st.typeIdx)) continue;
        _catCache.count[c]++;
        _catCache.cells[c].push([st.r+ (st.fp-1)/2, st.c + (st.fp-1)/2]);
      }
    }
  }
  return _catCache.cells[cat]||[];
}
function catCount(cat){ catBuildings(cat); return _catCache.count[cat]||0; }

// ── 建物メッシュ (1軒単位で差し替えられるようにする) ──
function structMats(st){
  if(st.state==='construction')                      // 工事中 = 灰色の低い箱
    return new THREE.MeshLambertMaterial({color:0x8f8f86});
  const mats=getBuildingMaterial(st.typeIdx).map(m=>m.clone());
  if(st.state==='closed') mats.forEach(m=>m.color.setRGB(0.40,0.38,0.36));  // シャッター
  return mats;
}
function structHeight(st){
  const bt=BLDG_TYPES[st.typeIdx%BLDG_TYPES.length];
  return st.state==='construction' ? CELL*0.3 : bt.height*CELL;
}
function removeStructMesh(S, st){
  const key=st.r+'_'+st.c+'_b', o=occluders[key];
  structAnims.delete(st.r+'_'+st.c);   // 差し替え前のメッシュを動かし続けない
  if(!o) return;
  if(S) S.remove(o.mesh);
  // geometry は boxGeoByH で共有、テクスチャは建物タイプで共有。
  // ここで dispose していいのは clone した material だけ。
  const arr=Array.isArray(o.mesh.material)?o.mesh.material:[o.mesh.material];
  arr.forEach(m=>m.dispose());
  delete occluders[key];
}
function addStructMesh(S, st){
  if(!S || st.state==='gone') return;
  removeStructMesh(S, st);
  const span=st.fp, bw=span*CELL*0.8, h=structHeight(st);
  const cx=st.c*CELL+span*CELL*0.5, cy=st.r*CELL+span*CELL*0.5;
  const gkey=span+'_'+h.toFixed(3);
  if(!boxGeoByH[gkey]) boxGeoByH[gkey]=new THREE.BoxGeometry(bw,bw,h);
  const mesh=new THREE.Mesh(boxGeoByH[gkey], structMats(st));
  mesh.position.set(cx,cy,h/2);
  S.add(mesh);
  occluders[st.r+'_'+st.c+'_b']={mesh,cx,cy,faded:false};
}

// ── 雨粒 ────────────────────────────────────────────────────────────────────
//   カメラの周りだけに降らせる (街全体に撒くと、寄りの画では粒がまばらに見える)。
//   点の集合を1メッシュで持ち、落ちきったら上へ戻して使い回す。
const RAIN_N     = envNum('RAIN_COUNT', 1100);
const RAIN_SPAN  = CELL*9;      // カメラ周りに降る範囲 (半径)
const RAIN_TOP   = CELL*7;      // 降り始めの高さ
const RAIN_SPEED = envNum('RAIN_SPEED', 26);

// 粒 (THREE.Points) はソフトウェア GL だと gl_PointSize がほぼ効かず見えなかったので、
// 1滴 = 短い線分 (LineSegments) にする。雨脚らしく見えるし確実に描かれる。
const RAIN_LEN  = CELL*0.75;     // 1滴の長さ
const RAIN_SLANT= CELL*0.18;     // 斜めに降らせる量 (風)
function ensureRain(S){
  if(!S) return null;
  if(S.userData.rain) return S.userData.rain;
  const pos=new Float32Array(RAIN_N*2*3);     // 2頂点/滴
  for(let i=0;i<RAIN_N;i++){
    const x=(Math.random()*2-1)*RAIN_SPAN, y=(Math.random()*2-1)*RAIN_SPAN, z=Math.random()*RAIN_TOP;
    pos[i*6  ]=x;             pos[i*6+1]=y; pos[i*6+2]=z;
    pos[i*6+3]=x+RAIN_SLANT;  pos[i*6+4]=y; pos[i*6+5]=z+RAIN_LEN;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  const m=new THREE.LineBasicMaterial({color:0xf2f8ff, transparent:true,
                                       opacity:0.8, depthWrite:false});
  const p=new THREE.LineSegments(g,m);
  p.visible=false;
  S.add(p);
  S.userData.rain=p;
  return p;
}

function stepRain(dt, cam){
  if(!scene) return;
  const p=ensureRain(scene);
  if(!p) return;
  const raining = !!(CITY && CITY.weather==='rain');
  p.visible=raining;
  if(!raining) return;
  p.position.set(cam.position.x, cam.position.y, 0);   // カメラの足元に雨の箱を追従
  const arr=p.geometry.attributes.position.array, drop=RAIN_SPEED*dt;
  for(let i=0;i<RAIN_N;i++){
    const b=i*6;
    arr[b+2]-=drop; arr[b+5]-=drop;
    if(arr[b+2]<0){
      const x=(Math.random()*2-1)*RAIN_SPAN, y=(Math.random()*2-1)*RAIN_SPAN;
      arr[b  ]=x;            arr[b+1]=y; arr[b+2]=RAIN_TOP;
      arr[b+3]=x+RAIN_SLANT; arr[b+4]=y; arr[b+5]=RAIN_TOP+RAIN_LEN;
    }
  }
  p.geometry.attributes.position.needsUpdate=true;
}

function addTreeMesh(S, r, c){
  const T=S && S.userData && S.userData.tree;
  if(!T) return;
  const cx=c*CELL+CELL*.5, cy=r*CELL+CELL*.5;
  const trunk=new THREE.Mesh(T.trunkGeo, T.trunkMat.clone());
  trunk.position.set(cx,cy,CELL*.2); S.add(trunk);
  const cone=new THREE.Mesh(T.coneGeo, T.coneMat.clone());
  cone.position.set(cx,cy,CELL*.58); S.add(cone);
  occluders[r+'_'+c+'_t1']={mesh:trunk,cx,cy,faded:false};
  occluders[r+'_'+c+'_t2']={mesh:cone,cx,cy,faded:false};
}

// 道路 / 草地 / 摩耗した地面の板。踏み跡が溜まると草地→踏み固め→土に変わる。
//   「閾値を超えた瞬間にアスファルトが生える」より、土が露出していく過程が
//   見えているほうが蓄積に見える。板は3枚のマージ済みメッシュにまとめる。
function rebuildGround(S){
  if(!S) return;
  const g=S.userData.ground||(S.userData.ground={});
  for(const k of ['base','road','grass','wear1','wear2']){
    if(g[k]){ S.remove(g[k]); g[k].geometry.dispose(); g[k].material.dispose(); g[k]=null; }
  }
  // 下地の板。フィールドの外は何も描かない (世界の果て = 背景色) ので、
  // 街が広がると島が大きくなっていくように見える。
  const fs=fieldSize()*CELL, fx=fieldCenterW();
  g.base=new THREE.Mesh(new THREE.PlaneGeometry(fs,fs),
                        new THREE.MeshLambertMaterial({color:0xe6e9e2}));
  g.base.position.set(fx,fx,0);
  S.add(g.base);
  // 上位%の閾値をその場の分布から決める (絶対数だと人数しだいで全面茶色になる)
  let t1=Infinity, t2=Infinity;
  if(CITY){
    const vals=[];
    for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
      if(MAP[r][c]===OTHER && CITY.foot[r*GRID+c]>0) vals.push(CITY.foot[r*GRID+c]);
    if(vals.length){
      vals.sort((a,b)=>b-a);
      t1=Math.max(WEAR_1, vals[Math.min(vals.length-1, Math.floor(vals.length*WEAR_TOP1))]);
      t2=Math.max(WEAR_2, vals[Math.min(vals.length-1, Math.floor(vals.length*WEAR_TOP2))]);
    }
  }
  const road=[], grass=[], w1=[], w2=[];
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    const t=MAP[r][c], cx=c*CELL+CELL*.5, cy=r*CELL+CELL*.5;
    if(t===ROAD){ pushQuad(road, CELL*.97, cx, cy, .008); continue; }
    if(t!==OTHER) continue;                       // 建物/木のセルには板を敷かない
    const f=CITY?CITY.foot[r*GRID+c]:0;
    if(f>=t2)      pushQuad(w2,    CELL*.97, cx, cy, .006);
    else if(f>=t1) pushQuad(w1,    CELL*.97, cx, cy, .006);
    else           pushQuad(grass, CELL*.97, cx, cy, .005);
  }
  if(road.length) { g.road =quadMesh(road,  0xc4c8cc); S.add(g.road); }
  if(grass.length){ g.grass=quadMesh(grass, 0x9ccc65); S.add(g.grass); }
  if(w1.length)   { g.wear1=quadMesh(w1,    0xa8a878); S.add(g.wear1); }
  if(w2.length)   { g.wear2=quadMesh(w2,    0xb9a97e); S.add(g.wear2); }
}

// ── 建物の出現/消滅アニメーション ──────────────────────────────────────────
//   建物は地面の下から**せり上がり**、取り壊しでは地面に**沈む**。
//   地面 (W×W の不透明プレーン, z=0) がカメラより常に下にあるので、z<0 に潜った
//   ぶんは自然に隠れる。クリッピング平面を足す必要はない。
const structAnims = new Map();          // "r_c" -> {mesh, kind, t0, dur, h, onDone}

// アニメの開始位置に置くだけ (カメラが来るまで動かさない)。
//   カメラのイベントが待ち行列に並ぶので、状態変化と同時に動かすと
//   「カメラが着いたころには沈み終わっている」ことになる。
function prepStructAnim(st, kind){
  const o=occluders[st.r+'_'+st.c+'_b'];
  if(!o) return;
  if(kind==='rise') o.mesh.position.z = -structHeight(st)/2;   // 地面の下に完全に潜る
}

function animateStruct(st, kind, onDone){
  const o=occluders[st.r+'_'+st.c+'_b'];
  if(!o){ if(onDone) onDone(); return; }
  const h=structHeight(st);
  const dur=(kind==='rise'?ANIM_RISE_SEC:ANIM_SINK_SEC)*1000;
  if(kind==='rise') o.mesh.position.z = -h/2;
  structAnims.set(st.r+'_'+st.c, {mesh:o.mesh, kind, t0:Date.now(), dur, h, onDone});
}

// 毎フレーム呼ぶ。終わったら onDone (取り壊しの後始末はここで走る)。
function stepStructAnims(){
  if(!structAnims.size) return;
  const now=Date.now();
  for(const [k,a] of structAnims){
    const p=Math.min(1, (now-a.t0)/a.dur);
    const e=1-Math.pow(1-p, 3);                  // ease-out (最後にふわっと止まる)
    a.mesh.position.z = (a.kind==='rise') ? (-a.h/2 + e*a.h) : (a.h/2 - e*a.h);
    if(p>=1){ structAnims.delete(k); if(a.onDone) a.onDone(); }
  }
}

// ── 街のイベントをカメラで見せる ────────────────────────────────────────────
//   既存のカメラは「エージェント」しかターゲットにできないので、場所を指す仕組みを足す。
//   イベント中は追跡を止め、その場所をゆっくり回り込みながら映し、画面に一言出す。
const camEvents = [];                   // {r,c,secs,banner}
let camEventCur = null;

// anim = {st, kind, onDone} を渡すと、カメラがその場所に着いた瞬間に動き出す。
// opts.wide = true で引きの画 (街全体を見せたいとき。発展段階が上がった瞬間など)。
function showCityEvent(r, c, banner, secs, anim, opts){
  if(anim) prepStructAnim(anim.st, anim.kind);
  camEvents.push({r, c, banner, secs:secs||EVENT_CAM_SEC, anim, wide:!!(opts&&opts.wide)});
  while(camEvents.length>4){
    // 溢れたぶんは映せないが、アニメだけは走らせる (地面の下に沈めたまま放置しない)
    const drop=camEvents.shift();
    if(drop.anim) animateStruct(drop.anim.st, drop.anim.kind, drop.anim.onDone);
  }
}
// 現在映すべきイベントを返す (無ければ null)。updateTrackingCamera から毎フレーム。
function stepCamEvents(){
  const now=Date.now();
  if(camEventCur && now>=camEventCur.until) camEventCur=null;
  if(!camEventCur && camEvents.length){
    camEventCur=camEvents.shift();
    camEventCur.t0=now;
    camEventCur.until=now+camEventCur.secs*1000;
    if(camEventCur.banner) showBanner(camEventCur.banner, camEventCur.secs);
    const an=camEventCur.anim;
    if(an) animateStruct(an.st, an.kind, an.onDone);   // カメラが着いてから動かす
  }
  return camEventCur;
}

// ── ゲーム内の日付 ──────────────────────────────────────────────────────────
//   gameHour() と同じく実時間から求める。dayBase を永続化するので再起動しても戻らない。
//   境目は朝 DAY_ROLL_H 時。深夜に街が変わるより「朝起きたら道ができている」ほうが自然。
function daysSinceBoot(){
  const elapsed=(Date.now()-_bootMs)/1000;
  return Math.max(0, Math.floor((START_HOUR - DAY_ROLL_H + elapsed/(DAY_MINUTES*60)*24)/24));
}
function gameDay(){ return (CITY?CITY.dayBase:0) + daysSinceBoot(); }

// ── 永続化 ──────────────────────────────────────────────────────────────────
//   マップ生成則や種を変えたら読まない (壊れた街を復元しないため)。
function cityToJSON(){
  const own={};
  for(const a of agents){
    if(a.seenMask || a.owns) own[a.aid]={m:a.seenMask||0, o:a.owns||null};
  }
  return {
    version:1, seed:CITY.seed, grid:GRID, savedAt:Date.now(),
    day:gameDay(), bornAt:CITY.bornAt,
    econ:CITY.econ, level:CITY.level, pop:agents.length, size:CITY.size, weather:CITY.weather,
    map:MAP.map(row=>row.join('')),
    structs:CITY.structs.map(st=>({...st})),
    foot:Array.from(CITY.foot),
    demand:Object.fromEntries(CATS.map(c=>[c, Array.from(CITY.demand[c], v=>+v.toFixed(2))])),
    unmet:CITY.unmet, stats:CITY.stats, news:CITY.news.slice(-200), agents:own,
  };
}
function saveCity(){
  if(!CITY) return;
  try{
    const tmp=CITY_FILE+'.tmp';
    fs.mkdirSync(path.dirname(CITY_FILE),{recursive:true});
    fs.writeFileSync(tmp, JSON.stringify(cityToJSON()));
    fs.renameSync(tmp, CITY_FILE);
  }catch(e){ console.warn('[City] 保存失敗:', e.message); }
}
function loadCity(){
  try{
    if(!fs.existsSync(CITY_FILE)) return null;
    const j=JSON.parse(fs.readFileSync(CITY_FILE,'utf8'));
    if(j.version!==1 || j.seed!==CITY_SEED || j.grid!==GRID){
      console.warn(`[City] ${CITY_FILE} は別の街 (version/seed/grid 不一致) → 新規生成`);
      return null;
    }
    return j;
  }catch(e){ console.warn('[City] 読み込み失敗:', e.message, '→ 新規生成'); return null; }
}
// まっさらな街。dayBase を「起動からの経過日数」ぶん引くので、稼働中に作り直しても
// 表示は Day 1 から始まる。
// 生成された「完成した街」を村に戻す。makeMap 自体は学習側と bit-identical で
// なければならないので触らず、**後処理として間引く**。
//   ・中心から離れた道路は草地へ (道はこれから踏み跡で生えてくる)
//   ・中心に近い建物を START_BUILDINGS 軒だけ残し、残りは空き地に
//   ・残す建物は全部 1x1 の低い建物に置き換える (高い建物は発展段階で解禁)
// 最初の街の構成。**先頭から順に必要なものが揃う**ように並べてある。
//   住む → 働く → 食べる → 買う → 治す。建物数が少なくても
//   「家・職場・飲食店」だけは必ず入るのが狙い。
const VILLAGE_ORDER = ['house','house','post','kiosk','house','ramen','conbini',
                       'house','cafe','pharmacy','house','bento','shop','house','gyudon'];
function villageMix(n){
  const T=name=>BLDG_NAME_TO_IDX[name];
  const mix=[];
  for(let i=0;i<n;i++) mix.push(T(VILLAGE_ORDER[i % VILLAGE_ORDER.length]));
  return mix;
}

function villageStart(map, structs, size){
  const lo=Math.floor((GRID-size)/2), hi=lo+size-1;
  const cr=(lo+hi)/2, cc=(lo+hi)/2;
  // 1) フィールドの外は VOID (まだ世界が無い)。中は建物をいったん全部さら地に。
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
    if(r<lo||r>hi||c<lo||c>hi) map[r][c]=VOID;
  for(const st of structs)
    for(let dr=0;dr<st.fp;dr++)for(let dc=0;dc<st.fp;dc++){
      const r=st.r+dr, c=st.c+dc;
      if(r<GRID && c<GRID && map[r][c]!==VOID) map[r][c]=OTHER;
    }
  // 2) フィールド内で中心に近い区画を選ぶ。元の建物跡を優先し、足りなければ
  //    道に面した空き地から補う (フィールドが小さいと元の建物が足りないため)。
  const cand=[];
  for(const st of structs) if(st.r>=lo&&st.r<=hi&&st.c>=lo&&st.c<=hi) cand.push([st.r,st.c]);
  const seen=new Set(cand.map(([r,c])=>r+'_'+c));
  for(let r=lo;r<=hi;r++)for(let c=lo;c<=hi;c++){
    if(map[r][c]!==OTHER || seen.has(r+'_'+c)) continue;
    const faces=MW.D4.some(([dr,dc])=>{
      const nr=r+dr, nc=c+dc;
      return nr>=lo&&nr<=hi&&nc>=lo&&nc<=hi&&map[nr][nc]===ROAD;
    });
    if(faces) cand.push([r,c]);
  }
  cand.sort((a,b)=>((a[0]-cr)**2+(a[1]-cc)**2)-((b[0]-cr)**2+(b[1]-cc)**2));
  const keep=cand.slice(0, Math.max(4, Math.min(START_BUILDINGS, cand.length)));
  const mix=villageMix(keep.length), out=[];
  keep.forEach(([r,c],i)=>{                   // 1x1 の低い建物として建て直す
    map[r][c]=BUILDING;
    out.push(newStruct(r, c, 1, mix[i], 0));
  });
  const names=out.map(x=>BLDG_TYPES[x.typeIdx].name);
  console.log(`[City] 村から開始: ${size}×${size} のフィールドに 建物${out.length}軒`
    + ` (住宅${names.filter(n=>n==='house').length} 職場${names.filter(n=>n==='post').length}`
    + ` 飲食${names.filter(n=>['kiosk','ramen','cafe','bento','gyudon'].includes(n)).length})`);
  return out;
}

// 需要の測り方が街の密度に合っているかを見るための日次診断 (永続化しない)
function freshDiag(){ return Object.fromEntries(CATS.map(c=>[c,{n:0,sum:0,far:0}])); }

function freshCity(){
  const size=START_VILLAGE ? Math.max(6, Math.min(GRID, Math.round(START_SIZE))) : GRID;
  let structs=planStructures(MAP);
  if(START_VILLAGE) structs=villageStart(MAP, structs, size);
  return {
    seed:CITY_SEED, dayBase:-daysSinceBoot(), bornAt:Date.now(),
    econ:0, level:0, pop:0, size,    // 経済活動の累計 / 発展段階 / 人口 / フィールドの一辺
    weather:'sunny', weatherUntil:0,
    structs,
    foot:new Int32Array(GRID*GRID),
    demand:Object.fromEntries(CATS.map(c=>[c,new Float32Array(GRID*GRID)])),
    unmet:Object.fromEntries(CATS.map(c=>[c,0])),
    stats:{roadsBorn:0,shopsOpened:0,shopsClosed:0,demolished:0},
    news:[], savedAgents:{}, diag:freshDiag(),
  };
}

// 蓄積を捨てて街を作り直す (newmap / /city?reset=1)。
//   keepMap=true は newmap 用 (呼び出し側が MAP を差し替え済み)。
//   それ以外は種から生成し直す (進化で書き換わった MAP を持ち越さない)。
function resetCity(keepMap){
  if(!keepMap) MAP=makeMap(GRID, CITY_SEED);
  CITY=freshCity();
  _lastDay=null;
  for(const a of agents){ a.owns=null; a.seenMask=0; a.unmetBy=null; }
  syncCity(); rebuildBuildings(MAP); groundDirty=true; saveCity();
  console.log(`[City] 街を作り直しました (建物${CITY.structs.length}軒)`);
}

function initCity(){
  const j=loadCity();
  if(j){
    MAP = j.map.map(row=>row.split('').map(Number));
    CITY = {
      seed:CITY_SEED, dayBase:j.day||0, bornAt:j.bornAt||Date.now(),
      econ:j.econ||0, level:j.level||0, pop:j.pop||0, size:j.size||GRID,
      weather:j.weather||'sunny', weatherUntil:0,
      structs:j.structs.map(st=>({...newStruct(st.r,st.c,st.fp,st.typeIdx,st.born), ...st})),
      foot:Int32Array.from(j.foot||[]),
      demand:Object.fromEntries(CATS.map(c=>[c, Float32Array.from((j.demand&&j.demand[c])||[])])),
      unmet:Object.assign(Object.fromEntries(CATS.map(c=>[c,0])), j.unmet||{}),
      stats:Object.assign({roadsBorn:0,shopsOpened:0,shopsClosed:0,demolished:0}, j.stats||{}),
      news:j.news||[], savedAgents:j.agents||{}, diag:freshDiag(),
    };
    if(CITY.foot.length!==GRID*GRID) CITY.foot=new Int32Array(GRID*GRID);
    for(const c of CATS) if(CITY.demand[c].length!==GRID*GRID) CITY.demand[c]=new Float32Array(GRID*GRID);
    const ago=Math.round((Date.now()-(j.savedAt||Date.now()))/60000);
    console.log(`[City] 復元: day=${CITY.dayBase} 建物${CITY.structs.length}軒 `
      + `(開店中${CITY.structs.filter(s=>s.state==='open').length}/閉店${CITY.structs.filter(s=>s.state==='closed').length}) `
      + `道${CITY.stats.roadsBorn}本 開業${CITY.stats.shopsOpened} 閉店${CITY.stats.shopsClosed} — ${ago}分前の保存`);
  }else{
    CITY = freshCity();
    console.log(`[City] 新しい街を生成: 建物${CITY.structs.length}軒`);
  }
  // 工事中のまま保存された建物は、落ちていた間に完成したものとして開業させる
  for(const st of CITY.structs) if(st.state==='construction' && st.doneAt && st.doneAt<Date.now()) st.state='open';
  // 取り壊しアニメの途中で保存された建物は閉店状態に戻す (翌日また取り壊される)
  for(const st of CITY.structs) if(st.state==='demolishing') st.state='closed';
  syncCity();
  rebuildBuildings(MAP);
  const L=levelSpec();
  console.log(`[City] 発展段階 ${cityLevel()}:${L.name} (高さ≤${L.maxH} 2x2:${L.fp2?'可':'不可'}) `
    + `経済 ${Math.round(CITY.econ)} / 建てられる業種 `
    + BUILD_CATS.map(c=>`${c}=${foundableTypes(c).length}`).join(' '));
}

// 指定タイプ群の建物セル一覧。**営業中 (state='open') の建物だけ**を返す。
//   工事中の建物と閉店した建物は目的地に選ばれない (BUILDING_TYPES は見た目/
//   レイキャスト用に全建物ぶん入っているので、状態は struct 側で判定する)。
function buildingsOfTypes(idxs){
  const set=new Set(idxs);
  return BUILDINGS.filter(b=>{
    const st=structAt(b[0],b[1]);
    return st && st.state==='open' && set.has(st.typeIdx);
  });
}

// ── 住居と職場の定員 ────────────────────────────────────────────────────────
//   人口の上限は住居の定員で決まる。**家が建つと人が増える**という因果をここで作る。
const cellKey   = b => b ? b[0]+'_'+b[1] : '';
const homeCapOf = t => (t===IDX_OF('apartment') ? APT_CAP : HOUSE_CAP);
const openStructsOf = idxs => (CITY?CITY.structs:[])
  .filter(st=>st.state==='open' && idxs.includes(st.typeIdx));
function housingCapacity(){
  let n=0; for(const st of openStructsOf(HOME_IDX)) n+=homeCapOf(st.typeIdx); return n;
}
function workplaceCapacity(){ return openStructsOf(WORK_IDX).length * WORK_CAP; }

// 拠点(自宅/職場)の割当。**既に住んでいる人はそのまま**で、空きのある建物へ順に入れる。
//   以前は index で機械的に割り当てていたので、家が1軒建つたびに全員の住所がずれた。
//   人口が増減する街ではそれでは「引っ越してきた」が成立しない。
function assignHomes(){
  const okHome=b=>{ const st=b&&structAt(b[0],b[1]); return st&&st.state==='open'&&HOME_IDX.includes(st.typeIdx); };
  const okWork=b=>{ const st=b&&structAt(b[0],b[1]); return st&&st.state==='open'; };
  const occ={}, wocc={};
  for(const a of agents){
    if(a.home && !okHome(a.home)) a.home=null;
    if(a.home) occ[cellKey(a.home)]=(occ[cellKey(a.home)]||0)+1;
    if(a.owns) a.work=[...a.owns];                       // 店主は自分の店が職場
    else if(a.work && !okWork(a.work)) a.work=null;
    if(a.work && !a.owns) wocc[cellKey(a.work)]=(wocc[cellKey(a.work)]||0)+1;
  }
  const homeStructs=openStructsOf(HOME_IDX), workStructs=openStructsOf(WORK_IDX);
  const take=(list, table, capOf)=>{
    let spill=null, spillN=Infinity;
    for(const st of list){
      const k=st.r+'_'+st.c, n=table[k]||0;
      if(n < capOf(st.typeIdx)){ table[k]=n+1; return [st.r,st.c]; }
      if(n < spillN){ spillN=n; spill=st; }
    }
    // 全部満室でも路頭に迷わせない。ただし先頭に詰め込まず、いちばん空いている所へ。
    if(!spill) return null;
    const k=spill.r+'_'+spill.c; table[k]=(table[k]||0)+1;
    return [spill.r, spill.c];
  };
  for(const a of agents){
    if(!a.home) a.home=take(homeStructs, occ, homeCapOf);
    if(!a.work) a.work=take(workStructs, wocc, ()=>WORK_CAP);
  }
  const homeless=agents.reduce((n,a)=>n+(a.home?0:1),0);
  const over=Math.max(0, agents.length-housingCapacity());
  console.log(`[Life] 拠点: 人口${agents.length} / 住居${homeStructs.length}軒(定員${housingCapacity()})`
    + ` / 職場${workStructs.length}件(定員${workplaceCapacity()})`
    + (over?` ⚠ 定員超過${over}人`:'') + (homeless?` ⚠ 家なし${homeless}人`:''));
}

// 欲求が切り替わった wander エージェントの行き先を選び直す。
//   これが無いと「夜になっても昼に決めた遠い目的地へ歩き続ける」→ 帰宅できず疲労が飽和する。
//   navigate(rally) 中は命令優先なので触らない。
function retargetOnNeedChange(){
  for(const a of agents){
    const n=needOf(a);
    if(n===a.lastNeed) continue;
    a.lastNeed=n;
    if(a.mode==='wander'){
      const g=pickLifeGoal(a,[Math.floor(a.x),Math.floor(a.y)]);
      a.gx=g[0]+0.5; a.gy=g[1]+0.5;
    }
  }
}

// 内部状態を進める (1秒ごと)。到着していれば回復させる。
function stepNeeds(dtSec){
  const h=gameHour();
  const night = (h<6 || h>=22);
  for(const a of agents){
    a.hunger  = Math.min(1, (a.hunger ||0) + HUNGER_RATE *dtSec);
    // 夜は疲れやすい / 自宅に居るときは休息
    // 雨の日は外を歩くと疲れる (屋内は影響しない)
    a.fatigue = Math.min(1, (a.fatigue||0) + FATIGUE_RATE*dtSec*(night?1.6:1.0)
                            *(MW.isIndoors(a)?1:weatherNow().fatigue));
    a.supply  = Math.min(1, (a.supply ||0) + SUPPLY_RATE *dtSec);
    // 退屈は「一人でいる時間」で溜まる → 近くに人が居れば溜まらない (社交と連動)
    let alone=true;
    for(const o of agents){ if(o===a) continue;
      if(Math.abs(o.x-a.x)<3 && Math.abs(o.y-a.y)<3){ alone=false; break; } }
    a.bored = Math.min(1, Math.max(0, (a.bored||0) + BORED_RATE*dtSec*(alone?1:-1.5)));
    // 病気: 低確率で発症。疲労が高いほどかかりやすい (内部状態同士の因果)
    if(!(a.sick>0) && Math.random() < SICK_PROB*dtSec*(1+(a.fatigue||0)))
      a.sick = 0.6 + Math.random()*0.4;

    // 屋内なら「その建物の中に居る」ので、自分のセルではなく屋内の建物で判定する。
    const r=Math.floor(a.x), c=Math.floor(a.y);
    const t = MW.isIndoors(a) ? BUILDING_TYPES[a.indoors[0]+'_'+a.indoors[1]]
                             : BUILDING_TYPES[r+'_'+c];
    if(t!=null){
      if(FOOD_IDX.includes(t)) a.hunger = Math.max(0, a.hunger - EAT_RECOVER*dtSec);
      if(BUY_IDX.includes(t))  a.supply = Math.max(0, a.supply - BUY_RECOVER*dtSec);
      if(FUN_IDX.includes(t))  a.bored  = Math.max(0, a.bored  - FUN_RECOVER*dtSec);
    }
    // 病院/薬局は隣接でも受診とみなす (建物セル中心に完全に乗れず治らないのを防ぐ)
    if((a.sick||0) > 0){
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
        const tt=BUILDING_TYPES[(r+dr)+'_'+(c+dc)];
        if(tt!=null && CARE_IDX.includes(tt)){ a.sick = Math.max(0, a.sick - SICK_HEAL*dtSec); dr=dc=2; }
      }
    }
    // 自宅は「そのセル or 隣接」で休息とみなす (建物セル中心へ完全に乗らなくても帰宅扱い)
    if(a.home && Math.abs(r-a.home[0])<=1 && Math.abs(c-a.home[1])<=1)
      a.fatigue = Math.max(0, a.fatigue - SLEEP_RECOVER*dtSec);
    else if(!a.home && t!=null && HOME_IDX.includes(t))
      a.fatigue = Math.max(0, a.fatigue - SLEEP_RECOVER*dtSec);   // 家なしは住居に居れば休める

    // ── 需要 = 「不満 × 遠さ」の積分 ──────────────────────────────────────
    //   近くに店があるのに空腹なのは供給不足ではない。**遠いのに欲しい**時間だけを
    //   足し込む。同時に「どこで不満だったか」をヒートマップに落とし、起業の立地に使う。
    if(CITY_EVOLVE && CITY && !MW.isIndoors(a)){
      const cat=NEED_CAT[needOf(a)];
      if(cat){
        const d=nearestCatDist(a, cat);   // 該当が街に1軒も無ければ Infinity → 重み1
        const w=Math.max(0, Math.min(1, (d-DEMAND_D_OK)/(DEMAND_D_FAR-DEMAND_D_OK)));
        // 診断: 閾値 (D_OK/D_FAR) が街の密度に合っているかを毎日ログで確認できるように
        const dg=CITY.diag[cat]; dg.n++; dg.sum+=Math.min(d,99); if(w>0) dg.far++;
        if(w>0){
          CITY.unmet[cat]+=w*dtSec;
          if(!a.unmetBy) a.unmetBy={};
          a.unmetBy[cat]=(a.unmetBy[cat]||0)+w*dtSec;
          if(r>=0&&r<GRID&&c>=0&&c<GRID) CITY.demand[cat][r*GRID+c]+=w*dtSec;
        }
      }
    }
  }
}

// 屋内から出るべきか。needOf() が示す用事と、いま居る建物が合っているかで決める。
//   自宅で寝ている間は sleep が解消するまで出ない。飲食店で食べ終えたら出る。
//   用事が無い (need=null) なら出て徘徊する。
function shouldLeaveBuilding(a){
  if(!MW.isIndoors(a)) return true;
  const [br,bc]=a.indoors;
  const t=BUILDING_TYPES[br+'_'+bc];
  const n=needOf(a);
  if(n===null) return true;                                   // 用事なし → 外へ
  if(n==='sleep') return a.home ? !(br===a.home[0] && bc===a.home[1])
                                : !HOME_IDX.includes(t);   // 家なしは住居なら留まる
  if(n==='work')  return !(a.work && br===a.work[0] && bc===a.work[1]);
  if(t==null) return true;
  if(n==='eat')   return !FOOD_IDX.includes(t);               // 飲食店に居るなら留まる
  if(n==='shop')  return !BUY_IDX.includes(t);
  if(n==='bored') return !FUN_IDX.includes(t);
  if(n==='sick')  return !CARE_IDX.includes(t);
  return true;
}

// いま何を求めているか (アイコン表示と目的地抽選で共用)
//   優先順位: 病気 > 睡眠 > 空腹 > 勤務 > 買い物 > 退屈 (生命に関わる順、最後は暇つぶし)
function needOf(a){
  const h=gameHour();
  if((a.sick   ||0) > SICK_HI)                 return 'sick';
  if((a.fatigue||0) > NEED_HI || h<6 || h>=22) return 'sleep';
  if((a.hunger ||0) > NEED_HI)                 return 'eat';
  if(h>=9 && h<17)                             return 'work';
  if((a.supply ||0) > NEED_HI)                 return 'shop';
  if((a.bored  ||0) > NEED_HI)                 return 'bored';
  return null;
}

// いま何をしているか (住民一覧ページ用)。既に到着済みなら「〜している」、移動中なら「〜へ向かっている」。
//   建物到着時の欲求回復 (stepNeeds) と同じ判定基準 (現在地/隣接の建物カテゴリ) を使う。
function describeActivity(a){
  const r=Math.floor(a.x), c=Math.floor(a.y);
  const t=BUILDING_TYPES[r+'_'+c];
  const near=(idxList)=>{
    for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
      const tt=BUILDING_TYPES[(r+dr)+'_'+(c+dc)];
      if(tt!=null && idxList.includes(tt)) return true;
    }
    return false;
  };
  const atHome = a.home && Math.abs(r-a.home[0])<=1 && Math.abs(c-a.home[1])<=1;
  const atWork = a.work && Math.abs(r-a.work[0])<=1 && Math.abs(c-a.work[1])<=1;
  const h=gameHour();

  if((a.sick||0)>0 && near(CARE_IDX)) return '🏥 病院・薬局で治療を受けている';
  if(t!=null && FOOD_IDX.includes(t)) return `${BLDG_TYPES[t].label} で食事をしている`;
  if(t!=null && BUY_IDX.includes(t))  return `${BLDG_TYPES[t].label} で買い物をしている`;
  if(t!=null && FUN_IDX.includes(t))  return `${BLDG_TYPES[t].label} で過ごしている`;
  if(atWork && h>=9 && h<17)          return '💼 職場で働いている';
  if(atHome)                          return '🏠 自宅で休んでいる';

  // 移動中: 目的地の建物と、その理由になっている欲求があれば添える
  const bldg = a.goalType!=null ? BLDG_TYPES[a.goalType] : null;
  const need = needOf(a);
  if(bldg && need) return `${bldg.label} へ向かっている（${NEED_LABEL_JA[need]}）`;
  if(bldg)         return `${bldg.label} の方へ歩いている`;
  return 'うろうろしている';
}

// 内部状態にもとづく目的地抽選。該当が無ければ従来のランダムに落とす。
// 最寄りの住居 (家が無い人の逃げ場)。
function nearestHome(a){
  const list=buildingsOfTypes(HOME_IDX);
  if(!list.length) return null;
  let best=null, bd=Infinity;
  for(const b of list){
    const d=(b[0]-a.x)**2+(b[1]-a.y)**2;
    if(d<bd){ bd=d; best=b; }
  }
  return best?[...best]:null;
}

function pickLifeGoal(a, ex){
  const n=needOf(a);
  if(n==='sleep'){
    // 家がある人は自宅へ。無い人は最寄りの住居へ (そこで休ませる)。
    // これが無いと、家なしの住民は疲労が 1.0 で飽和したまま永久に徘徊する。
    if(a.home) return [...a.home];
    const h=nearestHome(a); if(h) return h;
  }
  if(n==='work'  && a.work) return [...a.work];
  // 欲求 → 行き先カテゴリ。近い方から数軒のランダムで選ぶ (最寄り固定だと往復しやすい)
  const CAT={eat:FOOD_IDX, sick:CARE_IDX, shop:BUY_IDX, bored:FUN_IDX}[n];
  if(CAT){
    const f=buildingsOfTypes(CAT);
    if(f.length){
      f.sort((p,q)=>((p[0]-a.x)**2+(p[1]-a.y)**2)-((q[0]-a.x)**2+(q[1]-a.y)**2));
      const k = n==='sick' ? 2 : 4;                // 病気のときは近い所へ
      return [...f[Math.floor(Math.random()*Math.min(k,f.length))]];
    }
  }
  return randB(ex);
}

function randB(ex){for(let i=0;i<500;i++){const b=BUILDINGS[Math.floor(Math.random()*BUILDINGS.length)];if(!ex||Math.abs(b[0]-ex[0])>1||Math.abs(b[1]-ex[1])>1)return[...b];}return[...BUILDINGS[0]];}

// ═══ 街の進化: 日次の変化 ═══════════════════════════════════════════════════
// 変化はすべて dailyRollover() に集約する。1か所を読めば「今日この街に何が
// 起きうるか」が分かる状態を保つため。

const NEWS_MAX = 200;
const FIRST_NEWS_COOLDOWN_MS = envNum('FIRST_NEWS_COOLDOWN', 90)*1000;
let _lastFirstNews = 0;
let _lastDay = null;
let hudNewsDirty = false;

// text = 日本語 (ログ / API)、en = 配信画面のティッカー用の英語。
function news(kind, text, en){
  if(!CITY) return;
  CITY.news.push({t:Date.now(), day:gameDay(), kind, text, en:en||null});
  while(CITY.news.length>NEWS_MAX) CITY.news.shift();
  hudNewsDirty = true;
  console.log(`[News] Day${gameDay()+1} ${text}`);
}
// 天気はティッカーに流さない。日付板に常時出ているうえ、変化が多いので
// 街のできごと (開店/閉店/道/転入) を押し出してしまう。
const TICKER_SKIP = new Set(['weather']);
const latestNews = (n, forTicker) => {
  if(!CITY) return [];
  const src = forTicker ? CITY.news.filter(x=>!TICKER_SKIP.has(x.kind)) : CITY.news;
  return src.slice(-n);
};

// ── 機能A: 踏み跡が道になる ────────────────────────────────────────────────
// 絶対閾値ではなく「今日いちばん踏まれた空き地を N 本だけ道にする」日次ランキング。
// エージェント数や TICK が変わっても1日の変化量が一定に保たれ、
// 「毎朝2本ずつ道が伸びる」という配信のリズムにもなる。
function promoteFootpaths(day){
  const nearRoad=(r,c)=>MW.D4.some(([dr,dc])=>{
    const nr=r+dr, nc=c+dc;
    return nr>=0&&nr<GRID&&nc>=0&&nc<GRID&&MAP[nr][nc]===ROAD;
  });
  const cand=[];
  for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++){
    if(MAP[r][c]!==OTHER) continue;
    const f=CITY.foot[r*GRID+c];
    if(f<FOOT_MIN || !nearRoad(r,c)) continue;
    cand.push([f,r,c]);
  }
  cand.sort((a,b)=>b[0]-a[0]);
  let n=0;
  for(const [f,r,c] of cand){
    if(n>=ROAD_PER_DAY) break;
    MAP[r][c]=ROAD; CITY.foot[r*GRID+c]=0; n++; CITY.stats.roadsBorn++;
    // 道は道を呼ぶ: 周囲の踏み跡を持ち上げて、点ではなく線として伸びやすくする
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const nr=r+dr, nc=c+dc;
      if(nr<0||nr>=GRID||nc<0||nc>=GRID||MAP[nr][nc]!==OTHER) continue;
      CITY.foot[nr*GRID+nc]=Math.floor(CITY.foot[nr*GRID+nc]*1.5);
    }
  }
  // 昇格しなかったぶんは減衰。これが無いと「たまたま1回横断した」が何週間もかけて
  // 積み上がり、いずれ空き地が全部道路になる。
  for(let i=0;i<CITY.foot.length;i++) CITY.foot[i]=Math.floor(CITY.foot[i]*FOOT_DECAY);
  if(n){
    groundDirty=true;
    // 道が増えると、それまで空き地の奥で孤立していた建物が到達可能になることがある
    rebuildBuildings(MAP);
    news('road', `🛣 よく踏まれた空き地が道になった (${n}本)`,
         `Footpaths turned into ${n} new road${n>1?'s':''}`);
  }
  return n;
}

// ── 機能B: 足りない業種を住民が起業する ────────────────────────────────────
function nearestCatDist(a, cat){
  const list=catBuildings(cat);
  if(!list.length) return Infinity;              // 街に1軒も無い = 需要は最大
  let best=Infinity;
  for(const [r,c] of list){
    const d=Math.hypot(r-a.x, c-a.y);
    if(d<best) best=d;
  }
  return best;
}

// 通行可能領域 (最大連結成分) のセル数。建てる前後で比べて分断を検出する。
function passableCount(map){
  const comp=MW.largestComponent(MW.passableMask(map, WORLD));
  let n=0; for(const row of comp) for(const v of row) if(v) n++;
  return n;
}
// 未充足需要のヒートマップ。商売はこれがいちばん濃い所に建つ。
function siteScoreDemand(cat, r, c){
  const D=CITY.demand[cat];
  if(!D) return 0;
  let s=D[r*GRID+c]*2;
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    const nr=r+dr, nc=c+dc;
    if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
    s+=D[nr*GRID+nc]*0.5;
  }
  return s;
}
// 住居と職場は「欲求」ではないのでヒートマップが無い。人が通る所 (踏み跡) と
// 既存の建物の隣を好む = 街が虫食いにならず塊として広がる。
function siteScoreGeneric(r, c){
  let s=0;
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    const nr=r+dr, nc=c+dc;
    if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
    s += CITY.foot[nr*GRID+nc]*0.02;
    if(MAP[nr][nc]===BUILDING) s += 6;
  }
  return s;
}

const blockFree=(r,c,fp)=>{
  for(let dr=0;dr<fp;dr++)for(let dc=0;dc<fp;dc++){
    const nr=r+dr, nc=c+dc;
    if(nr>=GRID||nc>=GRID||MAP[nr][nc]!==OTHER) return false;
  }
  return true;
};
// 道に面している、または既存の建物に接している区画だけに建てる。
//   村のうちは道が中心にしか無いので、「建物の隣」も許さないと街が広がれない。
const facesRoadOrBuilding=(r,c,fp)=>{
  for(let dr=0;dr<fp;dr++)for(let dc=0;dc<fp;dc++)
    for(const [ar,ac] of MW.D4){
      const nr=r+dr+ar, nc=c+dc+ac;
      if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
      if(MAP[nr][nc]===ROAD || MAP[nr][nc]===BUILDING) return true;
    }
  return false;
};
// fp×fp を建てても街が分断されないか。唯一の通路を塞ぐと、片側の住民が永久に
// 経路を引けなくなって足踏みし続ける。BFS 2回 = 900セル、1日数回なので安い。
// 「最大連結成分がちょうど fp*fp セル減った」= 誰も孤立していない。
function canBuildFootprint(r,c,fp){
  if(!WORLD.solidBuildings) return true;
  const before=passableCount(MAP);
  for(let dr=0;dr<fp;dr++)for(let dc=0;dc<fp;dc++) MAP[r+dr][c+dc]=BUILDING;
  const after=passableCount(MAP);
  for(let dr=0;dr<fp;dr++)for(let dc=0;dc<fp;dc++) MAP[r+dr][c+dc]=OTHER;
  return after===before-fp*fp;
}

// 立地選定。scoreFn(r,c) が大きいほど良い立地。
//   踏み跡機能と組み合わさると 道ができる→人が通る→店ができる→さらに人が通る が回る。
function pickSite(day, fp, scoreFn){
  let best=null;
  // 1) 閉店した跡地を優先する。連結性チェックが要らず、「跡地にまた建つ」絵も強い。
  for(const st of CITY.structs){
    if(st.state!=='closed' || st.fp!==fp) continue;
    if(day-(st.closedDay==null?0:st.closedDay) < 1) continue;
    const sc=scoreFn(st.r, st.c);
    if(!best || sc>best.score) best={reuse:st, r:st.r, c:st.c, fp, score:sc};
  }
  // 2) 空き区画
  const lots=[];
  for(let r=0;r+fp<=GRID;r++)for(let c=0;c+fp<=GRID;c++){
    if(!blockFree(r,c,fp) || !facesRoadOrBuilding(r,c,fp)) continue;
    lots.push({r,c,score:scoreFn(r,c)});
  }
  lots.sort((a,b)=>b.score-a.score);
  for(const lot of lots.slice(0,12)){
    if(best && best.score>=lot.score) break;     // 跡地のほうが良ければそれを使う
    if(!canBuildFootprint(lot.r,lot.c,fp)) continue;   // 街を分断する場所は捨てる
    return {reuse:null, r:lot.r, c:lot.c, fp, score:lot.score};
  }
  return best;
}

// 業種の選択: **街にいちばん少ないもの**を選ぶ。発展段階で解禁された新種は必ず0軒なので、
// 解禁された瞬間にそれが建つ = 街が育つほど建物の種類が増えていく。
function pickTypeFor(cat){
  const types=foundableTypes(cat);
  if(!types.length) return null;
  const count={}; for(const t of types) count[t]=0;
  for(const st of CITY.structs) if(st.state!=='gone' && (st.typeIdx in count)) count[st.typeIdx]++;
  let min=Infinity; for(const t of types) min=Math.min(min, count[t]);
  const pool=types.filter(t=>count[t]===min);
  return pool[Math.floor(Math.random()*pool.length)];
}

// 起業者 = 「自分が一番困っていて、かつ性格的に動く人」。1人1軒まで。
function pickFounder(cat){
  let best=null, bestScore=0;
  for(const a of agents){
    if(a.owns) continue;
    const sc=((a.def&&a.def.enterprise)||0) * ((a.unmetBy&&a.unmetBy[cat])||0);
    if(sc>bestScore){ bestScore=sc; best=a; }
  }
  if(best) return best;
  // 誰も不満を溜めていない場合 (強制発火や起動直後) は起業性向で重み付け抽選する。
  // 「誰かが建てた」より「Cole が建てた」のほうがニュースとして強いので、
  // 店主なしにはしない。
  const pool=agents.filter(a=>!a.owns && ((a.def&&a.def.enterprise)||0)>0);
  if(!pool.length) return null;
  let sum=0; for(const a of pool) sum+=a.def.enterprise;
  let r=Math.random()*sum;
  for(const a of pool){ r-=a.def.enterprise; if(r<=0) return a; }
  return pool[0];
}

function foundShop(cat, site, typeIdx, founder, day){
  const fp=site.fp||1;
  let st;
  if(site.reuse){                     // 跡地の再利用
    st=site.reuse;
    st.typeIdx=typeIdx; st.born=day; st.visits=0; st.visitsToday=0; st.ema=0;
    st.firstCustomer=null; st.closedDay=null;
  }else{
    for(let dr=0;dr<fp;dr++)for(let dc=0;dc<fp;dc++) MAP[site.r+dr][site.c+dc]=BUILDING;
    st=newStruct(site.r, site.c, fp, typeIdx, day);
    CITY.structs.push(st);
    groundDirty=true;
  }
  st.state='construction';
  st.founded=true;                    // 住民が建てた店 (創世からある建物と区別する)
  // 工事中はゲーム内 CONSTRUCT_HOURS 時間。即座にポップさせないのは、
  // カメラが寄る口実になり「街が育っている」ことが伝わるため。
  st.doneAt=Date.now() + CONSTRUCT_HOURS*(DAY_MINUTES*60/24)*1000;
  st.openedBy=founder?founder.aid:null;
  if(founder){ founder.owns=[st.r,st.c]; founder.work=[st.r,st.c]; if(founder.unmetBy) founder.unmetBy[cat]=0; }
  syncCity();
  rebuildBuildings(MAP);              // 新しい建物セルを目的地候補に入れる
  addStructMesh(scene, st);
  // 需要を「消費」する。開店後はその一帯の人が D_OK 以内に店を持つので新たな需要は
  // 積もらないが、**過去に積んだ熱は減衰待ちで残る**。消さないと同じ場所が数日
  // 連続で最大スコアになり、隣に同種の店が建ち続ける (実測: 2日で薬局2軒)。
  const D=CITY.demand[cat];
  if(D){
    for(let dr=-3;dr<=3;dr++)for(let dc=-3;dc<=3;dc++){
      const nr=st.r+dr, nc=st.c+dc;
      if(nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
      D[nr*GRID+nc]=0;
    }
    CITY.unmet[cat]*=0.4;             // 不満が解消に向かったぶんを差し引く
  }
  const label=BLDG_TYPES[typeIdx].label;
  const enLabel=enOf(typeIdx);
  news('build', founder
    ? `🚧 ${founder.name} が ${CAT_LABEL[cat]} の不足を見て ${label} を建てはじめた (${st.r},${st.c})`
    : `🚧 ${CAT_LABEL[cat]} が足りなくなり ${label} の工事が始まった (${st.r},${st.c})`,
    founder ? `${founder.name} started building a ${enLabel} (short of ${CAT_EN[cat]})`
            : `New ${enLabel} under construction (short of ${CAT_EN[cat]})`);
  // 工事の箱が地面からせり上がり、その現場をカメラが映す。
  //   以前は起業者本人にカメラを向けていたが、本人は街のどこかに居るので
  //   肝心の工事現場が映らなかった。
  showCityEvent(st.r, st.c, `${enLabel} - construction started`, null, {st, kind:'rise'});
  return st;
}

// カテゴリを1つ建てる。建てられたら struct、無理なら null。
function foundCategory(cat, day){
  const typeIdx=pickTypeFor(cat);
  if(typeIdx==null) return null;
  const fp=BLDG_TYPES[typeIdx].footprint;
  const isNeed=CATS.includes(cat);
  const scoreFn=isNeed ? ((r,c)=>siteScoreDemand(cat,r,c)+siteScoreGeneric(r,c)*0.2)
                       : ((r,c)=>siteScoreGeneric(r,c));
  const site=pickSite(day, fp, scoreFn);
  if(!site) return null;
  // 店主が付くのは商売だけ。住宅や職場に「店主」を付けると、その住民の勤務先が
  // 住宅になってしまう (owns = 職場という扱いのため)。
  const founder=isNeed ? pickFounder(cat) : null;
  return foundShop(cat, site, typeIdx, founder, day);
}

// 1日ぶんの「1軒」を決める。優先順位は 住むところ → 働くところ → 商売。
//   住居が足りないと人口が頭打ちになり、職場が足りないと働き口が無くなるので、
//   生活の器のほうを先に建てる。商売は「未充足の需要が濃い場所」があるときだけ。
function maybeFound(day){
  const daySec=DAY_MINUTES*60;
  const pop=agents.length;
  const hcap=housingCapacity(), wcap=workplaceCapacity();
  let workers=0; for(const a of agents) if(!a.owns) workers++;

  if(pop >= hcap*HOME_PRESSURE && foundableTypes('home').length){
    if(foundCategory('home', day)){
      console.log(`[City] 住居が不足 (人口${pop}/定員${hcap}) → 住むところを建てた`);
      return 1;
    }
  }
  if(workers >= wcap*WORK_PRESSURE && foundableTypes('work').length){
    if(foundCategory('work', day)){
      console.log(`[City] 働き口が不足 (勤め人${workers}/定員${wcap}) → 働くところを建てた`);
      return 1;
    }
  }
  // 商売: 需要がいちばん濃い場所のスコアで発火を決める
  let best=null;
  const parts=[];
  for(const cat of CATS){
    const dg=CITY.diag[cat];
    const avg=dg.n?(dg.sum/dg.n):0;
    const types=foundableTypes(cat);
    const site=types.length ? pickSite(day, 1, (r,c)=>siteScoreDemand(cat,r,c)) : null;
    const score=site?site.score/daySec:0;               // agent-day 単位
    parts.push(`${cat}:${score.toFixed(2)}(${catCount(cat)}軒 最寄り平均${avg.toFixed(1)}c 遠い${dg.n?Math.round(dg.far/dg.n*100):0}%)`);
    if(site && (!best || score>best.score)) best={cat, score};
  }
  const L=levelSpec();
  console.log(`[City] 起業の圧 ${parts.join(' ')} | 発火 ${FOUND_SITE} agent-day`
    + ` | 人口${pop}/定員${hcap} 勤め人${workers}/定員${wcap} | ${L.name}(高さ≤${L.maxH}${L.fp2?' 2x2可':''})`);
  if(!best || best.score<FOUND_SITE) return 0;
  return foundCategory(best.cat, day) ? 1 : 0;
}

// ── フィールドの拡張 ────────────────────────────────────────────────────────
//   街は GRID×GRID の内側の正方形だけを使う。**土地が足りなくなったら1リング広げる**。
//   最初から広い野原があると「木しか無い場所」が目立つので、必要になってから現れる形にした。
function buildableLots(){
  const lo=fieldLo(), hi=fieldHi();
  let n=0;
  for(let r=lo;r<=hi;r++)for(let c=lo;c<=hi;c++)
    if(MAP[r][c]===OTHER && facesRoadOrBuilding(r,c,1)) n++;
  return n;
}

// フィールドに占める建物セルの割合
function fieldDensity(){
  const lo=fieldLo(), hi=fieldHi();
  let n=0;
  for(let r=lo;r<=hi;r++)for(let c=lo;c<=hi;c++) if(MAP[r][c]===BUILDING) n++;
  return n/(fieldSize()*fieldSize());
}

function maybeExpand(day){
  if(!CITY || CITY.size>=GRID) return 0;
  const free=buildableLots(), dens=fieldDensity();
  if(dens<EXPAND_DENSITY && free>EXPAND_FREE) return 0;
  const base=makeMap(GRID, CITY.seed);        // 元の地形 (種から決定的に再生成できる)
  const oldLo=fieldLo(), oldHi=fieldHi();
  CITY.size=Math.min(GRID, CITY.size+EXPAND_STEP);
  const lo=fieldLo(), hi=fieldHi();
  let trees=0;
  for(let r=lo;r<=hi;r++)for(let c=lo;c<=hi;c++){
    if(r>=oldLo&&r<=oldHi&&c>=oldLo&&c<=oldHi) continue;   // 既存部分は触らない
    // 新しい土地は草地。元の地形の木を間引いて少しだけ生やす (一面の林にしない)
    const wantTree = base[r][c]===TREE && EXPAND_TREES>0 && ((r*7+c*13)%EXPAND_TREES===0);
    MAP[r][c]= wantTree ? TREE : OTHER;
    if(wantTree){ addTreeMesh(scene, r, c); trees++; }
  }
  groundDirty=true;
  rebuildBuildings(MAP);
  console.log(`[City] フィールド拡張 ${oldHi-oldLo+1} → ${CITY.size}`
    + ` (建て込み ${(dens*100).toFixed(0)}% / 空き区画${free} / 木+${trees})`);
  news('expand', `🌱 街の範囲が広がった (${CITY.size}×${CITY.size})`,
       `The land expanded to ${CITY.size}x${CITY.size}`);
  showCityEvent(Math.round((lo+hi)/2), Math.round((lo+hi)/2),
    `The land expanded to ${CITY.size}x${CITY.size}`, 9, null, {wide:true});
  return 1;
}

// ── 転入 ────────────────────────────────────────────────────────────────────
//   住居の定員に空きがあるぶんだけ人が増える。**家が建つ → 人が来る → 需要が増える →
//   店が建つ → 経済が回る → 高い建物が解禁される** の輪をここで閉じる。
function growPopulation(day){
  if(!scene || !CITY) return 0;
  const cap=Math.min(NUM_AGENTS, housingCapacity());
  const room=cap-agents.length;
  if(room<=0) return 0;
  const n=Math.max(1, Math.min(room, MOVEIN_MAX, Math.ceil(agents.length*POP_GROWTH)));
  const base=agents.length;
  for(let k=0;k<n;k++) spawnAgent(scene, base+k);
  assignHomes();
  for(let k=0;k<n;k++) settleAgent(agents[base+k]);
  CITY.pop=agents.length;
  news('pop', `🚶 ${n}人が引っ越してきた (人口 ${agents.length} / 住居の定員 ${cap})`,
       `${n} resident${n>1?'s':''} moved in (pop ${agents.length})`);
  return n;
}

// 工事の完了 (1秒ごとに確認)。落ちている間に完了予定を過ぎたぶんもここで開く。
function finishConstruction(){
  if(!CITY) return;
  const now=Date.now();
  for(const st of CITY.structs){
    if(st.state!=='construction' || !st.doneAt || now<st.doneAt) continue;
    st.state='open'; st.doneAt=null;
    CITY.stats.shopsOpened++;
    syncCity(); addStructMesh(scene, st);
    const owner=st.openedBy?agents.find(a=>a.aid===st.openedBy):null;
    const label=BLDG_TYPES[st.typeIdx].label;
    const enLabel=enOf(st.typeIdx);
    news('open', `${label} が開店しました (${st.r},${st.c})`
      + (owner?` — 店主 ${owner.name}`:''),
      `${enLabel} opened` + (owner?` - run by ${owner.name}`:''));
    // 工事の箱と入れ替わりに、本物の建物が地面からせり上がる
    showCityEvent(st.r, st.c, `${enLabel} was built` + (owner?` by ${owner.name}`:''),
                  null, {st, kind:'rise'});
  }
}

// ── 機能C: 店の盛衰 ────────────────────────────────────────────────────────
function rolloverVisits(){
  for(const st of CITY.structs){
    if(st.state==='open') st.ema = st.ema*0.7 + st.visitsToday*0.3;
    st.visitsToday=0;
  }
}
const catOfType = t => CATS.find(c => (CAT_IDX[c]||[]).includes(t));

function closeShop(st, day){
  st.state='closed'; st.closedDay=day; st.ema=0;
  CITY.stats.shopsClosed++;
  syncCity(); addStructMesh(scene, st);
  const label=BLDG_TYPES[st.typeIdx].label;
  for(const a of agents){
    if(a.owns && a.owns[0]===st.r && a.owns[1]===st.c){
      a.owns=null;                                  // 店主は職を失い、また勤め人に戻る
      const works=buildingsOfTypes(WORK_IDX);
      a.work = works.length ? [...works[Math.floor(Math.random()*works.length)]] : null;
      news('close', `🚪 ${a.name} の ${label} が閉店しました (${st.r},${st.c})`,
           `${a.name}'s ${enOf(st.typeIdx)} closed down`);
      showCityEvent(st.r, st.c, `${a.name}'s ${enOf(st.typeIdx)} closed down`, 7);
      return;
    }
  }
  news('close', `🚪 ${label} (${st.r},${st.c}) が閉店しました`, `${enOf(st.typeIdx)} closed down`);
  showCityEvent(st.r, st.c, `${enOf(st.typeIdx)} closed down`, 7);
}

// 閉店の判定は「同業の平均と比べて客が来ていない店」。絶対値だとエージェント数で
// 意味が変わって調整不能になる (踏み跡を日次ランキングにしたのと同じ理由)。
//   中央値ではなく平均を使う: 店数がエージェント数に対して多いと半数以上が来客ゼロで
//   中央値が 0 になり、`ema < 中央値×0.25` が永久に成立しなくなる (= 一軒も潰れない)。
//   平均なら「誰かが来ている限り」死に店を拾える。逆に来客が均等に散っていれば
//   平均の 25% を下回る店が無くなり、閉店は自然に止まる。
function maybeClose(day){
  const open=CITY.structs.filter(st=>st.state==='open' && isClosable(st.typeIdx));
  const cands=open.filter(st=>(day-st.born)>=GRACE_DAYS && catCount(catOfType(st.typeIdx))>MIN_PER_CAT);
  if(!cands.length) return 0;
  cands.sort((a,b)=>a.ema-b.ema);
  let closed=0;
  for(const st of cands){
    if(closed>=CLOSE_PER_DAY) break;
    const cat=catOfType(st.typeIdx);
    const peers=open.filter(o=>catOfType(o.typeIdx)===cat).map(o=>o.ema);
    const mean=peers.length?peers.reduce((x,y)=>x+y,0)/peers.length:0;
    if(mean<=0 || st.ema>=mean*CLOSE_FRAC) continue;
    closeShop(st, day); closed++;
  }
  return closed;
}

// 閉店したまま DEMOLISH_DAYS 経った建物は取り壊して空き地に戻す。
// また誰かが建てられる = 建物のレベルで生死が回る。
// 取り壊しは「沈みきってから」地面と一覧を書き換える。先に空き地にしてしまうと
// 建物がまだ立っているのに人がすり抜けて見える。
function finishDemolish(st){
  for(let dr=0;dr<st.fp;dr++)for(let dc=0;dc<st.fp;dc++){
    if(st.r+dr<GRID && st.c+dc<GRID) MAP[st.r+dr][st.c+dc]=OTHER;
  }
  removeStructMesh(scene, st);
  st.state='gone';
  CITY.structs=CITY.structs.filter(x=>x.state!=='gone');
  syncCity(); rebuildBuildings(MAP); groundDirty=true;
}

function maybeDemolish(day){
  let n=0;
  for(const st of CITY.structs){
    if(st.state!=='closed' || st.closedDay==null) continue;
    if(day-st.closedDay < DEMOLISH_DAYS) continue;
    const label=BLDG_TYPES[st.typeIdx].label;
    st.state='demolishing';        // 目的地には選ばれない / まだ通行不可のまま
    n++; CITY.stats.demolished++;
    news('demolish', `${label} (${st.r},${st.c}) が取り壊されて空き地になった`,
         `${enOf(st.typeIdx)} was demolished`);
    showCityEvent(st.r, st.c, `${enOf(st.typeIdx)} is gone`, null,
                  {st, kind:'sink', onDone:()=>finishDemolish(st)});
  }
  return n;
}

// ── 機能D: 初回性 ──────────────────────────────────────────────────────────
// 到着 = 来客。建物「タイプ」の初訪問だけを事件にする (建物単位だと多すぎてニュースが安くなる)。
function onArrive(a, dest){
  a.trips++;
  if(!CITY_EVOLVE || !CITY || !dest) return;
  const st=structAt(dest[0], dest[1]);
  if(!st) return;
  if(st.state==='open'){
    st.visits++; st.visitsToday++;
    // 経済活動 = 店/施設への来店の累計。これが溜まると発展段階が上がる
    if(CLOSABLE_CATS.some(c=>(CAT_IDX[c]||[]).includes(st.typeIdx))) CITY.econ++;
    if(!st.firstCustomer){
      st.firstCustomer=a.aid;
      // 「最初の客」は店/施設だけ。住宅や職場に客は来ない (「住宅の最初の客」になってしまう)
      if(st.founded && CLOSABLE_CATS.some(c=>(CAT_IDX[c]||[]).includes(st.typeIdx)))
        news('first', `🎉 ${a.name} が新しい ${BLDG_TYPES[st.typeIdx].label} の最初の客になった`,
             `${a.name} is the first customer of the new ${enOf(st.typeIdx)}`);
    }
  }
  const bit=1<<st.typeIdx;                       // typeIdx < 25 なのでビット演算で足りる
  if(!((a.seenMask||0)&bit)){
    a.seenMask=(a.seenMask||0)|bit;
    if(st.state==='open' && Date.now()-_lastFirstNews>FIRST_NEWS_COOLDOWN_MS){
      _lastFirstNews=Date.now();
      news('first', `${a.name} が初めて ${BLDG_TYPES[st.typeIdx].label} に入った`,
           `${a.name} visited a ${enOf(st.typeIdx)} for the first time`);
    }
  }
}

// ── 日次のまとめ ───────────────────────────────────────────────────────────
function dailyRollover(day){
  if(!CITY || !CITY_EVOLVE) return;
  const t0=Date.now();
  rolloverVisits();                       // 先に EMA を更新してから閉店判定する
  const roads=promoteFootpaths(day);
  const grown=maybeExpand(day);           // 土地が足りなければ先にフィールドを広げる
  const closed=maybeClose(day);
  const gone=maybeDemolish(day);
  // 1日に建てられる軒数は人口に比例させる。人が増えるほど街が速く育つ (複利)。
  const budget=Math.max(1, Math.min(6, 1+Math.floor(agents.length/FOUND_PER_POP)));
  let opened=0;
  while(opened<budget && maybeFound(day)) opened++;
  const moved=growPopulation(day);              // 住居に空きがあれば人が引っ越してくる
  // 発展段階が上がったか (経済活動の累計で決まる)
  const lv=cityLevel();
  if(lv>(CITY.level||0)){
    CITY.level=lv;
    const L=CITY_LEVELS[lv];
    news('level', `🏙 この街は「${L.name}」になった (経済活動 ${Math.round(CITY.econ)})`,
         `This place is now a ${L.en} (economy ${Math.round(CITY.econ)})`);
    let sr=0, sc=0, n=0;
    for(const st of CITY.structs) if(st.state==='open'){ sr+=st.r; sc+=st.c; n++; }
    showCityEvent(n?Math.round(sr/n):GRID/2, n?Math.round(sc/n):GRID/2,
      `This place is now a ${L.en}`, 10, null, {wide:true});
  }
  // 需要の減衰。昨日の不満をいつまでも持ち越すと、供給が足りた後も起業が続く。
  for(const cat of CATS){
    CITY.unmet[cat]*=DEMAND_DECAY;
    const D=CITY.demand[cat];
    for(let i=0;i<D.length;i++) D[i]*=DEMAND_DECAY;
  }
  for(const a of agents) if(a.unmetBy) for(const k in a.unmetBy) a.unmetBy[k]*=DEMAND_DECAY;
  CITY.diag=freshDiag();
  const open=CITY.structs.filter(s=>s.state==='open').length;
  console.log(`[City] ═══ Day ${day+1} ═══ 道+${roads} 建設+${opened} 閉店+${closed} 取壊+${gone} 転入+${moved}`
    + `${grown?` 拡張→${CITY.size}`:''}`
    + ` | 人口${agents.length} 建物${CITY.structs.length}軒(営業${open}) ${levelSpec().name}(経済${Math.round(CITY.econ)})`
    + ` 累計 道${CITY.stats.roadsBorn}/開業${CITY.stats.shopsOpened}/閉店${CITY.stats.shopsClosed}`
    + ` (${Date.now()-t0}ms)`);
  saveCity();
}

// 1秒ごと: 日付の切り替わりを検出して日次処理を1回だけ走らせる + 工事の完了確認
function cityTick(){
  if(!CITY) return;
  stepWeather();
  const d=gameDay();
  if(_lastDay===null) _lastDay=d;
  else if(d!==_lastDay){ _lastDay=d; dailyRollover(d); }
  finishConstruction();
}

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
// アンスティック: これだけ足踏みしたら、方策の行動を上書きして「通れる向き」へ強制回避する。
//   反応型ポリシーが障害物に押し付けられて動けなくなるのを、決定論で救出する (再学習不要)。
//   通常移動中(stall小)は一切介入しないので、学習した挙動は保たれる。
const UNSTICK_STALL = 3;
// 詰まり対処の方式: 'release'=行き先を選び直す(既定) / 'steer'=通れる向きへ毎tick操舵。
const UNSTICK_MODE = (process.env.UNSTICK_MODE==='release') ? 'release' : 'steer';   // 既定steer (障害物を操舵回避)
// 移動の駆動方式: 既定は 'policy'。MOVE_MODE=pursuit で決定論の目的地追従へ戻せる。
// persona_multi.onnx または必要なDINOv2が無いペルソナは、モデル未配備時にランダム化せず
// stepAll() で pursuit へ安全フォールバックする。
//const MOVE_MODE = (process.env.MOVE_MODE==='pursuit') ? 'pursuit' : 'pursuit';
const MOVE_MODE = 'pursuit';
const PURSUIT_SUB = parseFloat(process.env.PURSUIT_SUB)||5;   // pursuit の per-tick 分割 (小=速い)。5→0.5セル/8°/tick
console.log(`[Move] mode=${MOVE_MODE} (missing model → pursuit fallback)`);

// policy と pursuit で「1tickあたりの歩幅」が違う点を起動時に明示する。
//   policy : fwdPerDecision / INFER_EVERY   (1意思決定を INFER_EVERY tick かけて消化)
//   pursuit: fwdPerDecision / PURSUIT_SUB   (毎tick再計算するので分割数が小さい)
// 変位/意思決定はどちらも学習時と同じだが、それを何tickかけて歩くかは別物。
// INFER_EVERY を学習の action_repeat より大きくすると、方策が完璧でも
// 見た目の歩行速度がその比だけ遅くなる (pursuit と比べて「鈍い」と感じる主因)。
function logMoveCadence(){
  const meta=personaMeta[PERSONA_DEFS[0] && PERSONA_DEFS[0].id];
  const fwd=(meta&&meta.fwdPerDecision)||FWD_PER_DECISION_DEF;
  const ar=(meta&&meta.actionRepeat)||null;
  const pol=(fwd/INFER_EVERY).toFixed(3), pur=(fwd/PURSUIT_SUB).toFixed(3);
  console.log(`[Move] 歩幅/tick: policy=${pol} (INFER_EVERY=${INFER_EVERY}) / pursuit=${pur} (PURSUIT_SUB=${PURSUIT_SUB})`);
  if(ar && INFER_EVERY!==ar){
    console.warn(`[Move] INFER_EVERY=${INFER_EVERY} が学習時の action_repeat=${ar} と違う → `
               + `policy の歩行速度が学習時の ${(ar/INFER_EVERY).toFixed(2)} 倍になる。`
               + ` 見た目を揃えるなら INFER_EVERY=${ar} (CPU負荷は上がる)`);
  }
}

function hasUsablePolicy(agent){
  const meta=personaMeta[agent.def.id];
  return !!ortSessions[agent.def.id] && (!meta || !meta.dino || !!dinoSession);
}

// 経路探索 (道路優先のダイクストラ)。
//   通れるのは PASSABLE(=ROAD|BUILDING) のみ。木/空地は実際の移動でも通れないので除外する。
//   道路を安く・建物を高くして「基本は道路を辿るが、必要なら建物を抜ける」ナビらしい経路にする。
//   ※ 道路のみに限定すると、区画の奥にある建物(道路に隣接していない)から出られず経路が引けない。
//     エージェントは建物上に湧くため、これだと大半がナビに入れなかった。
// 建物は通行可だが『経路として突っ切る』のは不自然なので強く忌避する。
// 不可(Infinity)にはしない: 区画の奥の建物は建物経由でしか出入りできない場合があるため。
const COST_ROAD = 1, COST_BLDG = 40;
const COST_OFFROAD = parseFloat(process.env.COST_OFFROAD) || 4;   // 実軌跡を見て調整すること

// ── FPV の忠実度 ──
// FPV は 3D シーンと別のレンダラなので、次の 2 つが欠けていた:
//   建物の高さ  … タワーも売店も画面上は同じ大きさの壁になる
//   他エージェント … 画像に一切映らず、social は aux の数値センサだけ
// どちらも観測を変えるので、有効化したら再学習が必要。既定 OFF。
const FPV_HEIGHTS = process.env.FPV_HEIGHTS === '1';
const FPV_AGENTS  = process.env.FPV_AGENTS  === '1';
const EYE_HEIGHT  = 0.5;                     // 目線の高さ (セル)。地平線を決める
const TREE_HEIGHT = 1.0;
const AGENT_SPRITE_W = 0.35, AGENT_SPRITE_H = 0.9;
const AGENT_SPRITE_RGB = [0.95, 0.75, 0.35];
const SPRITE_MIN_DIST = 0.25, SPRITE_MAX_DIST = 8.0;   // 重なりで画面が埋まるのを防ぐ
function planPath(sr, sc, gr, gc){
  const N=GRID*GRID, key=(r,c)=>r*GRID+c;
  // ゴールの建物セルだけは終点として許可する (玄関まで経路を引くため)。
  const passable=(r,c)=> r>=0&&r<GRID&&c>=0&&c<GRID
    && (PASSABLE.has(MAP[r][c]) || (r===gr&&c===gc));
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
      // ALIGNED では建物を経路に使えない。空き地が「道を外れた近道」になるので
      // 道路より高いコストを与えて道路優先を保つ。COST_OFFROAD は暫定値で、
      // 大きすぎると空き地を使わず遠回り、小さすぎると道路を無視する。
      const nd=dist[u]+(MAP[nr][nc]===ROAD?COST_ROAD
                       :(WORLD.solidBuildings?COST_OFFROAD:COST_BLDG));
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
  const cands=BUILDINGS.filter(b=>{
    const st=structAt(b[0],b[1]);
    return st && st.state==='open' && st.typeIdx===T
      && (Math.abs(b[0]-ar)>1 || Math.abs(b[1]-ac)>1);
  });
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
  a.mode='wander'; a.goalZ=null; a.rally=false;
  // 内部状態(空腹/疲労/時刻)で行き先を決める。該当が無ければ従来のランダム建物。
  const g=pickLifeGoal(a, [Math.floor(a.x),Math.floor(a.y)]);
  // ★ 行き先の建物タイプで z を立てる。BC学習した「compassに従って目的地へ行く」挙動(感度~1.0)を
  //   使うため。z=0 の徘徊挙動は compass 追従が弱く、経路上で足踏みして活性が上がらなかった。
  //   「性格」は wiggle ではなく“どこへ向かうか”(pickLifeGoal が persona/内部状態で決める)で出す。
  a.goalType = (BUILDING_TYPES[g[0]+'_'+g[1]] != null) ? BUILDING_TYPES[g[0]+'_'+g[1]] : null;
  // 行き先まで A* 経路を引いて「道沿いに」向かわせる (直線 compass だと途中の建物/木に突っ込んで詰まる)。
  const path=planPath(Math.floor(a.x), Math.floor(a.y), g[0], g[1]);
  if(path && path.length>1){ a.path=path; a.pathIdx=0; a.navDest=[g[0],g[1]]; }
  else { a.path=null; a.pathIdx=0; a.gx=g[0]+0.5; a.gy=g[1]+0.5; }   // 経路が引けなければ直線
  applyGoalZ(a);   // goalType に応じて z をセット (未対応タイプなら z=0 に落ちる)
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
  // 先読み量はモデル側 (meta.compass_lookahead) を優先する。学習の compass が
  // 「経路を何セル先取りした点」を見ていたかと一致していないと観測がズレる。
  const _pm=personaMeta[a.def.id];
  const look=(_pm&&_pm.compassLookahead)||LOOKAHEAD;
  const ti=Math.min(a.pathIdx+look, a.path.length-1);
  const [tr,tc]=a.path[ti];
  a.gx=tr+0.5; a.gy=tc+0.5;
  // navigate 中は全区間で z(目的タイプ one-hot) を立てる。
  // 学習側の「z-set = 目標追従レジーム(探索報酬を止め接近報酬を優先)」に一致させ、
  // compass の先読み点を確実に追わせる。道中で z=0 に落とすと徘徊レジームに戻り目的地へ向かわない。
  applyGoalZ(a);
  // 到着判定は「最後のウェイポイント」でだけ行う (途中の点では trips を数えない)。
  //   ALIGNED では建物セルに立てないので、玄関 (4近傍) に着いた時点で到着とする。
  //   従来の「建物中心まで 0.8」判定のままだと、玄関で止まった人は中心まで 1.0 の
  //   ところで前進を拒否され、永久に到着しないまま足踏みする (実測: 60秒で到着1回)。
  //   world.js に MW.hasArrived が用意されていたのに呼ばれていなかった。
  const last=a.path[a.path.length-1];
  const dlast=Math.hypot(a.x-(last[0]+0.5), a.y-(last[1]+0.5));
  const atGoal = (WORLD.solidBuildings && MAP[last[0]][last[1]]===BUILDING)
    ? MW.hasArrived(WORLD, Math.floor(a.x), Math.floor(a.y), last[0], last[1])
    : dlast<0.8;
  if(a.pathIdx>=a.path.length-2 && atGoal) return true;
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

// 表示名。ペルソナを使い回すので、同じ名前の住民には通し番号を振る。
function agentDisplayName(i, def){
  return (NUM_AGENTS>PERSONA_DEFS.length)
    ? `${def.name} #${Math.floor(i/PERSONA_DEFS.length)+1}` : def.name;
}

// 住民を1人ぶん作る (転入でも使う)。i は通し番号で、aid と表示名を決める。
function spawnAgent(S, i){
  const def=PERSONA_DEFS[i % PERSONA_DEFS.length];
  const b=randB(null), g=randB(b);
  const a={aid:`${def.id}#${i}`, name:agentDisplayName(i,def),
    x:b[0]+0.5, y:b[1]+0.5, th:Math.random()*Math.PI*2, gx:g[0]+0.5, gy:g[1]+0.5,
    trips:0, viols:0, steps:0, stall:0, def, trail:[], active:true,
    visited:new Set(), explored:0, visMem:new Map(),
    // 行動モード: 既定は A(自由)。/goal でタイプを指定すると B(ナビ) に入る。
    mode:'wander', goalType:null, goalZ:null, path:null, pathIdx:0, navDest:null, rally:false,
    personaVec:null,   // 1モデル化: null=既定の性格 / セットすると実行時に性格を上書き
    // 生活シミュレーション用の内部状態 (= 一種の記憶。観測には入れず目的地抽選に効く)
    home:null, work:null, needIcon:null,
    // 街の進化: 訪問済み建物タイプのビット / 自分の店 / カテゴリ別の不満寄与
    seenMask:0, owns:null, unmetBy:null,
    // 屋内状態 (solidBuildings)。null=屋外 / [r,c]=その建物の中。
    indoors:null,
    hunger:Math.random()*0.4, fatigue:Math.random()*0.4,
    supply:Math.random()*0.4, bored:Math.random()*0.4, sick:0};
  agents.push(a);
  agentMeshes.push(createAgentMesh(S, def.color));
  return a;
}

// 住民をその家に入れて一日を始めさせる。
function settleAgent(a){
  if(!a.home){
    // 住むところが無い (住居ゼロなど異常時)。建物セルの中に置くと二度と動けないので、
    // 通れるセルへ逃がす。
    const b=BUILDINGS.length?MW.doorCell(MAP, WORLD, BUILDINGS[0][0], BUILDINGS[0][1]):null;
    if(b){ a.x=b[0]+0.5; a.y=b[1]+0.5; enterWander(a); }
    return;
  }
  a.fatigue=Math.random()*0.15;
  if(WORLD.solidBuildings){
    MW.enterBuilding(a, a.home[0], a.home[1]);
  }else{
    a.x=a.home[0]+0.5+(Math.random()-0.5)*0.6;
    a.y=a.home[1]+0.5+(Math.random()-0.5)*0.6;
    enterWander(a);
  }
}

function initAgents(S){
  // 既存エージェント/トレイルのメッシュを scene から外し GPU リソースを解放
  agentMeshes.forEach(m=>{S.remove(m);disposeMesh(m);});
  agents.forEach(a=>{a.trail.forEach(m=>S.remove(m));});  // trail geo/mat は共有なので dispose しない
  agents=[];agentMeshes=[];
  // 最初の人口。村から始める場合は START_POP から、以降は住居が建つたびに増える。
  // 保存された街を復元するときはその人口から再開する。
  const startPop=Math.max(1, Math.min(NUM_AGENTS,
    (CITY && CITY.pop) ? CITY.pop : (START_VILLAGE ? START_POP : NUM_AGENTS)));
  for(let i=0;i<startPop;i++) spawnAgent(S, i);
  // 保存されていた「訪問済みタイプ」と「自分の店」を先に復元する。
  // assignHomes は owns を見て職場を決めるので、順序を逆にすると店主が職を失う。
  if(CITY && CITY.savedAgents){
    let restored=0;
    for(const a of agents){
      const sv=CITY.savedAgents[a.aid]; if(!sv) continue;
      a.seenMask=sv.m||0;
      if(sv.o && structAt(sv.o[0],sv.o[1])){ a.owns=[...sv.o]; restored++; }
    }
    if(restored) console.log(`[City] 店主 ${restored}人の職場を復元`);
  }
  assignHomes();         // 空きのある住居/職場へ割り当てる
  // 自宅から一日を始める。夜間起動でも「家に居るのに眠くて彷徨う」不自然さを避ける。
  for(const a of agents) settleAgent(a);
  if(CITY) CITY.pop=agents.length;
  inferWarmed = false;   // エージェントが入れ替わったので推論キャッシュを温め直す
  console.log(`[Sim] ${agents.length} agents initialized (personas=${PERSONA_DEFS.length})`);
}

// トレイルは毎ステップ生成されるため、geometry を全トレイルで共有する。
// 以前は毎回 new PlaneGeometry していて、50個超で remove するだけ (dispose なし)
// だったため GPU バッファがリークし続けていた。共有 geometry なら 1個で済み、
// disposeScene では破棄しない (TRAIL_GEO で除外)。
const TRAIL_GEO = new THREE.PlaneGeometry(CELL*.2*TRAIL_SCALE, CELL*.2*TRAIL_SCALE);

function addTrail(S,agent){
  if(MW.isIndoors(agent)) return;   // 建物の中に点が溜まるのを防ぐ
  const m=new THREE.Mesh(TRAIL_GEO,trailMats[agent.def.id]);
  m.position.set(agent.y*CELL+CELL*.5,agent.x*CELL+CELL*.5,.04);
  S.add(m);agent.trail.push(m);
  while(agent.trail.length>MAX_TRAIL){
    const old=agent.trail.shift();
    S.remove(old);   // geometry は共有・material はパーソナ共有なので dispose 不要
  }
}

// (x,y) から角度 th へ move 進んだ先のセルが通行可能か
function passableToward(x, y, th, move){
  const nx=x+Math.cos(th)*move, ny=y+Math.sin(th)*move;
  const r=Math.floor(nx), c=Math.floor(ny);
  if(r<0||r>=GRID||c<0||c>=GRID) return false;
  return PASSABLE.has(MAP[r][c]);
}
// 詰まったエージェントを通れる向きへ回頭させる行動を返す (0=前進,1=左,2=右)。
//   前方が空いていれば前進、塞がっていれば左右で空いている側へ、両方塞がれば回頭を続ける。
// 目的地(gx,gy)へ向かう決定論コントローラ。通れる候補向きのうち、ゴール方位に最も近いものを選ぶ。
//   前方(現在向き)が通れてゴール方向に十分近ければ前進、そうでなければゴール側の通れる向きへ回頭。
function pursueAction(a, move, rot){
  const gb=Math.atan2(a.gy-a.y, a.gx-a.x);                 // ゴールへの絶対方位
  const wrap=x=>Math.atan2(Math.sin(x),Math.cos(x));
  // だいたいゴール方向(±50°)で前方が通れるなら、完全整列を待たず前進 (曲がりながら進む)
  if(Math.abs(wrap(gb-a.th))<0.87 && passableToward(a.x,a.y,a.th,move)) return 0;
  let bestK=null, bestErr=Infinity;
  for(let k=0;k<=6;k++){
    for(const sgn of (k===0?[0]:[-1,1])){
      const th2=a.th+sgn*k*rot;
      if(!passableToward(a.x,a.y,th2,move)) continue;       // 通れる向きだけ候補
      const err=Math.abs(wrap(gb-th2));                     // その向きがどれだけゴールを向くか
      if(err<bestErr){ bestErr=err; bestK=sgn*k; }
    }
  }
  if(bestK===null) return (a.aid.charCodeAt(0)&1)?1:2;      // 全方位ふさがり → 回頭
  if(bestK===0) return 0;                                   // 現在向きが通れて最もゴール寄り → 前進
  return bestK>0 ? 2 : 1;                                   // ゴール側の通れる向きへ回頭
}

function unstickAction(a, move, rot){
  if(passableToward(a.x,a.y,a.th,move)) return 0;                 // 前が空いた → 進む
  // 少し先まで見て、左右どちらがより開けているか
  const scan=(dir)=>{ for(let k=1;k<=4;k++){ if(passableToward(a.x,a.y,a.th+dir*rot*k,move)) return k; } return 99; };
  const L=scan(-1), R=scan(1);
  if(L===99 && R===99) return (a.aid.charCodeAt(0)&1)?1:2;        // 全方位ふさがり → とりあえず回頭
  return (L<=R) ? 1 : 2;                                          // 近い方の開いた向きへ
}

async function stepAll(){
  if(paused || !scene) return;   // ★ scene null ガード
  stepCount++;
  await prefetchAllActions(MAP, agents);
  for(let i=0;i<agents.length;i++){
    const a=agents[i];
    if(a.mode==='hold') continue;   // rally 集合後は静止 (デバッグ用)
    // ── 屋内は物理と方策の外 ──
    // 建物セルは通行不可なので、屋内エージェントに推論や移動を適用すると
    // 「壁の中で前進が常に失敗する」状態になる。欲求だけ進めて、外出条件が
    // 立ったら玄関に出す。欲求の更新は stepNeeds が別インターバルで回している。
    if(MW.isIndoors(a)){
      if(shouldLeaveBuilding(a) && MW.exitBuilding(a, MAP, WORLD)) enterWander(a);
      continue;
    }
    const px=a.x,py=a.y;
    const meta=personaMeta[a.def.id];
    let action;
    // 1意思決定あたりの変位を INFER_EVERY で割って毎tick量にする。これで INFER_EVERY をいくつにしても
    // 「1意思決定=学習時と同じ変位(前進2.5セル/旋回40°)」が保たれ、推論の狭間でのオーバーシュート/嵌りを防ぐ。
    let move=((meta&&meta.fwdPerDecision)||FWD_PER_DECISION_DEF)/INFER_EVERY;
    let rot =((meta&&meta.rotPerDecision)||ROT_PER_DECISION_DEF)/INFER_EVERY;
    const usePursuit = MOVE_MODE==='pursuit' || !hasUsablePolicy(a);
    if(usePursuit){   // 毎tick再計算なので大きめステップで機敏に (policyの÷INFER_EVERYは不要)
      const sub=PURSUIT_SUB;
      move=((meta&&meta.fwdPerDecision)||FWD_PER_DECISION_DEF)/sub;
      rot =((meta&&meta.rotPerDecision)||ROT_PER_DECISION_DEF)/sub;
    }
    if(usePursuit){
      action=pursueAction(a, move, rot);                   // 決定論の目的地追従 (推論不要)
    }else{
      action=selectAction(a);                              // 学習方策
      if(a.stall>=UNSTICK_STALL){                          // 詰まり救出 (policyモードのみ)
        if(UNSTICK_MODE==='steer') action=unstickAction(a, move, rot);
        else if(a.mode==='wander'){ enterWander(a); a.stall=0; }
      }
    }
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
      const passable = FREE_MOVE ? true
                     : (useSeg ? (segPassCache[a.aid] ?? true) : PASSABLE.has(MAP[r][c]));
      if(passable){
        a.x=nx;a.y=ny;
        const key=`${r},${c}`;if(!a.visited.has(key)){a.visited.add(key);a.explored++;}
        // 踏み跡: 空き地を踏んだ回数を数える。よく踏まれた空き地は日次で道になる。
        // 道路の上の足跡は数えない (既に道なので情報が無い)。
        if(CITY_EVOLVE && CITY && MAP[r][c]===OTHER) CITY.foot[r*GRID+c]++;
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
        onArrive(a, a.navDest);
        // 到着 = 玄関に着いた。建物の中へ入る (滞在は屋内状態が担う)。
        if(WORLD.solidBuildings && a.navDest) MW.enterBuilding(a, a.navDest[0], a.navDest[1]);
        if(a.rally) a.mode='hold';   // rally: 集合点に到着したら静止 (解除は /rally?off=1)
        else if(!MW.isIndoors(a)) enterWander(a);
      }
    }else{
      // A: wander。生活の行き先へ A* 経路追従 (z=0 のまま = 学習時 GOAL_NONE regime)。
      a.goalZ=null;
      if(a.path){
        if(stepNavigate(a)){
          onArrive(a, a.navDest);
          if(WORLD.solidBuildings && a.navDest) MW.enterBuilding(a, a.navDest[0], a.navDest[1]);
          if(!MW.isIndoors(a)) enterWander(a);   // 到着 → 次の行き先を選び直す
        }
      }else{
        if(Math.hypot(a.x-a.gx, a.y-a.gy)<0.8){ onArrive(a, null); enterWander(a); }  // 経路なし=直線fallback
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
      resetCity(true);           // 新しい街 = 蓄積もゼロから (buildScene は CITY を読む)
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

// 終了シグナルでは街の状態を必ず保存してから落ちる (再デプロイで蓄積を失わないため)。
// 以前は YT_ENABLED のときだけハンドラを張っていたので、WebSocket 運用では
// 何も後始末されずに落ちていた。
function shutdownAll(sig){
  try{ saveCity(); console.log(`[City] ${sig}: 街の状態を保存しました`); }catch(e){ console.warn(e.message); }
  shutdownYt(sig, ()=>process.exit(0));
}
process.on('SIGTERM', ()=>shutdownAll('SIGTERM'));
process.on('SIGINT',  ()=>shutdownAll('SIGINT'));

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
  // 街のイベント (着工/完成/閉店/取り壊し) の最中は、人ではなくその場所を映す。
  const ev = stepCamEvents();
  if (ev) {
    const tx = ev.c*CELL + CELL*.5, ty = ev.r*CELL + CELL*.5;
    const t  = (Date.now()-ev.t0)/(ev.secs*1000);           // 0→1
    const ang = (t-0.5)*0.8;                                 // ゆっくり回り込む
    // 寄りの画。建物がフレームに大きく入るよう、低め・近めに構える。
    // wide のときは街全体が入るところまで引く (発展段階が上がった瞬間など)。
    const dist = ev.wide ? fieldSize()*CELL*0.55 : CELL*4.2;
    const hgt  = ev.wide ? fieldSize()*CELL*0.50 : CELL*2.6;
    cam.up.set(0, 0, 1);
    cam.position.set(tx + Math.sin(ang)*dist, ty - Math.cos(ang)*dist, hgt);
    cam.lookAt(tx, ty, ev.wide ? CELL*2 : CELL*0.7);
    camSwitchTimer = Date.now();     // イベント明けに即切り替わらないように
    camFPV = false;
    return;
  }
  pickCameraTarget();
  if (camTargetIdx === 0 || agents.length === 0) {
    const fx=fieldCenterW(), fs=fieldSize()*CELL;
    cam.up.set(0, 1, 0);
    cam.position.set(fx, fx, fs*0.75);
    cam.lookAt(fx, fx + 1, 0);
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

  // ── /fpv : エージェントの一人称観測を PNG で返す ──
  //   方策が実際に「何を見ているか」を確認する唯一の手段。3D俯瞰ビューとは別物で、
  //   こちらが DINOv2 に入る 224x224。木が壁として映るか (WORLD_ALIGNED) の確認や、
  //   train/deploy の描画一致の検証に使う。
  //     /fpv                  最初のエージェント
  //     /fpv?aid=A%230        aid 指定 (# は %23)
  //     /fpv?persona=A        ペルソナ id の先頭
  //     /fpv?scale=3          拡大 (既定 2)
  //     /fpv?raw=1            観測ベクトルを JSON で返す (画像なし)
  //     /fpv?grid=1           obstacle レイの当たり位置に目印を重ねる
  if(urlPath==='/fpv'){
    const q=new URL(req.url,'http://x').searchParams;
    const a = q.has('aid')     ? agents.find(x=>x.aid===q.get('aid'))
            : q.has('persona') ? agents.find(x=>x.def.id===q.get('persona'))
            : agents[0];
    if(!a){ res.writeHead(404); res.end('agent not found'); return; }
    const meta = personaMeta[a.def.id];
    if(!meta || !meta.cfg){ res.writeHead(503); res.end('persona meta not loaded'); return; }

    // 観測ベクトル。画像だけ見ても方策の入力は分からないので併せて出す。
    const auxv = (meta.auxDim>0) ? Array.from(buildAux(a, meta)) : [];
    const info = {
      aid:a.aid, persona:a.def.id, mode:a.mode,
      indoors:a.indoors||null,
      pos:[+a.x.toFixed(2),+a.y.toFixed(2)], th:+a.th.toFixed(3),
      goal:[+a.gx.toFixed(2),+a.gy.toFixed(2)],
      goalType:a.goalType, goalName:a.goalType!=null?BLDG_TYPES[a.goalType].name:null,
      cellUnder: MAP[Math.max(0,Math.min(GRID-1,Math.floor(a.x)))][Math.max(0,Math.min(GRID-1,Math.floor(a.y)))],
      world:{solidBuildings:WORLD.solidBuildings, visibleTrees:WORLD.visibleTrees,
             walkableEmpty:WORLD.walkableEmpty},
      aux: auxv.map(v=>+v.toFixed(4)),
      auxNames:['compass_sin','compass_cos','compass_dist','visit_f','visit_l','visit_r',
                'visit_b','social_x','social_y','obst_front','obst_left','obst_right'],
      stall:a.stall, viols:a.viols, trips:a.trips,
    };
    if(q.get('raw')==='1'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(info,null,2)); return;
    }
    if(!sharp){ res.writeHead(503); res.end('sharp 無し (画像化できない)'); return; }

    const W2=meta.cfg.w, H2=meta.cfg.h;
    const buf=renderFPImageCfg(MAP, a, meta.cfg, FPV_AGENTS?agents:null);   // CHW float[0,1]
    const rgb=Buffer.alloc(W2*H2*3);
    for(let i=0;i<W2*H2;i++){
      rgb[i*3  ]=Math.max(0,Math.min(255,Math.round(buf[i]*255)));
      rgb[i*3+1]=Math.max(0,Math.min(255,Math.round(buf[W2*H2+i]*255)));
      rgb[i*3+2]=Math.max(0,Math.min(255,Math.round(buf[2*W2*H2+i]*255)));
    }
    // obstacle レイの当たり位置に縦線を引く。センサと画像がズレていれば一目で分かる。
    if(q.get('grid')==='1' && auxv.length>=12){
      const mark=(xcol,col)=>{
        const x=Math.max(0,Math.min(W2-1,Math.round(xcol)));
        for(let y=0;y<H2;y++){ const i=(y*W2+x)*3; rgb[i]=col[0]; rgb[i+1]=col[1]; rgb[i+2]=col[2]; }
      };
      mark(W2/2, [255,80,80]);                                    // 正面 (赤)
      const off=meta.obstOff/(meta.cfg.fov/2)*(W2/2);
      mark(W2/2-off, [80,160,255]); mark(W2/2+off, [80,160,255]); // 左右 (青)
    }
    const scale=Math.max(1,Math.min(6,parseInt(q.get('scale'))||2));
    sharp(rgb,{raw:{width:W2,height:H2,channels:3}})
      .resize(W2*scale,H2*scale,{kernel:'nearest'}).png().toBuffer()
      .then(png=>{
        res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store',
          'X-Fpv-Info':Buffer.from(JSON.stringify(info)).toString('base64')});
        res.end(png);
      })
      .catch(e=>{ res.writeHead(500); res.end('render error: '+e.message); });
    return;
  }

  // ── /fpv/view : 全エージェントの一人称を並べて自動更新するページ ──
  if(urlPath==='/fpv/view'){
    const q=new URL(req.url,'http://x').searchParams;
    const ms=Math.max(200,parseInt(q.get('ms'))||1000);
    const ids=[...new Set(agents.map(x=>x.aid))].slice(0,parseInt(q.get('n'))||12);
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(`<!doctype html><meta charset="utf-8"><title>FPV</title>
<style>body{background:#111;color:#ddd;font:12px system-ui;margin:12px}
.g{display:flex;flex-wrap:wrap;gap:10px}.c{background:#1b1b1b;padding:6px;border-radius:6px}
img{display:block;image-rendering:pixelated}.m{margin-top:4px;white-space:pre;font-size:10px;color:#9ab}</style>
<h3>一人称観測 (方策の入力) — ${ms}ms 更新</h3>
<div class="g">${ids.map(id=>`<div class="c"><img id="i_${encodeURIComponent(id)}">
<div class="m" id="m_${encodeURIComponent(id)}">${id}</div></div>`).join('')}</div>
<script>
const ids=${JSON.stringify(ids)};
async function tick(){
  for(const id of ids){
    const u='/fpv?scale=2&grid=1&aid='+encodeURIComponent(id)+'&t='+Date.now();
    try{
      const r=await fetch(u); if(!r.ok) continue;
      const info=JSON.parse(atob(r.headers.get('X-Fpv-Info')||'e30='));
      const b=await r.blob();
      const img=document.getElementById('i_'+encodeURIComponent(id));
      if(img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src=URL.createObjectURL(b);
      const o=info.aux||[];
      document.getElementById('m_'+encodeURIComponent(id)).textContent=[
        id+(info.indoors?'  [屋内]':''),
        (info.goalName||'-')+'  obst '+(o[9]??0).toFixed(2)+'/'+(o[10]??0).toFixed(2)+'/'+(o[11]??0).toFixed(2),
        'compass '+(o[2]??0).toFixed(2)+'  stall '+info.stall,
      ].join(String.fromCharCode(10));
    }catch(e){}
  }
}
tick(); setInterval(tick, ${ms});
</script>`);
    return;
  }

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

  // ── 生活状態の可視化: 時刻 / 各エージェントの拠点・空腹・疲労・いまの欲求 ──
  // ── /city : 街の蓄積 (経過日数 / 道 / 開業・閉店 / 需要 / ニュース) ──
  //   /city            いまの街の状態
  //   /city?reset=1    蓄積を捨てて街を作り直す (マップはそのまま)
  if(urlPath==='/city'){
    const q=new URL(req.url,'http://x').searchParams;
    res.setHeader('Content-Type','application/json');
    if(!CITY){ res.writeHead(503); res.end(JSON.stringify({ok:false,error:'city not ready'})); return; }
    if(q.get('reset')==='1'){
      resetCity(false);
      if(scene){
        const old=scene;
        scene=buildScene(MAP);
        disposeScene(old);
        PERSONA_DEFS.forEach(p=>{trailMats[p.id]=new THREE.MeshBasicMaterial({color:p.color,transparent:true,opacity:0.28,depthWrite:false});});
        initAgents(scene);
      }
      res.writeHead(200); res.end(JSON.stringify({ok:true, reset:true, day:gameDay()+1})); return;
    }
    // 天気の切替 (見た目の確認用): /city?weather=sunny|cloudy|rain
    const wx=q.get('weather');
    if(wx){
      if(!WEATHERS[wx]){
        res.writeHead(400);
        res.end(JSON.stringify({ok:false, error:`unknown weather: ${wx}`, weathers:WEATHER_KEYS}));
        return;
      }
      CITY.weather=wx;
      CITY.weatherUntil=Date.now()+WEATHER_HOURS*(DAY_MINUTES*60/24)*1000;
      news('weather', `天気が ${WEATHERS[wx].ja} になった`, `Weather: ${WEATHERS[wx].en}`);
      res.writeHead(200); res.end(JSON.stringify({ok:true, weather:wx}));
      return;
    }

    // 演出の確認用: 日付が変わるのを待たずに1件だけ起こす。
    //   /city?force=found     … いま需要が最大の場所に着工させる
    //   /city?force=close     … 来客が最少の店を閉店させる
    //   /city?force=demolish  … 閉店中の店を1軒その場で取り壊す (沈むアニメ)
    const force=q.get('force');
    if(force){
      const day=gameDay();
      let done=null;
      if(force==='found'){
        // 閾値を無視して1軒建てる。カテゴリ指定も可 (/city?force=found&cat=home)
        const want=q.get('cat');
        const cats=want?[want]:BUILD_CATS;
        for(const cat of cats){
          const st=foundCategory(cat, day);
          if(st){ done=`found ${BLDG_TYPES[st.typeIdx].name} at ${st.r},${st.c}`; break; }
        }
      }else if(force==='close'){
        const cands=CITY.structs.filter(x=>x.state==='open' && isClosable(x.typeIdx))
                                .sort((a,b)=>a.ema-b.ema);
        if(cands[0]){ closeShop(cands[0], day); done=`closed ${cands[0].r},${cands[0].c}`; }
      }else if(force==='demolish'){
        const st=CITY.structs.find(x=>x.state==='closed');
        if(st){
          st.state='demolishing'; CITY.stats.demolished++;
          const label=BLDG_TYPES[st.typeIdx].label;
          news('demolish', `${label} (${st.r},${st.c}) が取り壊されて空き地になった`,
               `${enOf(st.typeIdx)} was demolished`);
          showCityEvent(st.r, st.c, `${enOf(st.typeIdx)} is gone`, null,
                        {st, kind:'sink', onDone:()=>finishDemolish(st)});
          done=`demolishing ${st.r},${st.c}`;
        }
      }
      res.writeHead(done?200:409);
      res.end(JSON.stringify({ok:!!done, force, result:done||'対象が見つからない'}));
      return;
    }
    const fmt=st=>({type:BLDG_TYPES[st.typeIdx].name, label:BLDG_TYPES[st.typeIdx].label,
      cell:[st.r,st.c], state:st.state, born:st.born+1, visits:st.visits,
      ema:+st.ema.toFixed(1), owner:st.openedBy});
    const open=CITY.structs.filter(s=>s.state==='open');
    const foot=[];
    for(let r=0;r<GRID;r++)for(let c=0;c<GRID;c++)
      if(MAP[r][c]===OTHER && CITY.foot[r*GRID+c]>0) foot.push({cell:[r,c], foot:CITY.foot[r*GRID+c]});
    foot.sort((a,b)=>b.foot-a.foot);
    const h=gameHour();
    res.writeHead(200);
    res.end(JSON.stringify({ok:true, evolve:CITY_EVOLVE,
      day:gameDay()+1, time:`${String(Math.floor(h)).padStart(2,'0')}:${String(Math.floor(h%1*60)).padStart(2,'0')}`,
      ageHours:+((Date.now()-CITY.bornAt)/3600000).toFixed(1),
      stats:CITY.stats,
      buildings:{total:CITY.structs.length, open:open.length,
        construction:CITY.structs.filter(s=>s.state==='construction').length,
        closed:CITY.structs.filter(s=>s.state==='closed').length},
      weather:{now:CITY.weather||'sunny', label:weatherNow().ja, en:weatherNow().en,
        untilSec:Math.max(0, Math.round(((CITY.weatherUntil||0)-Date.now())/1000))},
      field:{size:CITY.size, max:GRID, freeLots:buildableLots(),
        density:+fieldDensity().toFixed(3), expandAt:{density:EXPAND_DENSITY, freeLots:EXPAND_FREE}},
      level:{index:cityLevel(), name:levelSpec().name, econ:Math.round(CITY.econ),
        maxHeight:levelSpec().maxH, fp2:levelSpec().fp2,
        next:CITY_LEVELS[cityLevel()+1]?{name:CITY_LEVELS[cityLevel()+1].name,
          econ:CITY_LEVELS[cityLevel()+1].econ}:null},
      population:{now:agents.length, cap:housingCapacity(), max:NUM_AGENTS,
        workCap:workplaceCapacity(),
        homeless:agents.reduce((n,a)=>n+(a.home?0:1),0),
        homes:openStructsOf(HOME_IDX).map(st=>({label:BLDG_TYPES[st.typeIdx].label, cell:[st.r,st.c],
          cap:homeCapOf(st.typeIdx),
          residents:agents.reduce((n,a)=>n+((a.home&&a.home[0]===st.r&&a.home[1]===st.c)?1:0),0)}))},
      demand:Object.fromEntries(CATS.map(c=>{
        const dg=CITY.diag[c];
        return [c,{unmet:+CITY.unmet[c].toFixed(1), supply:catCount(c),
          avgDist:dg.n?+(dg.sum/dg.n).toFixed(1):null, farPct:dg.n?Math.round(dg.far/dg.n*100):0,
          foundable:foundableTypes(c).map(t=>BLDG_TYPES[t].name)}];
      })),
      buildable:Object.fromEntries(BUILD_CATS.map(c=>[c, foundableTypes(c).map(t=>BLDG_TYPES[t].name)])),
      foundThreshold:FOUND_SITE,
      newest:CITY.structs.filter(s=>s.founded).sort((a,b)=>b.born-a.born).slice(0,10).map(fmt),
      busiest:open.slice().sort((a,b)=>b.visits-a.visits).slice(0,10).map(fmt),
      atRisk:open.filter(s=>isClosable(s.typeIdx)).sort((a,b)=>a.ema-b.ema).slice(0,5).map(fmt),
      footTop:foot.slice(0,10), roadThreshold:FOOT_MIN,
      news:latestNews(30).reverse()}));
    return;
  }

  if(urlPath==='/life'){
    res.setHeader('Content-Type','application/json');
    const h=gameHour();
    const hh=String(Math.floor(h)).padStart(2,'0'), mm=String(Math.floor(h%1*60)).padStart(2,'0');
    const byNeed={};
    for(const a of agents){ const n=needOf(a)||'-'; byNeed[n]=(byNeed[n]||0)+1; }
    res.writeHead(200);
    res.end(JSON.stringify({ok:true, time:`${hh}:${mm}`, hour:+h.toFixed(2),
      daylight:+daylight().toFixed(3), dayMinutes:DAY_MINUTES, needCounts:byNeed,
      agents:agents.map(a=>({aid:a.aid, persona:a.def.id,
        home:a.home, work:a.work,
        hunger:+(a.hunger||0).toFixed(2), fatigue:+(a.fatigue||0).toFixed(2),
        supply:+(a.supply||0).toFixed(2), bored:+(a.bored||0).toFixed(2),
        sick:+(a.sick||0).toFixed(2),
        need:needOf(a), emoji:NEED_EMOJI[needOf(a)]||null,
        pos:[+a.x.toFixed(1),+a.y.toFixed(1)]}))}));
    return;
  }

  // ── 住民一覧ページ用 API: ID/仮の名前/ペルソナタイプ/状態/現在の行動をまとめて返す ──
  if(urlPath==='/api/residents'){
    res.setHeader('Content-Type','application/json');
    const h=gameHour();
    const hh=String(Math.floor(h)).padStart(2,'0'), mm=String(Math.floor(h%1*60)).padStart(2,'0');
    res.writeHead(200);
    res.end(JSON.stringify({ok:true, time:`${hh}:${mm}`, count:agents.length,
      residents:agents.map(a=>{
        const need=needOf(a);
        return {
          id:a.aid, name:a.name||a.def.name, personaType:a.def.id, personaDesc:a.def.desc, color:a.def.hex,
          need, needEmoji:NEED_EMOJI[need]||null, needLabel:need?(NEED_LABEL_JA[need]||need):'元気',
          activity: describeActivity(a),
          pos:[+a.x.toFixed(1),+a.y.toFixed(1)]
        };
      })}));
    return;
  }

  // ── 住民一覧ページ ──
  if(urlPath==='/residents'){
    return serveFile(res, path.join(__dirname,'residents.html'));
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
let frameCount=0, encoding=false, _groundAt=0;
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
      // 屋内 = 建物の中に居るので見えない。位置の補間も止める (玄関から
      // 建物中心へ滑って見えるのを防ぐ)。
      m.visible = !MW.isIndoors(a);
      if(!m.visible) return;
      m.position.x+=(tx-m.position.x)*Math.min(1,dt*14);
      m.position.y+=(ty-m.position.y)*Math.min(1,dt*14);
      m.position.z=CELL*.26*CHAR_SCALE;   // 足元を地面に接地させる (足元ローカルz=-CELL*.26 をスケール分だけ持ち上げ)
      const tar=-a.th+Math.PI*.5;
      let dr=tar-m.rotation.z;
      while(dr>Math.PI)dr-=Math.PI*2;while(dr<-Math.PI)dr+=Math.PI*2;
      m.rotation.z+=dr*Math.min(1,dt*14);
    });

    stepStructAnims();            // 建物のせり上がり / 沈み込み
    stepRain(dt, mainCam);        // 雨 (天気が rain のときだけ)
    // 地面の板 (道路 / 摩耗) を作り直す。道が増えたとき (groundDirty) は即、
    // 踏み跡の濃淡は上位%で決まるので 20 秒ごとにゆっくり追従させる。
    if((groundDirty || Date.now()-_groundAt>20000) && Date.now()-_groundAt>3000){
      groundDirty=false; _groundAt=Date.now(); rebuildGround(scene);
    }
    updateTrackingCamera(mainCam);
    updateOcclusionFade();
    updateDayNight(scene);        // 時刻で空と光を変える
    updateNeedIcons(mainCam);     // 欲求アイコン (空腹/眠気/勤務) を頭上に
    // 3D を描いてから HUD (Day/ティッカー) を正射影で重ねる。
    // autoClear を切るので、色バッファは自分で clear する必要がある。
    renderer.autoClear=false;
    renderer.clear();
    renderer.render(scene, mainCam);
    if(hudScene){ updateHud(dt); renderer.clearDepth(); renderer.render(hudScene, hudCam); }
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
  // 街のできごとを映している間は、その一言をカメラ名として出す (人を追っていないため)
  const camName = camEventCur ? camEventCur.banner
                : camTargetIdx === 0 ? 'overview'
                : (agents[camTargetIdx-1]?.name || '-');
  const msg=JSON.stringify({type:'stats', camName,
    day:gameDay()+1, news:latestNews(5).reverse().map(n=>({day:n.day+1, kind:n.kind, text:n.text})),
    agents:agents.map(a=>({id:a.def.id,trips:a.trips,viols:a.viols,explored:a.explored}))});
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
  setInterval(()=>{ stepNeeds(1); retargetOnNeedChange(); }, 1000);   // 空腹/疲労の進行と行き先の見直し
  if(CITY_EVOLVE){
    setInterval(cityTick, 1000);                                      // 日付の切替と工事の完了
    setInterval(saveCity, Math.max(10,CITY_SAVE_SEC)*1000);           // 街の状態を定期保存
  }
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
  logMoveCadence();

  console.log('[Init] preloading textures...');
  await preloadTextures();
  await loadRaycastTextures();   // エージェント観測(FPV)用の64×64テクスチャ
  await buildNeedIcons();        // 頭上の欲求アイコン(絵文字)をテクスチャ化

  console.log('[Init] restoring city state...');
  initCity();                    // 保存された街を復元 (無ければ生成)。MAP を差し替えることがある
  console.log('[Init] building scene...');
  scene = buildScene(MAP);
  await initHud();               // 配信画面の Day カウンタ / ニュースティッカー

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