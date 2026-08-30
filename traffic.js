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

/**
 * 街の中の**行き止まり**。走行可能な道でありながら、走行可能な隣が 1 つしか
 * 無いセル (袋小路の突き当たり)。
 *
 * ── なぜこれが要るか ──
 * 出入口どうしを結ぶだけだと、車は「通り抜けられる道」しか走らない。実測すると
 * 30x30 の街で走行可能な道 295 セルのうち **107 セル (36%) が行き止まり**で、
 * 何時間走らせても永久に車が来ない。「通っていない道がたくさんある」の正体は
 * 経路の偏りではなくこれだった (経路をばらけさせても踏破率は 64% で頭打ちになる)。
 *
 * ここを発着点にも使うと、そういう道にも車が入る。透明度のフェードがあるので、
 * 突き当たりで消える車は「着いて駐めた」、湧く車は「出発した」ように見える。
 * 次数 1 に限るのは、通り抜けの途中で車が湧いたり消えたりすると不自然だから。
 */
function deadEnds(map, roadClass, roadVal, minClass = 1) {
  const n = map.length, out = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!drivable(map, roadClass, r, c, roadVal, minClass)) continue;
    let deg = 0;
    for (const [dr, dc] of D4) if (drivable(map, roadClass, r + dr, c + dc, roadVal, minClass)) deg++;
    if (deg <= 1) out.push({ r, c });
  }
  return out;
}

// 小さな二分ヒープ (ダイクストラ用)。優先度つき取り出しさえできればよいので、
// 依存を増やさず 30 行で済ませる。並列配列で持つのは、要素をオブジェクトにすると
// 経路 1 本ごとに数百個の短命オブジェクトができて GC が毎フレーム走るため。
function makeHeap() {
  const k = [], v = [];
  const swap = (a, b) => { const t = k[a]; k[a] = k[b]; k[b] = t;
                           const u = v[a]; v[a] = v[b]; v[b] = u; };
  return {
    size: () => k.length,
    push(key, val) {
      let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; swap(p, i); i = p; }
    },
    pop() {
      const top = v[0], lk = k.pop(), lv = v.pop();
      if (k.length) {
        k[0] = lk; v[0] = lv;
        for (let i = 0;;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < k.length && k[l] < k[m]) m = l;
          if (r < k.length && k[r] < k[m]) m = r;
          if (m === i) break;
          swap(m, i); i = m;
        }
      }
      return top;
    },
  };
}

/**
 * 走行可能な道だけを通る経路。見つからなければ null。
 *
 * ── 最短経路「だけ」だと街の道が余る ──
 * 出入口どうしを毎回最短で結ぶと、車は同じ数本の幹線しか通らない。走行可能な道の
 * 大半に一度も車が来ない絵になっていた (tools/preview-traffic.js の「走った道」で
 * 実測できる)。**同じ 2 点でも毎回ちがう道を選ばせる**のがここの役目。
 *
 *   opts.cost … セル (r,c) に入る重みを返す関数。渡すとダイクストラで最小化する。
 *               server.js は「最近ほかの車が通ったセルほど重い + セルごとの固定の
 *               ゆらぎ」を渡していて、これで経路が街じゅうに散る。
 *               渡さなければ従来どおりの幅優先 = 純粋な最短経路。通行量の集計
 *               (roadUse) など既存の呼び出しは重みを持たないので、挙動は変わらない。
 *   opts.ban  … 最初の一歩で入ってはいけないセル [r,c]。走行中に経路を引き直す
 *               とき、その場で U ターンさせないために使う。
 */
