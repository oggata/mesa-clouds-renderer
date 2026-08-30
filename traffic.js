// traffic.js — 車の出入口・経路・走行。
//
// **住民とは完全に別系統にする。** 住民は ONNX 推論・屋内状態・欲求・人間関係を
// 持つが、車にはどれも要らない。混ぜると住民側の不変条件を壊すリスクだけが増える。
// ここは three にも server.js にも依存しない純粋な計算なので、単体で検証できる。
//
// ── 街の中を周回させない ──
// 自分の街だけをぐるぐる回る車はリアリティが無い。外周で「街の外」に面している
// 走行可能な道を**他の町との接点 (gateway)** とみなし、そこから湧いて別の接点で
// 消える。街の中の移動ではなく通過交通として扱う。
//
// ── 座標 ──
// 経路はセル [r,c] だが、走行はワールド座標で持つ。server.js のワールドは
//   x = 列(c)*CELL + CELL/2 、 y = 行(r)*CELL + CELL/2
// で、住民の a.x が行・a.y が列という紛らわしい対応になっている。車まで同じ
// 持ち方にすると必ずどこかで取り違えるので、車は最初からワールド座標で持つ。

'use strict';

const D4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function drivable(map, roadClass, r, c, roadVal, minClass) {
  const n = map.length;
  return r >= 0 && r < n && c >= 0 && c < n
      && map[r][c] === roadVal && roadClass[r * n + c] >= minClass;
}

/**
 * 他の町との接点。走行可能な道が街の外 (範囲外 or VOID) に面しているセル。
 * dr,dc は外を向く方向 = 車が入ってくる向きの逆。
 */
function gateways(map, roadClass, roadVal, voidVal, minClass = 1) {
  const n = map.length, out = [];
  const outside = (r, c) => r < 0 || r >= n || c < 0 || c >= n || map[r][c] === voidVal;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!drivable(map, roadClass, r, c, roadVal, minClass)) continue;
    for (const [dr, dc] of D4) if (outside(r + dr, c + dc)) { out.push({ r, c, dr, dc }); break; }
  }
  return out;
}

/** 走行可能な道だけを通る最短経路。見つからなければ null。 */
function route(map, roadClass, from, to, roadVal, minClass = 1) {
  const n = map.length, src = from.r * n + from.c, dst = to.r * n + to.c;
  if (src === dst) return null;
  const prev = new Int32Array(n * n).fill(-1);
  prev[src] = src;
  const q = [src];
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    if (u === dst) break;
    const r = (u / n) | 0, c = u % n;
    for (const [dr, dc] of D4) {
      const nr = r + dr, nc = c + dc, v = nr * n + nc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n || prev[v] >= 0) continue;
      if (!drivable(map, roadClass, nr, nc, roadVal, minClass)) continue;
      prev[v] = u; q.push(v);
    }
  }
  if (prev[dst] < 0) return null;
  const p = [];
  for (let v = dst; v !== src; v = prev[v]) p.push([(v / n) | 0, v % n]);
  p.push([from.r, from.c]);
  return p.reverse();
}

/**
 * 経路 (セル列) を走行線に変換する。左側通行なので進行方向の**左**へ寄せる。
 * 返す各点は {x, y, r, c, dir, junction}。ワールド座標。
 *   dir      … その点へ入る向き (0=N 1=E 2=S 3=W)。占有の鍵に使う
 *   junction … 走行可能な道が 3 方向以上つながるセル (交差点)
 */
function laneLine(path, map, roadClass, roadVal, minClass, CELL, laneOff) {
  const n = map.length;
  const W = ([r, c]) => ({ x: c * CELL + CELL * 0.5, y: r * CELL + CELL * 0.5 });
  const dirOf = (dr, dc) => dr < 0 ? 0 : (dc > 0 ? 1 : (dr > 0 ? 2 : 3));
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const p = W(path[i]);
    const a = W(path[Math.max(0, i - 1)]), b = W(path[Math.min(path.length - 1, i + 1)]);
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const [r, c] = path[i];
    // z 上向きの右手系なので、進行方向 (dx,dy) の左は (-dy, dx)。
    // 一車線 (格 1) も少しだけ寄せる。まったく寄せないと対向車が完全に重なる。
    const cls = roadClass[r * n + c];
    const off = cls >= 2 ? laneOff : laneOff * 0.6;
    let deg = 0;
    for (const [dr, dc] of D4) if (drivable(map, roadClass, r + dr, c + dc, roadVal, minClass)) deg++;
    const prev = path[Math.max(0, i - 1)];
    out.push({
      x: p.x - dy * off, y: p.y + dx * off, r, c,
      dir: i ? dirOf(r - prev[0], c - prev[1]) : dirOf(path[1][0] - r, path[1][1] - c),
      junction: deg >= 3,
    });
  }
  return out;
}

