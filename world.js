// mesa-runtime/world.cjs — 世界の物理とマップ生成.
//
// **配置先では world.js にリネームして使う。** mesa-env の js/ は ESM
// (ブラウザ向け) なので .cjs にしてあるが、server.js は CommonJS なので
// mesa-clouds-renderer には world.js として置き、require('./world.js') する。
//
// server.js から切り出した共有ロジック。Python 側 (mesa_env/world.py, maps.py) と
// 同じ結果を返すことが golden vector で検証される。
//
// ── なぜ切り出すか ──
// マップ生成が server.js と学習ノートブックに二重実装されていて、道路削除率が
// 学習 0.25〜0.50 / 本番 0.30〜0.55 とズレていた。golden vector はマップを
// データとして受け取るので、この種のズレを検出できない。実装を一本化する。
//
// ── ALIGNED 世界 ──
// 現行 (LEGACY) は「見えるもの」と「通れるもの」がほぼ反転している:
//     建物 = レイが止まる(見える) かつ 通れる
//     木   = レイが素通り(見えない) かつ 通れない
// このため描画レイ距離と進行可能距離の相関は 0.19 しかなく、画像から通行可否を
// 導くことが原理的に不可能。ALIGNED では
//     見える   = {建物, 木}   = 通れない
//     見えない = {道路, 空き地} = 通れる
// となり相関 1.00 (実測誤差 0.017 セル)。外の世界 (BTYPE/PASS 配列が存在しない
// 環境) で動かすための前提条件。

const OTHER = 0, ROAD = 1, BUILDING = 2, TREE = 3;
const D4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// ── 世界設定 ────────────────────────────────────────────────────────────────
const LEGACY = Object.freeze({
  solidBuildings: false, visibleTrees: false, walkableEmpty: false,
});
const ALIGNED = Object.freeze({
  solidBuildings: true, visibleTrees: true, walkableEmpty: true,
});

/** meta.json から世界設定を読む。旧 meta (フィールド無し) は LEGACY 扱い。 */
function worldFromMeta(meta) {
  if (!meta || meta.solid_buildings === undefined) return LEGACY;
  return Object.freeze({
    solidBuildings: !!meta.solid_buildings,
    visibleTrees: !!meta.visible_trees,
    walkableEmpty: !!meta.walkable_empty,
  });
}

/** 通行可能なセル種別の Set。buildAux の obstacle もこれを参照する。 */
function passableSet(world) {
  if (!world.solidBuildings) return new Set([ROAD, BUILDING]);
  return world.walkableEmpty ? new Set([ROAD, OTHER]) : new Set([ROAD]);
}

/** レイを止めるセルか。ALIGNED では !passable と一致する。 */
function blocksSight(world, cell) {
  if (cell === BUILDING) return true;
  return world.visibleTrees && cell === TREE;
}

