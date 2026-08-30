// roads.js — 道路のクラス分け・オートタイルのマスク・アトラスの UV。
//
// **server.js から切り出す理由は world.js と同じ。**
// この計算は最低でも 2 か所から引かれる:
//   ・3D の路面標示レイヤー (rebuildGround)
//   ・将来、地面を方策の観測に入れる場合のレイキャスタ (renderFPImageCfg の床キャスト)
// どちらかにだけ書くと、world.js の冒頭が書いている「マップ生成が二重実装されて
// 学習と本番がズレた」のと同じことが起きる。**アトラスの枠割りも、マスクの
// ビット順も、ここが唯一の定義**。tools/make-road-atlas.js もここを require する。
//
// ── MAP は触らない ──
// 道路クラスは MAP とは別の Int8Array で持つ。MAP のセル種別 (OTHER/ROAD/
// BUILDING/TREE) は学習済み方策の観測そのもの (world.js passableSet /
// server.js buildAux の obstacle レイ) なので、ここに値を増やすと方策が
// 見たことのない入力になる。クラスは描画と (将来の) 車・信号だけが読む。

'use strict';

// ── 道路クラス ──────────────────────────────────────────────────────────────
const PATH = 0;      // 歩行者専用 (全面が舗装。車は入れない)
const ONEWAY = 1;    // 一通 (1車線 + 広めの歩道)
const TWOLANE = 2;   // 二車線 (センターライン + 両側の歩道)

// ── アトラスの枠割り ────────────────────────────────────────────────────────
// tools/make-road-atlas.js が焼く PNG のレイアウト。**両者で必ず一致すること。**
const TILE = 128;                    // 1 枠 (px)
const GUT = 8;                       // ガター (px)。ミップマップのにじみ防止
const CONTENT = TILE - GUT * 2;      // 実際に絵が入る領域 = 112
const COLS = 8, ROWS = 8;
const ATLAS = TILE * COLS;           // 1024 (2の冪)
// クラスごとの先頭スロット。PATH は形が 1 つ (全面舗装) なので 1 枠だけ。
const SLOT_BASE = { [TWOLANE]: 0, [ONEWAY]: 16, [PATH]: 32 };
const SLOT_USED = 33;

// ── 近傍マスク ──────────────────────────────────────────────────────────────
// mask = (N?1:0) | (E?2:0) | (S?4:0) | (W?8:0)
//   N = map[r-1][c]  E = map[r][c+1]  S = map[r+1][c]  W = map[r][c-1]
// アトラスは 16 通りを回転させずに全部焼いてあるので、ここでの回転処理は不要
// (実行時に回すと、その回転を 3D 側とレイキャスタ側の両方に書くことになる)。
function roadMask(map, r, c, roadVal) {
  const n = map.length;
  const R = (rr, cc) => rr >= 0 && rr < n && cc >= 0 && cc < n && map[rr][cc] === roadVal;
  return (R(r - 1, c) ? 1 : 0) | (R(r, c + 1) ? 2 : 0)
       | (R(r + 1, c) ? 4 : 0) | (R(r, c - 1) ? 8 : 0);
}
const maskDegree = m => ((m & 1) ? 1 : 0) + ((m & 2) ? 1 : 0) + ((m & 4) ? 1 : 0) + ((m & 8) ? 1 : 0);

/** クラスとマスクからアトラスのスロット番号。PATH は形が 1 つなのでマスクを無視。 */
function atlasSlot(cls, mask) {
  return cls === PATH ? SLOT_BASE[PATH] : SLOT_BASE[cls] + mask;
}

/**
 * スロットの UV。返すのは**セルの北辺 (vN) と南辺 (vS)** の V。
 * three の DataTexture は flipY=true で読むと画像の上端が V=1 に来るので、
 * タイル画像の上端 (= 北) が vN=1-y0 になる。ここを間違えると道が隣のセルと
 * 繋がらないので、絵を見ればすぐ分かる。
 * ガターのぶん内側に寄せてあるので、ミップマップで隣の枠がにじみ込まない。
 */