// 占有の鍵。
//   交差点        … セルだけ (どの向きからでも取り合う = 譲り合いになる)
//   それ以外の道  … セル + 進行方向 (対向車は別の車線なので取り合わない)
// これを分けないと、二車線道路で対向車どうしが同じセルを待ち合って**必ず**
// デッドロックする (実測: 24 台中 17 台が停止、完走 0)。
function occKey(p) {
  return p.junction ? (p.r * 100000 + p.c) * 8 : ((p.r * 100000 + p.c) * 8 + 1 + p.dir);
}

/** 車を 1 台つくる。gw から入り、路線に沿って走る。 */
function makeCar(line, speed, kind) {
  const p = line[0], q = line[Math.min(1, line.length - 1)];
  return {
    line, idx: 1, kind, speed, v: 0, wait: 0,
    x: p.x, y: p.y,
    th: Math.atan2(q.y - p.y, q.x - p.x),
    cell: occKey(p),
    done: false,
  };
}

/**
 * 車を進める。dt は秒。
 * 前が埋まっていれば減速して待つ = 交差点に列ができる。ただし待ち続けると
 * 交差点で互いに譲り合ったまま固まるので、**一定時間待ったら強制的に進む**。
 * 信号を入れるときは、この block の判定に「赤なら停止線で止める」を足す。
 */
function stepCars(cars, dt, opts) {
  // turnRate は旋回のきつさ。速度 v で角速度 w の旋回半径は v/w なので、
  // これが小さすぎると車はウェイポイントに近づけず周りを回り続ける。
  const O = Object.assign({ accel: 2.2, brake: 6.0, turnRate: 4.5, arrive: 0.5, force: 2.5 }, opts || {});
  const occ = new Map();
  for (const car of cars) if (!car.done) occ.set(car.cell, car);
  for (const car of cars) {
    if (car.done) continue;
    const tgt = car.line[car.idx];
    if (!tgt) { car.done = true; continue; }
    const dx = tgt.x - car.x, dy = tgt.y - car.y;
    // 通り過ぎたかどうかも見る。距離だけで判定すると、旋回半径より内側に
    // 入れない車がウェイポイントの周りを**永久に周回する** (実測: 交差点に
    // 円い軌跡が残った)。区間の向きと目標へのベクトルが逆を向いたら通過済み。
    const pv = car.line[car.idx - 1] || car.line[0];
    const passed = dx * (tgt.x - pv.x) + dy * (tgt.y - pv.y) < 0;
    if (passed || Math.hypot(dx, dy) < O.arrive) {
      car.idx++;
      if (car.idx >= car.line.length) { car.done = true; continue; }
      const k = occKey(tgt);
      occ.delete(car.cell); car.cell = k; occ.set(k, car);
      car.wait = 0;
      continue;
    }
    const key = occKey(tgt);
    const taken = occ.has(key) && occ.get(key) !== car;
    // 待ちが長引いたら詰まりとみなして押し通す (恒久デッドロックを作らない)
    const blocked = taken && car.wait < O.force;
    car.wait = taken ? car.wait + dt : 0;
    car.v += (blocked ? -O.brake : O.accel) * dt;
    car.v = Math.max(0, Math.min(car.speed, car.v));
    let want = Math.atan2(dy, dx) - car.th;
    want = Math.atan2(Math.sin(want), Math.cos(want));
    const mx = O.turnRate * dt;
    car.th += Math.max(-mx, Math.min(mx, want));
    car.x += Math.cos(car.th) * car.v * dt;
    car.y += Math.sin(car.th) * car.v * dt;
  }
  return cars.filter(c => !c.done);
}

module.exports = { D4, drivable, gateways, route, laneLine, occKey, makeCar, stepCars };