// ── マップ生成 ──────────────────────────────────────────────────────────────
// mesa_env/maps.py の make_map_organic と bit-identical。
// **削除率は 0.25 + rng*0.25。** server.js の旧実装は 0.30 始まりで学習側とズレていた。
function makeMap(size, seed) {
  let s = seed >>> 0;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  const ri = n => Math.floor(rng() * n);
  const pick = a => a[ri(a.length)];

  const g = Array.from({ length: size }, () => new Array(size).fill(OTHER));
  const step = 4, rows = [], cols = [];
  for (let i = 0; i < size; i += step) { rows.push(i); cols.push(i); }
  rows.forEach(r => { for (let c = 0; c < size; c++) g[r][c] = ROAD; });
  cols.forEach(c => { for (let r = 0; r < size; r++) g[r][c] = ROAD; });

  for (let ri2 = 0; ri2 < rows.length - 1; ri2++) {
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const r0 = rows[ri2] + 1, r1 = rows[ri2 + 1], c0 = cols[ci] + 1, c1 = cols[ci + 1];
      const cells = [];
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) cells.push([r, c]);
      if (!cells.length) continue;
      let patch = null;
      if (r1 - r0 >= 2 && c1 - c0 >= 2 && rng() < 0.42) {
        const pr = (rng() < 0.5) ? r0 : r1 - 2, pc = (rng() < 0.5) ? c0 : c1 - 2;
        for (let r = pr; r < pr + 2; r++) for (let c = pc; c < pc + 2; c++) g[r][c] = BUILDING;
        patch = { pr, pc };
      }
      const b = pick(cells); g[b[0]][b[1]] = BUILDING;
      cells.forEach(([r, c]) => {
        if (r === b[0] && c === b[1]) return;
        if (patch && r >= patch.pr && r < patch.pr + 2 && c >= patch.pc && c < patch.pc + 2) return;
        const v = rng();
        if (v < .25) g[r][c] = TREE; else if (v < .45) g[r][c] = BUILDING;
      });
    }
  }
  rows.forEach(r => { for (let c = 0; c < size; c++) g[r][c] = ROAD; });
  cols.forEach(c => { for (let r = 0; r < size; r++) g[r][c] = ROAD; });

  const isX = (r, c) => rows.includes(r) && cols.includes(c);
  const cands = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
    if (g[r][c] === ROAD && !isX(r, c)) cands.push([r, c]);
  for (let i = cands.length - 1; i > 0; i--) { const j = ri(i + 1);[cands[i], cands[j]] = [cands[j], cands[i]]; }

  const roadOK = grid => {
    let sr = -1, sc = -1;
    outer: for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (grid[r][c] === ROAD) { sr = r; sc = c; break outer; }
    if (sr < 0) return true;
    const vis = new Set([sr * size + sc]), q = [[sr, sc]];
    while (q.length) {
      const [r, c] = q.shift();
      for (const [dr, dc] of D4) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const k = nr * size + nc;
        if (!vis.has(k) && grid[nr][nc] === ROAD) { vis.add(k); q.push([nr, nc]); }
      }
    }
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (grid[r][c] === ROAD && !vis.has(r * size + c)) return false;
    return true;
  };

  const maxRm = Math.floor(cands.length * (0.25 + rng() * 0.25));
  let rm = 0;
  for (const [r, c] of cands) {
    if (rm >= maxRm) break;
    g[r][c] = OTHER;
    if (roadOK(g)) { g[r][c] = rng() < 0.4 ? TREE : OTHER; rm++; } else g[r][c] = ROAD;
  }
  return g;
}

// ── 連結性とマップ補修 ──────────────────────────────────────────────────────
function passableMask(map, world) {
  const P = passableSet(world), n = map.length;
  return map.map(row => row.map(v => P.has(v)));
}

/** 通行可能セルの最大連結成分。袋小路や孤立セルは入口にならないので除く。 */
function largestComponent(pass) {
  const n = pass.length;
  const seen = pass.map(r => r.map(() => false));
  let best = null, bestN = 0;
  for (let r0 = 0; r0 < n; r0++) for (let c0 = 0; c0 < n; c0++) {
    if (!pass[r0][c0] || seen[r0][c0]) continue;
    const comp = pass.map(r => r.map(() => false));
    const q = [[r0, c0]]; seen[r0][c0] = true; comp[r0][c0] = true;
    let cnt = 1;
    while (q.length) {
      const [r, c] = q.shift();
      for (const [dr, dc] of D4) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        if (!pass[nr][nc] || seen[nr][nc]) continue;
        seen[nr][nc] = true; comp[nr][nc] = true; cnt++; q.push([nr, nc]);
      }
    }
    if (cnt > bestN) { best = comp; bestN = cnt; }
  }
  return best || pass.map(r => r.map(() => false));
}

/**
 * 到達不能な建物が 1 つも残らないようマップを補修する。
 * 抽選から外す (= 建物が減る) のではなく、隣の木を空き地に変えて**入口を作る**。
 * 実測: 補修前 93.7% -> 補修後 100%、建物数 3814 -> 3774 でほぼ維持。
 */
