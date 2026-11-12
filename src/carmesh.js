'use strict';
// carmesh.js — 車 (軽のトールワゴン) の型紙。server.js と tools/preview-car.js で共用する。
//
// 以前は箱 2 つ (車体と客室) に 7 角の車輪を付けただけで、近くで映ると積み木に見えた。
// ここでは横から見た輪郭を押し出して形を作る:
//   ・下半分 (車体): 短いボンネット → 鼻先 → バンパー、タイヤハウスの切り欠き付き
//   ・上半分 (客室): 下半分より少し細く (肩をすぼめる)、傾いたフロントガラスと丸い屋根
//   ・窓は黒っぽいガラスを車体の外側に貼る。柱 (A/B/C ピラー) は車体色のまま残る
//
// 寸法は 3.30 x 1.46 x 1.58 m の軽で書いてあり、scale.js の DIM.CAR に合わせて伸縮する。
// 前方は +X、左右は ±Y、上は +Z (traffic.js の car.th と同じ向き)。
//
// 返すのは 3 組の {geo, color} の並び:
//   body … 車体色 (白で作り、instanceColor で 1 台ずつ塗る)
//   trim … 色の決まった部品 (タイヤ・ホイール・ガラス・バンパー・タイヤハウスの奥)
//   lamp … 前照灯と尾灯 (夜だけ emissive を上げる)
// まとめて 1 本のジオメトリにするのは呼ぶ側 (server.js の mergeGeos) の仕事。

const GLASS  = 0x2c3946;   // 窓。明るい水色だと遠目に「白い箱」に溶けるので暗めに
const TIRE   = 0x1a1c1f;
const WHEEL  = 0xa4a9b0;   // ホイールキャップ
const BUMPER = 0x34373c;
const WELL   = 0x15171a;   // タイヤハウスの奥 (下回り)
const HEAD   = 0xfff2d2;
const TAIL   = 0xd83a24;

// 軽の寸法 (m)。輪郭はこの単位で書く。
const L0 = 3.30, W0 = 1.46, H0 = 1.58;
const AXLE = 1.06;              // 前後の車軸 (中心から)。従来の CAR_L*0.32 と同じ
const ARCH_R = 0.36;            // タイヤハウスの半径
const BELT = 0.95;              // ベルトライン (窓の下端の高さ)