function route(map, roadClass, from, to, roadVal, minClass = 1, opts) {
  const n = map.length, src = from.r * n + from.c, dst = to.r * n + to.c;
  if (src === dst) return null;
  const cost = opts && opts.cost;
  const ban = (opts && opts.ban) ? opts.ban[0] * n + opts.ban[1] : -1;
  const prev = new Int32Array(n * n).fill(-1);
  prev[src] = src;
  if (!cost) {
    const q = [src];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      if (u === dst) break;
      const r = (u / n) | 0, c = u % n;
      for (const [dr, dc] of D4) {
        const nr = r + dr, nc = c + dc, v = nr * n + nc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n || prev[v] >= 0) continue;
        if (u === src && v === ban) continue;
        if (!drivable(map, roadClass, nr, nc, roadVal, minClass)) continue;
        prev[v] = u; q.push(v);
      }
    }
  } else {
    const dist = new Float64Array(n * n).fill(Infinity);
    const seen = new Uint8Array(n * n);
    const h = makeHeap();
    dist[src] = 0; h.push(0, src);
    while (h.size()) {
      const u = h.pop();
      if (seen[u]) continue;
      seen[u] = 1;
      if (u === dst) break;
      const r = (u / n) | 0, c = u % n;
      for (const [dr, dc] of D4) {
        const nr = r + dr, nc = c + dc, v = nr * n + nc;
        if (nr < 0 || nr >= n || nc < 0 || nc >= n || seen[v]) continue;
        if (u === src && v === ban) continue;
        if (!drivable(map, roadClass, nr, nc, roadVal, minClass)) continue;
        // 重みは必ず正にする。0 以下を許すと最短が定義できず経路が壊れる。
        const d = dist[u] + Math.max(0.01, cost(nr, nc));
        if (d < dist[v]) { dist[v] = d; prev[v] = u; h.push(d, v); }
      }
    }
  }
  if (prev[dst] < 0) return null;
  const p = [];
  for (let v = dst; v !== src; v = prev[v]) p.push([(v / n) | 0, v % n]);
  p.push([from.r, from.c]);
  return p.reverse();
}

/**
 * route(opts.cost) にそのまま渡せる「ばらけさせる重み」を作る。
 *
 *   n        … マップの一辺
 *   use      … セルごとの「最近どれだけ車が通ったか」 (0〜1 くらいに正規化して
 *              渡す。呼び側が時間で減衰させる)。null なら使わない
 *   seed     … この経路 1 本ぶんの種。**経路ごとに変える**。これが同じだと
 *              同じ 2 点はいつも同じ道を通ってしまい、ばらけない
 *   strength … 0 で純粋な最短経路。大きいほど遠回りを許して道が散る
 *
 * ゆらぎを配列で持たずハッシュで作るのは、経路 1 本ごとに GRID^2 の配列を
 * 確保したくないから (30x30 でも毎回 900 要素 = 湧くたびに GC を呼ぶ)。
 */
function spreadCost(n, use, seed, strength) {
  const s = (seed >>> 0) || 1;
  return (r, c) => {
    const i = r * n + c;
    let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(s, 1597334677)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B) >>> 0;
    const j = ((h >>> 8) & 0xFFFF) / 0x10000;          // 0..1 の固定のゆらぎ
    return 1 + strength * (j + (use ? use[i] : 0));
  };
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

// a の走る帯に b の車体が入っているか (上の 5 点刻みと同じ判定)。
// にらみ合いの検出にだけ使うので、距離は返さず真偽だけ。
function sees(a, b, look, laneHalf, half) {
  const cth = Math.cos(a.th), sth = Math.sin(a.th);
  const cx = b.x - a.x, cy = b.y - a.y;
  const och = Math.cos(b.th) * half, osh = Math.sin(b.th) * half;
  for (let k = -2; k <= 2; k++) {
    const ox = cx + och * (k / 2), oy = cy + osh * (k / 2);
    const f = ox * cth + oy * sth;
    if (f > 0 && f < look && Math.abs(-ox * sth + oy * cth) <= laneHalf) return true;
  }
  return false;
}

/**
 * 走行線の各点から**終点までの残距離**。フェードアウトを「残り何メートルか」で
 * 決めるために要る。時間で決めると、渋滞にはまった車が走り終える前に消える。
 */
function tailDist(line) {
  const cum = new Float64Array(line.length);
  for (let i = line.length - 2; i >= 0; i--)
    cum[i] = cum[i + 1] + Math.hypot(line[i + 1].x - line[i].x, line[i + 1].y - line[i].y);
  return cum;
}

// 車の通し番号。にらみ合いをほどくときの優先順位に使う (誰が先に行くかを
// 毎フレーム同じ答えで決められればよいので、順番そのものに意味は無い)。
let _carSeq = 0;