function atlasUV(slot, flipY) {
  const col = slot % COLS, row = (slot / COLS) | 0;
  const x0 = (col * TILE + GUT) / ATLAS, x1 = (col * TILE + GUT + CONTENT) / ATLAS;
  const y0 = (row * TILE + GUT) / ATLAS, y1 = (row * TILE + GUT + CONTENT) / ATLAS;
  return flipY === false ? { u0: x0, u1: x1, vN: y0, vS: y1 }
                         : { u0: x0, u1: x1, vN: 1 - y0, vS: 1 - y1 };
}

// ── クラス分け ──────────────────────────────────────────────────────────────
// 通行量 (roadUse) の中央値を基準に決める。絶対数だと、人口や経過日数しだいで
// 街全体が二車線になったり全部が路地になったりする。
//   行き止まり (次数<=1)     → 歩行者専用。袋小路に車道を引いても行き先が無い
//   中央値の HI 倍以上       → 二車線
//   中央値の LO 倍未満       → 歩行者専用。ただし**次数<=2 のときだけ**
//   それ以外                 → 一通
//
// ★ 「次数<=2 のときだけ」が要る。これが無いと交差点や通り抜けの途中が
//   歩行者専用になり、車の道が寸断されて網が繋がらない (実際 30x30 の街で
//   道の 27% が歩行者専用になり、幹線が細切れになった)。交差点は必ず車が
//   通れる格に保ち、歩行者専用は袋小路と静かな路地だけに限る。
const CLASS_HI = 2.0, CLASS_LO = 0.25;
const PATH_MAX_DEGREE = 2;

/**
 * 道路クラスを引き直す。prev を渡すと **1 日に 1 段階ずつ**しか動かさない
 * (ヒステリシス)。これが無いと通行量のゆらぎで道幅が毎日ちらつく。
 * 戻り値は新しい Int8Array (prev は破壊しない)。
 */
function classifyRoads(map, roadUse, prev, roadVal) {
  const n = map.length, out = new Int8Array(n * n);
  // 中央値。道が 1 本も無い / 誰も歩いていない街では 0 になるので、
  // その場合は「全部が一通」から始める (0 で割ると全部が二車線になってしまう)。
  const u = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (map[r][c] === roadVal) u.push(roadUse[r * n + c]);
  if (!u.length) return out;
  u.sort((a, b) => a - b);
  const med = u[u.length >> 1];

  // 1) 素の目標クラス
  const want = new Int8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    if (map[r][c] !== roadVal) continue;
    const deg = maskDegree(roadMask(map, r, c, roadVal));
    if (deg <= 1) { want[i] = PATH; continue; }            // 袋小路
    if (med <= 0) { want[i] = ONEWAY; continue; }
    const v = roadUse[i];
    if (v >= med * CLASS_HI) { want[i] = TWOLANE; continue; }
    want[i] = (v < med * CLASS_LO && deg <= PATH_MAX_DEGREE) ? PATH : ONEWAY;
  }

  // 2) 平滑化。1 セルだけ幅が違う道は見た目に破綻するので、自分と道の隣接
  //    セルの**中央値**に寄せる。平均でなく中央値なのは、交差点で 4 方向の
  //    クラスが割れたときに中間値 (存在しない幅) を作らないため。
  const smooth = new Int8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    if (map[r][c] !== roadVal) continue;
    const vs = [want[i]];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < n && nc >= 0 && nc < n && map[nr][nc] === roadVal) vs.push(want[nr * n + nc]);
    }
    vs.sort((a, b) => a - b);
    smooth[i] = vs[vs.length >> 1];
    // 平滑化は隣の値に引きずられるので、交差点まで歩行者専用に落ちることがある。
    // 次数 3 以上のセルは必ず車が通れる格に留める (網を切らないための最低保証)。
    if (smooth[i] === PATH && maskDegree(roadMask(map, r, c, roadVal)) > PATH_MAX_DEGREE)
      smooth[i] = ONEWAY;
  }

  // 3) ヒステリシス。1 日 1 段階まで。
  for (let i = 0; i < out.length; i++) {
    if (!prev || prev.length !== out.length) { out[i] = smooth[i]; continue; }
    const p = prev[i], s = smooth[i];
    out[i] = s > p ? Math.min(s, p + 1) : (s < p ? Math.max(s, p - 1) : s);
  }
  return out;
}