function build(THREE, CAR){
  const sx = CAR.len / L0, sy = CAR.wid / W0, sz = CAR.cabZ[1] / H0;
  const WR = CAR.wheelR / sz;   // 車輪の半径 (m に戻した値)
  const WW = CAR.wheelW / sy;
  const body = [], trim = [], lamp = [];
  const col = c => new THREE.Color(c);

  // 横から見た輪郭 (x, z) を幅 w (m) で押し出し、車の座標に直す。
  // 角は小さく面取りする (bevel)。面取りぶん外へ膨らむので、幅はそのぶん引いて渡す。
  const extrude = (shape, w, bevel) => {
    const bt = bevel ? bevel.t : 0;
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: w - 2*bt, steps: 1, curveSegments: 8,
      bevelEnabled: !!bevel, bevelThickness: bt, bevelSize: bevel ? bevel.s : 0,
      bevelSegments: 1,
    });
    g.rotateX(Math.PI/2);                 // 輪郭の y → 上 (z)、押し出し → -y
    g.translate(0, (w - 2*bt)/2, 0);      // 左右の中央へ
    g.scale(sx, sy, sz);
    return g;
  };
  const box = (lx, ly, lz, x, y, z) => {
    const g = new THREE.BoxGeometry(lx*sx, ly*sy, lz*sz);
    g.translate(x*sx, y*sy, z*sz);
    return g;
  };
  // 傾いた面に貼る薄い板。p0→p1 は横から見た線 (x, z)、外向きに off だけ浮かせる。
  const slab = (p0, p1, width, off, t) => {
    const X0 = p0[0]*sx, Z0 = p0[1]*sz, X1 = p1[0]*sx, Z1 = p1[1]*sz;
    const dx = X1 - X0, dz = Z1 - Z0, len = Math.hypot(dx, dz);
    const g = new THREE.BoxGeometry(t, width*sy, len);
    g.rotateY(Math.atan2(dx, dz));         // 板の縦 (z) を線の向きへ
    // 外向きの法線 (線の右手側 = 車の外)。p0→p1 は車の外から見て反時計回りに取る。
    const nx = dz/len, nz = -dx/len;
    g.translate((X0+X1)/2 + nx*off, 0, (Z0+Z1)/2 + nz*off);
    return g;
  };

  // ── 車体 (下半分) ── 反時計回り。底辺にはタイヤハウスの円弧を 2 つ切る。
  const ZB = 0.22;                        // 車体の底
  const archDx = Math.sqrt(ARCH_R*ARCH_R - (ZB-WR)*(ZB-WR));
  const archA  = Math.asin((WR-ZB)/ARCH_R);    // 円弧が底辺と交わる角度
  const low = new THREE.Shape();
  low.moveTo(-1.58, ZB);
  for(const cx of [-AXLE, AXLE]){
    low.lineTo(cx - archDx, ZB);
    low.absarc(cx, WR, ARCH_R, Math.PI + archA, -archA, true);
  }
  low.lineTo( 1.58, ZB);
  low.lineTo( 1.65, 0.30);                // 前バンパーの下
  low.lineTo( 1.66, 0.58);
  low.lineTo( 1.62, 0.70);                // 鼻先
  low.lineTo( 1.48, 0.85);                // ボンネットの先
  low.lineTo( 1.02, BELT);                // フロントガラスの根元
  low.lineTo(-1.60, BELT);                // ベルトライン
  low.lineTo(-1.65, 0.86);
  low.lineTo(-1.65, 0.30);                // 背面 (ほぼ垂直なハッチ)
  low.lineTo(-1.58, ZB);
  body.push({geo: extrude(low, W0, {t:0.05, s:0.025}), color: col(0xffffff)});

  // ── 客室 (上半分) ── 車体より細く。フロントガラスは寝かせ、背面はほぼ立てる。
  const GW = W0*0.90;
  const WS0 = [1.00, BELT-0.01], WS1 = [0.38, 1.53];     // フロントガラスの線
  const RW0 = [-1.60, BELT-0.01], RW1 = [-1.55, 1.50];   // 背面の線
  const cab = new THREE.Shape();
  cab.moveTo(RW0[0], RW0[1]);
  cab.lineTo(WS0[0], WS0[1]);
  cab.lineTo(WS1[0], WS1[1]);
  cab.lineTo(0.26, 1.58);                 // 屋根の前端 (少し丸める)
  cab.lineTo(-1.42, 1.58);
  cab.lineTo(RW1[0], RW1[1]);
  cab.lineTo(RW0[0], RW0[1]);
  body.push({geo: extrude(cab, GW, {t:0.05, s:0.02}), color: col(0xffffff)});

  // ドアミラー (車体色)
  for(const s of [1,-1])
    body.push({geo: box(0.10, 0.14, 0.09, 0.90, s*(W0/2+0.05), 1.02), color: col(0xffffff)});

  // ── 窓 ──
  // 横の窓は B ピラーで前後 2 枚。客室の側面 (y = ±GW/2) のすぐ外に薄く貼る。
  const sideWin = [
    [[-0.10,1.01],[0.84,1.01],[0.33,1.50],[-0.10,1.50]],     // 前ドア
    [[-1.50,1.01],[-0.24,1.01],[-0.24,1.50],[-1.45,1.50]],   // 後ドア
  ];
  for(const pts of sideWin){
    const sh = new THREE.Shape();
    sh.moveTo(pts[0][0], pts[0][1]);
    for(let i=1;i<pts.length;i++) sh.lineTo(pts[i][0], pts[i][1]);
    const g = new THREE.ExtrudeGeometry(sh, {depth: GW + 0.012, bevelEnabled:false});
    g.rotateX(Math.PI/2); g.translate(0, (GW + 0.012)/2, 0); g.scale(sx, sy, sz);
    trim.push({geo: g, color: col(GLASS)});
  }
  // フロントガラスとリアガラス。面取りで膨らんだぶん (0.02) より外へ浮かせる。
  const lerp = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
  trim.push({geo: slab(lerp(WS0,WS1,0.06), lerp(WS0,WS1,0.94), GW*0.84, 0.03*sx, 0.012*sx), color: col(GLASS)});
  trim.push({geo: slab(lerp(RW1,RW0,0.08), lerp(RW1,RW0,0.62), GW*0.78, 0.03*sx, 0.012*sx), color: col(GLASS)});

  // ── バンパーとグリル ──
  trim.push({geo: box(0.16, W0+0.02, 0.17, 1.63, 0, 0.31), color: col(BUMPER)});
  trim.push({geo: box(0.16, W0+0.02, 0.17,-1.63, 0, 0.31), color: col(BUMPER)});
  trim.push({geo: box(0.04, W0*0.46, 0.12, 1.68, 0, 0.50), color: col(BUMPER)});   // グリル
  trim.push({geo: box(0.04, W0*0.30, 0.10,-1.69, 0, 0.55), color: col(BUMPER)});    // ナンバー周り

  // ── 下回り (タイヤハウスの奥) ──
  // 輪郭の切り欠きは幅いっぱいに抜けているので、内側を暗い箱で塞ぐ。
  // 横から見ると、タイヤの奥に暗いタイヤハウスが見える。
  trim.push({geo: box(2*(AXLE+ARCH_R), W0 - 2*(WW+0.05), 0.42, 0, 0, ZB+0.21), color: col(WELL)});

  // ── 車輪 ── タイヤとホイールキャップ。外側の面が車体とほぼ揃う位置。
  for(const fx of [1,-1]) for(const s of [1,-1]){
    const y = s*(W0/2 - WW/2 + 0.01);
    const t = new THREE.CylinderGeometry(WR*sz, WR*sz, WW*sy, 12);
    t.translate(fx*AXLE*sx, y*sy, WR*sz);
    trim.push({geo: t, color: col(TIRE)});
    const h = new THREE.CylinderGeometry(WR*0.58*sz, WR*0.58*sz, 0.02*sy, 10);
    h.translate(fx*AXLE*sx, (y + s*(WW/2+0.005))*sy, WR*sz);
    trim.push({geo: h, color: col(WHEEL)});
  }

  // ── 灯火 ── 車体から少し飛び出す箱。夜に emissive で光る。
  for(const s of [1,-1]){
    lamp.push({geo: box(0.16, 0.30, 0.11, 1.57, s*0.48, 0.77), color: col(HEAD)});   // 鼻先の斜面
    lamp.push({geo: box(0.06, 0.13, 0.30,-1.67, s*0.60, 0.74), color: col(TAIL)});  // 縦長の尾灯
  }
  return { body, trim, lamp };
}

module.exports = { build };