/** 車を 1 台つくる。gw から入り、路線に沿って走る。 */
function makeCar(line, speed, kind) {
  const p = line[0], q = line[Math.min(1, line.length - 1)];
  return {
    line, idx: 1, kind, speed, v: 0, wait: 0, seq: ++_carSeq,
    x: p.x, y: p.y,
    th: Math.atan2(q.y - p.y, q.x - p.x),
    cell: occKey(p),
    cum: tailDist(line),
    t: 0,          // 生まれてからの秒数 (フェードインに使う)
    hold: 0,       // 止まったままの秒数 (渋滞で車間を詰める判定に使う)
    alpha: 0,      // 0=透明。湧いた瞬間と消える瞬間の違和感を消す
    done: false,
  };
}

/**
 * 走行中の車の経路を差し替える。tail は **いま向かっているウェイポイント
 * (line[idx]) と同じセルから始まる**走行線であること。手前は残すので、車の位置も
 * 向きも飛ばない。差し替えられなければ false を返す (呼び側は放っておけばよい)。
 *
 * ★ その場 U ターンだけは弾く。引き直した経路が来た道をそのまま戻ると、車が
 *   交差点の真ん中で回頭して見える。
 */
function retarget(car, tail) {
  if (car.done || !tail || tail.length < 2) return false;
  const cur = car.line[car.idx];
  if (!cur || tail[0].r !== cur.r || tail[0].c !== cur.c) return false;
  const back = car.line[car.idx - 1];
  if (back && tail[1].r === back.r && tail[1].c === back.c) return false;
  car.line = car.line.slice(0, car.idx).concat(tail);
  car.cum = tailDist(car.line);
  return true;
}

/**
 * 車を進める。dt は秒。
 * 前が埋まっていれば減速して待つ = 交差点に列ができる。ただし待ち続けると
 * 交差点で互いに譲り合ったまま固まるので、**一定時間待ったら強制的に進む**。
 *
 * ── 占有セルの譲り合いと、実際の車間は別物 ──
 * occKey の取り合いは「交差点を誰が先に通るか」を決めるための**論理的な**予約で、
 * 1 セル = 7.7m もあるので、同じセルの中で車どうしはいくらでも近づける。実際
 * 湧き口と渋滞の列で車体が重なって見えていた。しかも force で押し通した車は
 * 予約を無視して進むので、譲り合いだけでは絶対に間隔を保てない。
 * そこで **前方の車までの実距離**を測り、それとは独立に速度を抑える。
 *   保つ距離 (中心間) = 車長 + stopGap + 速度 * timeGap
 * 止まっているときは車長 + stopGap、走っているほど広がる (実際の車間距離と同じ
 * 考え方)。渋滞で長く止まった車だけは stopGap を詰めて、列が伸びすぎないようにする。
 */
