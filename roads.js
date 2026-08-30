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

module.exports = {
  PATH, ONEWAY, TWOLANE,
  TILE, GUT, CONTENT, COLS, ROWS, ATLAS, SLOT_BASE, SLOT_USED,
  roadMask, maskDegree, atlasSlot, atlasUV,
  CLASS_HI, CLASS_LO, PATH_MAX_DEGREE, classifyRoads, pushCurb,
};