// ── 縁石の立体 ──────────────────────────────────────────────────────────────
// road_curbs.json の折れ線を、縦の面 + 面取りに立ち上げる。断面はこうなる:
//
//     歩道面 (zWalk) ─┐
//                      \  面取り (chamfer)
//        天端 (zTop) ──┘
//                      │  縦の面 … 車道から見える
//     車道面 (zRoad) ──┘
//
// three に依存しないただの配列操作なので **server.js ではなくここに置く**。
// 巻き方と法線が食い違うと、両面描画でも裏面判定で法線が反転して陰影が壊れる。
// ここにあれば tools/check-road-atlas.js から直接呼んで検算できる。
//
// 巻き方は輪郭の向きに依存させない。d x n の符号を見て、必要なら線分の向きを
// 入れ替える。「輪郭はこの向きに巻いてある」という取り決めを生成側と描画側の
// 両方に持たせると、生成側を触ったときに静かに壊れるため。
function pushCurb(pos, nrm, lines, x0, y0, span, P) {
  const dz = P.zTop - P.zWalk;
  const L = Math.hypot(dz, P.chamfer) || 1, sn = dz / L, sz = P.chamfer / L;
  const q = (px, py, pz, nx, ny, nz) => { pos.push(px, py, pz); nrm.push(nx, ny, nz); };
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      let [ax, ay, anx, any] = line[i], [bx, by, bnx, bny] = line[i + 1];
      let wax = x0 + ax * span, way = y0 + ay * span;
      let wbx = x0 + bx * span, wby = y0 + by * span;
      if ((wbx - wax) * ((any + bny) / 2) - (wby - way) * ((anx + bnx) / 2) <= 0) {
        [wax, wbx] = [wbx, wax]; [way, wby] = [wby, way];
        [anx, bnx] = [bnx, anx]; [any, bny] = [bny, any];
      }
      // 縦の面 (法線は車道向き = -n)
      q(wax, way, P.zRoad, -anx, -any, 0); q(wbx, wby, P.zRoad, -bnx, -bny, 0);
      q(wbx, wby, P.zTop, -bnx, -bny, 0);
      q(wax, way, P.zRoad, -anx, -any, 0); q(wbx, wby, P.zTop, -bnx, -bny, 0);
      q(wax, way, P.zTop, -anx, -any, 0);
      // 面取り (天端から歩道面へ)
      const cax = wax + anx * P.chamfer, cay = way + any * P.chamfer;
      const cbx = wbx + bnx * P.chamfer, cby = wby + bny * P.chamfer;
      q(wax, way, P.zTop, anx * sn, any * sn, sz); q(wbx, wby, P.zTop, bnx * sn, bny * sn, sz);
      q(cbx, cby, P.zWalk, bnx * sn, bny * sn, sz);
      q(wax, way, P.zTop, anx * sn, any * sn, sz); q(cbx, cby, P.zWalk, bnx * sn, bny * sn, sz);
      q(cax, cay, P.zWalk, anx * sn, any * sn, sz);
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
// 道路の断面
// ────────────────────────────────────────────────────────────────────────────
// 以前は tools/make-road-atlas.js の中だけにあった (アトラスを焼くための形)。
// 観測レンダラの床キャストと、「いま足元が歩道か車道か」の判定が同じ形を必要と
// するのでこちらへ移した。**Python 側 (学習env) もこれと同じ式を持つこと。**
// 数式が 3 か所に散ると、学習と本番で歩道の位置がズレても誰も気付けない。
// ════════════════════════════════════════════════════════════════════════════
// ── 街の寸法 (正規化 0..1 = 1セル ≒ 7m) ───────────────────────────────────────
const RW2   = 0.33;   // 二車線: 車道の半幅 → 車道 4.6m / 歩道 1.2m x2
const RW1   = 0.24;   // 一通:   車道の半幅 → 車道 3.4m / 歩道 1.8m x2
// 曲がり角の内側の縁石の半径。**歩道の幅に連動させる**。
// 固定値にすると、歩道が広い一通 (class 1) で角の歩道が円形の島に潰れる。
// 角の歩道がセルの角と繋がる条件は R >= 歩道幅 * sqrt(2)/(1+sqrt(2)) = 0.586 倍
// (角 (1,0) から曲率中心までの距離 = (歩道幅-R)*sqrt(2) <= R より)。0.85 倍で余裕を取る。
const RIN_K = 0.85;
const rIn = RW => RIN_K*(0.5-RW);
// 外側の縁石は rIn + 車道幅 の**同心円**になる (実際の道路と同じ)。

const XW_A = 0.012, XW_B = 0.012;          // 横断歩道の帯の前後マージン
// 横断歩道の縞。日本の規格は幅 45cm / 間隔 45cm なので、1 セル 7.73m に対して
// 周期 0.9m ≒ 0.116。**縞の本数は車道幅から割り出す** (固定の周期だと端の縞が
// 中途半端に切れて縁石と重なる)。
const XW_PITCH = 0.116, XW_DUTY = 0.52;

// ── SDF ヘルパ ────────────────────────────────────────────────────────────────
// 矩形の符号付き距離。負 = 内側。
function sdBox(px,py, x0,y0,x1,y1){
  const cx=(x0+x1)/2, cy=(y0+y1)/2, hx=(x1-x0)/2, hy=(y1-y0)/2;
  const dx=Math.abs(px-cx)-hx, dy=Math.abs(py-cy)-hy;
  return Math.hypot(Math.max(dx,0), Math.max(dy,0)) + Math.min(Math.max(dx,dy), 0);
}
// (次数の数え上げは上の maskDegree が持っている。移設時に同じ関数を持ち込んで
//  いたので、こちらは maskDegree を指すだけにする。)
const popcount = maskDegree;

// 隅の象限。q は「dir q と dir q+1 の間」。P = セル中心にいちばん近い角、
// (su,sv) = そこから象限の内側へ向かう符号。
//   q=0 NE(N&E)  q=1 SE(E&S)  q=2 SW(S&W)  q=3 NW(W&N)
function quadrants(lo, hi){
  return [
    {a:0,b:1, box:[hi, 0, 1, lo], pu:hi, pv:lo, su:+1, sv:-1},
    {a:1,b:2, box:[hi,hi, 1,  1], pu:hi, pv:hi, su:+1, sv:+1},
    {a:2,b:3, box:[ 0,hi,lo,  1], pu:lo, pv:hi, su:-1, sv:+1},
    {a:3,b:0, box:[ 0, 0,lo, lo], pu:lo, pv:lo, su:-1, sv:-1},
  ];
}

// 角を r で丸めた「象限」の SDF。負 = 内側。
// a,b は 2 本の境界線までの符号付き距離 (どちらも負なら象限の内側)。
// 角が r の円弧で落とされた形になる。これが**歩道の隅**の形そのもの。
function sdRoundedQuad(a,b,r){
  const ax=Math.max(a+r,0), bx=Math.max(b+r,0);
  return Math.hypot(ax,bx) + Math.min(Math.max(a+r,b+r),0) - r;
}

// 車道領域の SDF。負 = 車道の内側。
//
// ── 腕の和ではなく「歩道の交わり」として作る ──
// 以前は腕 (arm) の和を取り、隅に `max(象限ボックス, 円の外)` でフィレットを
// 足していた。**形は正しいが SDF としては壊れていた**: 象限ボックスの壁
// (u=hi) が稜線になり、車道の内部に値 0 の線ができる。図形は変わらないので
// 塗り分けには出ないが、
//   ・黄色い外側線が、その偽の線に沿って車道の中にも引かれる
//   ・縁石の輪郭抽出 (マーチングスクエア) がその偽の線を拾う
// という形で漏れ出す。実際 T 字と十字で法線が反転した頂点が 96 点出た。
//
// 正しくは「車道 = すべての歩道領域の**外側**」= 補集合の交わり (max)。
//   繋がっていない側      → 交差点ボックスの外がまるごと歩道 (半平面)
//   両隣が繋がっている隅  → 角を rIn(RW) で丸めた象限が歩道
// 図形は以前と厳密に一致する (象限 ∩ 円の外 = 象限 - 角丸象限) が、
// こちらは車道のどこでも「いちばん近い歩道までの距離」になる。
//
// 曲がり角 (隣り合う2方向だけが道) だけは別扱いで、**同心の円環**にする。
//   内側の縁石 = 半径 rIn(RW) / 外側の縁石 = 半径 rIn(RW) + 車道幅、中心は共通。
//   内外のカーブが実際の道路と同じ同心円になる。
function roadSDF(u,v,mask,RW){
  const lo=0.5-RW, hi=0.5+RW, n=popcount(mask);
  if(n===0) return 1e9;                                   // 孤立 = 全面が舗装
  if(n===2 && mask!==5 && mask!==10) return cornerSDF(u,v,mask,RW);
  const r=rIn(RW);
  // 軸に平行な制約はまとめて 1 個の矩形にする。半平面を素の max で畳むと
  // 外側がチェビシェフ距離になり、凸角の外で「いちばん近い車道までの距離」を
  // 過小評価する (縁石天端の帯が角で四角く広がる)。矩形の SDF なら外側も厳密。
  //   繋がっている側は制約を掛けない = セルの外まで伸ばす
  let d=sdBox(u,v, (mask&8)?-0.5:lo, (mask&1)?-0.5:lo,
                   (mask&2)? 1.5:hi, (mask&4)? 1.5:hi);
  for(const q of quadrants(lo,hi)){
    if(!((mask&(1<<q.a)) && (mask&(1<<q.b)))) continue;    // 両側が道の隅だけ丸める
    const a=(q.su>0) ? hi-u : u-lo;
    const b=(q.sv>0) ? hi-v : v-lo;
    d=Math.max(d, -sdRoundedQuad(a,b,r));
  }
  return d;
}

// 曲がり角の曲率中心。内側の縁石が「N/S 側の腕の側面」と「E/W 側の腕の側面」の
// 両方に接する点として一意に決まる (接する条件から C = 側面 ± rIn(RW))。
function cornerCenter(mask, RW){
  const lo=0.5-RW, hi=0.5+RW, r=rIn(RW);
  return [ (mask&2) ? hi+r : lo-r,            // E が道なら右寄り、W なら左寄り
           (mask&4) ? hi+r : lo-r ];          // S が道なら下寄り、N なら上寄り
}
// 曲がり角の車道 = 同心円環。中心が必ずセルの角に来るので、単位セル内に現れるのは
// ちょうど四半分だけ = 余計なクリップが要らない。
function cornerSDF(u,v,mask,RW){
  const [Cu,Cv]=cornerCenter(mask, RW), r=rIn(RW);
  const d=Math.hypot(u-Cu, v-Cv);
  return Math.max(d-(2*RW+r), r-d);
}


// 横断歩道。交差点 (n>=3) の各腕の、セル端と交差点ボックスの間の帯に縞を引く。
// 縞は**進行方向に沿って伸び、道幅の方向に繰り返す** (日本の横断歩道)。
// 最初これを 90 度取り違えて、縞が進行方向に直交して並んでいた。
//   s = その腕の端からの奥行き (進行方向)   w = 道幅の方向
// 縞が伸びるのは s、繰り返すのは w。
function crosswalk(u,v,mask,RW){
  const lo=0.5-RW, hi=0.5+RW, W=hi-lo;
  const n=Math.max(4, Math.round(W/XW_PITCH));   // 車道幅に収まる本数
  const p=W/n;                                   // 実際の周期 (幅を割り切る)
  const arms=[[1, v,   u], [2, 1-u, v], [4, 1-v, u], [8, u,   v]];
  for(const [bit, s, w] of arms){
    if(!(mask&bit)) continue;
    if(w<lo || w>hi) continue;                   // その腕の車道幅の中だけ
    if(s<XW_A || s>lo-XW_B) continue;            // 帯の奥行き
    if((((w-lo)/p)%1)*p < p*XW_DUTY) return true;
  }
  return false;
}
// ── 足元に何があるか ────────────────────────────────────────────────────────
// 床の描画にも、歩道を優先して歩かせる判定にも、学習の報酬にも、これを使う。
const GROUND = {
  GRASS: 0,      // 芝 (木のセル)
  DIRT: 1,       // 空き地
  PAVE: 2,       // 建物の足元の舗装
  SIDEWALK: 3,   // 歩道 ← 歩行者はここを歩きたい
  CROSSWALK: 4,  // 横断歩道 ← 車道を渡るならここ
  ROADWAY: 5,    // 車道 ← 歩行者は避けたい
};
// 歩行者にとっての好ましさ。報酬と経路コストの両方がこの並びを使う。
// 芝や空き地は「最悪入っても大丈夫」なので車道より上に置く。
const WALK_PREF = {
  [GROUND.SIDEWALK]: 1.00, [GROUND.CROSSWALK]: 1.00, [GROUND.PAVE]: 0.85,
  [GROUND.DIRT]: 0.55, [GROUND.GRASS]: 0.50, [GROUND.ROADWAY]: 0.00,
};

/**
 * セル (r,c) の中の相対位置 (fu, fv) に何があるか。fu,fv は 0..1 で
 * fu = +列方向 (東)、fv = +行方向 (南)。タイル画像と同じ向き。
 *   cellType … OTHER / ROAD / BUILDING / TREE (world.js の値)
 *   cls      … その セルの道路クラス (PATH/ONEWAY/TWOLANE)。道でなければ無視
 *   mask     … 4 近傍マスク。道でなければ無視
 */
function groundKind(cellType, cls, mask, fu, fv, V) {
  const T = V || { OTHER: 0, ROAD: 1, BUILDING: 2, TREE: 3 };
  if (cellType === T.BUILDING) return GROUND.PAVE;
  if (cellType === T.TREE) return GROUND.GRASS;
  if (cellType !== T.ROAD) return GROUND.DIRT;
  if (cls === PATH) return GROUND.SIDEWALK;           // 歩行者専用は全面が歩道
  const RW = cls >= TWOLANE ? RW2 : RW1;
  if (roadSDF(fu, fv, mask, RW) >= 0) return GROUND.SIDEWALK;
  // 車道の上。交差点の取り付きだけ横断歩道が塗ってある。
  if (maskDegree(mask) >= 3 && crosswalk(fu, fv, mask, RW)) return GROUND.CROSSWALK;
  return GROUND.ROADWAY;
}

// ── 観測に映る地面の色 ──────────────────────────────────────────────────────
// 床キャストが引く色。**Python 側 (学習env) と同じ値でなければならない**ので
// ここに置く。道路セルはアトラスの画素をこのアスファルトの上に合成したものを使う
// (アトラスは車道の内側が透明なため)。
const FLOOR_RGB = {
  ASPHALT: [0.265, 0.275, 0.295],   // 車道・建物の足元の下地
  GRASS:   [0.355, 0.485, 0.275],   // 木のセル
  DIRT:    [0.545, 0.530, 0.420],   // 空き地
  VOID:    [0.095, 0.105, 0.120],   // 世界の果て
};
// 床の距離の上限 (セル)。これより遠い行は地の色のままにして、走査量を抑える。
const FLOOR_MAX = 40;
// 目線の高さ (セル)。地平線の位置を決める。壁の投影 bot = H/2 + (H/perp)*EYE と
// 同じ値でなければ、床と壁の足元が段差になる。
const FLOOR_EYE = 0.5;

/**
 * 画面の行 y (0..H-1) が指す地面までの垂直距離。
 * 壁の足元の投影 bot = H/2 + (H/perp)*FLOOR_EYE を perp について解いたもの。
 * **この式が学習側とズレると、観測画像の遠近が食い違う。**
 */
function floorDist(y, H) {
  const p = y - H / 2;
  return p <= 0 ? Infinity : (H * FLOOR_EYE) / p;
}

// 観測用の床テクスチャを焼く。アトラスの RGBA から、枠ごとに RC_FW 角へ縮小し、
// **透明部 (車道) をアスファルトの上に合成して不透明にする**。
// 毎画素で合成しないための前処理でもあるが、いちばんの理由は
// **Python 側 (学習env) と同じ縮小規則を使わせるため**。ここが 1 画素ずれると
// 学習と本番で観測画像が食い違う。
//   出力画素 (i,j) = 元の [i*CONTENT/RC_FW, (i+1)*CONTENT/RC_FW) の範囲の平均。
const RC_FW = 24;                       // 1 枠あたりの床テクスチャの一辺

function bakeFloorBank(rgba, width) {
  if (width !== ATLAS) throw new Error(`bakeFloorBank: アトラスの幅が ${width} (期待 ${ATLAS})`);
  const asp = FLOOR_RGB.ASPHALT;
  const nSlot = COLS * ROWS;
  const out = new Float32Array(nSlot * RC_FW * RC_FW * 3);
  for (let s = 0; s < nSlot; s++) {
    const ox = (s % COLS) * TILE + GUT, oy = ((s / COLS) | 0) * TILE + GUT;
    for (let j = 0; j < RC_FW; j++) for (let i = 0; i < RC_FW; i++) {
      const x0 = Math.floor(i * CONTENT / RC_FW), x1 = Math.max(x0 + 1, Math.floor((i + 1) * CONTENT / RC_FW));
      const y0 = Math.floor(j * CONTENT / RC_FW), y1 = Math.max(y0 + 1, Math.floor((j + 1) * CONTENT / RC_FW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (((oy + y) * ATLAS) + (ox + x)) * 4, a = rgba[o + 3] / 255;
        r += (rgba[o] / 255) * a + asp[0] * (1 - a);
        g += (rgba[o + 1] / 255) * a + asp[1] * (1 - a);
        b += (rgba[o + 2] / 255) * a + asp[2] * (1 - a);
        n++;
      }
      const k = (s * RC_FW * RC_FW + j * RC_FW + i) * 3;
      out[k] = r / n; out[k + 1] = g / n; out[k + 2] = b / n;
    }
  }
  return out;
}

/** セルの中で「歩行者が居たい横位置」。道に沿って歩くときの車線ならぬ歩道の中心。 */
function sidewalkOffset(cls) {
  if (cls === PATH) return 0;                // 歩行者専用は全面が歩道 = 中央でよい
  const RW = cls >= TWOLANE ? RW2 : RW1;
  // 歩道は車道の縁 (RW) からセルの端 (0.5) まで。その中心を返す。
  // 最初 (0.5 + (0.5-RW)*0.5) - 0.5 = 0.085 と書いて**車道の内側**を指していた。
  return RW + (0.5 - RW) * 0.5;
}

module.exports = {
  PATH, ONEWAY, TWOLANE,
  TILE, GUT, CONTENT, COLS, ROWS, ATLAS, SLOT_BASE, SLOT_USED,
  roadMask, maskDegree, atlasSlot, atlasUV,
  CLASS_HI, CLASS_LO, PATH_MAX_DEGREE, classifyRoads, pushCurb,
  RW2, RW1, RIN_K, rIn, XW_A, XW_B, XW_PITCH, XW_DUTY,
  sdBox, sdRoundedQuad, quadrants, roadSDF, cornerCenter, cornerSDF, crosswalk,
  GROUND, WALK_PREF, groundKind, sidewalkOffset,
  FLOOR_RGB, FLOOR_MAX, FLOOR_EYE, floorDist, RC_FW, bakeFloorBank,
};