function stepCars(cars, dt, opts) {
  // turnRate は旋回のきつさ。速度 v で角速度 w の旋回半径は v/w なので、
  // これが小さすぎると車はウェイポイントに近づけず周りを回り続ける。
  const O = Object.assign({
    accel: 2.2, brake: 6.0, turnRate: 4.5, arrive: 0.5, force: 2.5,
    // 車間。既定はワールド単位 (server.js が車の実寸から渡す)。
    len: 0.68,        // 車長
    stopGap: 0.75,    // 停止時に空けるバンパー間の距離
    jamGap: 0.30,     // 渋滞で長く止まったときに詰めてよいところまで
    timeGap: 0.42,    // 速度 1 あたり何秒ぶん余計に空けるか (車頭時間)
    laneHalf: 0.22,   // 「前の車」とみなす横方向の許容 (対向車線を拾わない幅)
    // フェード
    fadeSec: 1.6,     // 湧いてから完全に見えるまでの秒数
    fadeDist: 3.0,    // 終点までこの距離を切ったら消えていく
  }, opts || {});
  const occ = new Map();
  const live = [];
  for (const car of cars) if (!car.done) { occ.set(car.cell, car); live.push(car); }
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

    // ── 前の車まで ──
    // 総当たり。車は多くても数十台なので、格子分割を持ち込むより読みやすさを取る。
    //
    // ★ 相手を**点**として「自分の正面 (f>0) で横ずれが車線幅に収まるか」で見ては
    //   いけない。この判定は左右で非対称で、曲がっている車どうしだと
    //   「A から見れば B は真後ろ / B から見れば A は横」になり、**どちらも
    //   相手を見つけられずに車体が重なる** (実測 0.34 = 車長の半分まで接近した)。
    //   相手の車体を前・中・後の 5 点に刻んで、そのどれかが自分の走る帯に入って
    //   いれば前方の車とみなす。相手が斜めを向いていても後ろの角を拾える。
    const cth = Math.cos(car.th), sth = Math.sin(car.th);
    const half = O.len * 0.5;
    const gap = (car.hold > O.force ? O.jamGap : O.stopGap) + car.v * O.timeGap;
    const look = O.len * 2 + gap;             // これより先の車は見ない
    let ahead = Infinity;                     // 自分の前バンパーから相手の車体まで
    for (const o of live) {
      if (o === car) continue;
      // まず粗く弾く (中心間が視界の外なら、車体を刻むまでもない)
      const cx = o.x - car.x, cy = o.y - car.y;
      if (cx * cx + cy * cy > (look + O.len) * (look + O.len)) continue;
      const och = Math.cos(o.th) * half, osh = Math.sin(o.th) * half;
      let near = Infinity;
      for (let k = -2; k <= 2; k++) {
        const ox = cx + och * (k / 2), oy = cy + osh * (k / 2);
        const f = ox * cth + oy * sth;
        if (f <= 0 || f >= look) continue;
        if (Math.abs(-ox * sth + oy * cth) > O.laneHalf) continue;
        if (f < near) near = f;
      }
      if (near === Infinity) continue;
      // ★ にらみ合いをほどく。交差点では「A の帯に B が居て、B の帯にも A が居る」
      //   ことがあり、素直に両方止めると**永久に動かない** (実測: 24台中22台が停止、
      //   平均速度 0.09)。互いに見えているときだけ、seq の小さいほうが先に行く。
      //   同じ車線の追従 (後ろの車からしか前の車は見えない) は非対称なので、この
      //   分岐には入らない = 車間はそのまま保たれる。
      if (car.seq < o.seq && sees(o, car, look, O.laneHalf, half)) continue;
      if (near < ahead) ahead = near;
    }
    // 詰まっていれば速度に上限をかける。**押し通し (force) 中でもここは効かせる**。
    // 効かせないと、詰まった交差点で車体がめり込む (それが「渋滞で重なる」の正体)。
    if (ahead < Infinity) {
      const slack = (ahead - half) - gap;     // バンパー間の余裕
      car.v = Math.min(car.v, slack <= 0 ? 0 : slack * 1.8);
    }
    car.hold = car.v < 0.05 ? car.hold + dt : 0;

    let want = Math.atan2(dy, dx) - car.th;
    want = Math.atan2(Math.sin(want), Math.cos(want));
    const mx = O.turnRate * dt;
    car.th += Math.max(-mx, Math.min(mx, want));
    car.x += Math.cos(car.th) * car.v * dt;
    car.y += Math.sin(car.th) * car.v * dt;

    // ── 透明度 ──
    // 湧いた瞬間に実体が現れる / 終点でぱっと消えるのが不自然なので、両端を
    // なめらかにする。消えるほうは**残り距離**で決める (時間だと渋滞ではまった
    // 車が道の途中で消える)。
    car.t += dt;
    const remain = Math.hypot(car.line[car.idx].x - car.x, car.line[car.idx].y - car.y)
                 + (car.cum[car.idx] || 0);
    const fi = O.fadeSec > 0 ? car.t / O.fadeSec : 1;
    const fo = O.fadeDist > 0 ? remain / O.fadeDist : 1;
    const a = Math.max(0, Math.min(1, fi, fo));
    car.alpha = a * a * (3 - 2 * a);          // 端をなめらかに (smoothstep)
  }
  return cars.filter(c => !c.done);
}

module.exports = { D4, drivable, gateways, deadEnds, route, spreadCost, laneLine, occKey,
                   tailDist, makeCar, retarget, stepCars };