function ensureAllBuildingsReachable(map, world) {
  const n = map.length;
  const g = map.map(r => r.slice());
  for (let pass = 0; pass < 4; pass++) {
    const comp = largestComponent(passableMask(g, world));
    const stuck = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (g[r][c] !== BUILDING) continue;
      const ok = D4.some(([dr, dc]) => {
        const nr = r + dr, nc = c + dc;
        return nr >= 0 && nr < n && nc >= 0 && nc < n && comp[nr][nc];
      });
      if (!ok) stuck.push([r, c]);
    }
    if (!stuck.length) break;
    for (const [r, c] of stuck) {
      let best = null;
      for (const [dr, dc] of D4) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
        if (g[nr][nc] !== TREE && g[nr][nc] !== OTHER) continue;
        const touches = D4.filter(([a, b]) => {
          const rr = nr + a, cc = nc + b;
          return rr >= 0 && rr < n && cc >= 0 && cc < n && comp[rr][cc];
        }).length;
        if (!best || touches > best[0]) best = [touches, nr, nc];
      }
      if (best && best[0] > 0) g[best[1]][best[2]] = OTHER;
    }
  }
  // 4 回補修しても孤立している建物は空き地にする (最後の手段)
  const comp = largestComponent(passableMask(g, world));
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (g[r][c] !== BUILDING) continue;
    const ok = D4.some(([dr, dc]) => {
      const nr = r + dr, nc = c + dc;
      return nr >= 0 && nr < n && nc >= 0 && nc < n && comp[nr][nc];
    });
    if (!ok) g[r][c] = OTHER;
  }
  return g;
}

/** ゴール/拠点にできる建物 = 通行可能領域に接している建物。 */
function reachableBuildings(map, world) {
  const n = map.length;
  const comp = largestComponent(passableMask(map, world));
  const out = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (map[r][c] !== BUILDING) continue;
    if (D4.some(([dr, dc]) => {
      const nr = r + dr, nc = c + dc;
      return nr >= 0 && nr < n && nc >= 0 && nc < n && comp[nr][nc];
    })) out.push([r, c]);
  }
  return out;
}

/** 建物 (br,bc) の玄関 = 隣接する通行可能セル。屋内から出るときの立ち位置。 */
function doorCell(map, world, br, bc) {
  const n = map.length, P = passableSet(world);
  const comp = largestComponent(passableMask(map, world));
  for (const [dr, dc] of D4) {
    const nr = br + dr, nc = bc + dc;
    if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
    if (P.has(map[nr][nc]) && comp[nr][nc]) return [nr, nc];
  }
  return null;
}

// ── 屋内状態 ────────────────────────────────────────────────────────────────
// solidBuildings では建物セルに立てない。生活シミュレーション (自宅/職場/欲求) は
// エージェントが建物を占有する前提なので、屋内を「物理と方策の外」として扱う。
//   屋内: 座標は建物セル。描画は非表示。方策推論・移動・obstacle はスキップ。
//   外出: 玄関セルに置き、建物の方を向かせて再開。

/** 建物に入る。到着後に呼ぶ。 */
function enterBuilding(agent, br, bc) {
  agent.indoors = [br, bc];
  agent.x = br + 0.5; agent.y = bc + 0.5;
  agent.path = null; agent.pathIdx = 0;
}

/** 建物から出る。玄関が塞がっていれば false (屋内に留まる)。 */
function exitBuilding(agent, map, world) {
  if (!agent.indoors) return true;
  const [br, bc] = agent.indoors;
  const door = doorCell(map, world, br, bc);
  if (!door) return false;
  agent.x = door[0] + 0.5; agent.y = door[1] + 0.5;
  agent.th = Math.atan2(bc - door[1], br - door[0]) + Math.PI;  // 建物に背を向ける
  agent.indoors = null;
  return true;
}

const isIndoors = agent => !!agent.indoors;

/**
 * 到着判定。LEGACY は建物セルに立つ、ALIGNED は 4 近傍で接する (= 玄関に着く)。
 */
function hasArrived(world, r, c, gr, gc) {
  if (!world.solidBuildings) return r === gr && c === gc;
  return Math.abs(r - gr) + Math.abs(c - gc) <= 1;
}

module.exports = {
  OTHER, ROAD, BUILDING, TREE, D4,
  LEGACY, ALIGNED, worldFromMeta,
  passableSet, blocksSight, makeMap,
  passableMask, largestComponent, ensureAllBuildingsReachable,
  reachableBuildings, doorCell,
  enterBuilding, exitBuilding, isIndoors, hasArrived,
};
