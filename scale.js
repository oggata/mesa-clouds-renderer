// scale.js — 街の寸法を 1 か所に集める。**すべてメートルで書く。**
//
// ── なぜ集めるか ──
// 車・木・街灯・建物の寸法が server.js のあちこちに「ワールド単位の生の数字」で
// 散らばっていて、どれが何メートル相当なのか誰にも分からなくなっていた。実測すると
//     車 4.64m (大型セダン) / 木 6.95m (大木) / 街灯の支柱 0.22m (実物の約2倍)
// と、個別には妥当でも並べると揃わない状態だった。ここでメートルで書いておけば、
// 数字を見た瞬間に大きすぎるか判断できる。
//
// ── 基準 ──
// 住民の身長。skeleton.js の骨格が CELL*0.66 の高さで作られ、CHAR_SCALE 倍されて
// 街に置かれる。それを 1.70m と決めると、ワールド単位とメートルの対応が決まる。
//   CELL=2.0 / CHAR_SCALE=1/3 のとき  1 ワールド単位 = 3.864m 、1 セル = 7.73m
//
// ── 1 セルが 7.7m しかないこと ──
// これは日本の生活道路のスケール。車道 5.1m (1車線 2.55m) + 歩道 1.3m x2 で、
// 幹線道路ではなく住宅街の道。**だから車は軽自動車サイズが正しい。** 大型セダンを
// 置くと車線からはみ出さんばかりに見える (実際そう見えていた)。

'use strict';

const HUMAN_M = 1.70;          // 住民の身長 (m)。これが唯一の基準

/**
 * CELL と CHAR_SCALE から寸法表を作る。
 * server.js がこの 2 つを持っているので、二重定義を避けるため引数で受け取る。
 */
function make(CELL, CHAR_SCALE, env) {
  const E = env || {};
  const num = (k, d) => { const v = parseFloat(E[k]); return Number.isFinite(v) ? v : d; };

  const humanWu = CELL * 0.66 * CHAR_SCALE;    // 住民の身長 (ワールド単位)
  const mPerWu = HUMAN_M / humanWu;            // 1 ワールド単位 = 何 m
  const wu = m => m / mPerWu;                  // m → ワールド単位
  const toM = w => w * mPerWu;                 // ワールド単位 → m

  return {
    HUMAN_M, humanWu, mPerWu, wu, toM,
    cellM: toM(CELL),

    // ── 車 ──────────────────────────────────────────────────────────────────
    // 軽自動車 (3.40 x 1.48 x 1.60m)。1車線 2.55m の道にはこれが収まる大きさ。
    CAR: {
      len:   wu(num('CAR_LEN_M',   3.30)),
      wid:   wu(num('CAR_WID_M',   1.46)),
      bodyZ: [wu(0.32), wu(num('CAR_BODY_TOP_M', 0.95))],   // 車体 (床〜ベルトライン)
      cabZ:  [wu(0.95), wu(num('CAR_TOP_M',      1.58))],   // キャビン
      wheelR: wu(0.27), wheelW: wu(0.17),
    },

    // ── 木 ──────────────────────────────────────────────────────────────────
    // 街路樹。以前は 6.95m の大木で、1.7m の住民と 6.2m の建物の間で浮いていた。
    TREE: {
      h:       wu(num('TREE_H_M',        4.60)),   // 木のセルに生える木
      streetH: wu(num('STREET_TREE_H_M', 3.90)),   // 道路沿いの街路樹 (やや小ぶり)
      vary:    num('TREE_VARY', 0.18),             // 1 本ごとの大きさのばらつき (±)
    },

    // ── 街灯 ────────────────────────────────────────────────────────────────
    // 高さは元から妥当だった (5.6m)。おかしかったのは**太さ**で、支柱が 0.22m と
    // 実物の約2倍あった。灯具も 0.66m と大きい。高さを少し下げ、太さを実物に寄せる。
    LAMP: {
      h:       wu(num('LAMP_H_M',    4.60)),
      poleR:   wu(0.065),                          // 支柱の半径 (径 0.13m)
      collarR: wu(0.11),  collarH: wu(0.26),       // 根巻き
      armLen:  wu(num('LAMP_ARM_M', 0.95)),        // 車道側へ伸ばす腕
      armR:    wu(0.055),
      headW:   wu(0.21),  headL: wu(0.30),         // 灯具 (幅の半分, 長さの半分)
      poolR:   wu(num('LAMP_POOL_M', 4.60)),       // 地面に落ちる光の輪の半径
    },

    // ── 建物 ────────────────────────────────────────────────────────────────
    // セルに対する占有率。0.8 だと隣の建物との隙間が 1.5m しかなく、街区が
    // 詰まって見える。0.74 にすると隙間が 2.0m になり、そこに植栽を入れられる。
    // ★ GLB は 0.8 で焼いてあるので、描画時に fill/0.8 倍して縮める。
    BLDG: {
      fill:    num('BLDG_FILL', 0.74),
      glbFill: 0.80,                               // tools/make-building-glb.js の WIDTH
      // 階高。tools/make-building-glb.js がここから引く (以前は向こうに 0.85 /
      // 0.55 という生の数字で書いてあり、何 m 相当か分からなかった)。
      // ★ 変えると GLB を焼き直す必要があり、街じゅうの建物の背が変わる。
      baseH:  wu(3.284090909),                        // 1 階 (店舗が入る想定で高め)
      floorH: wu(2.125),                              // 2 階以上の基準階
    },
  };
}

/** 寸法表を人が読める形にする (tools/scale-report.js と server.js の起動ログが使う)。 */
function report(S, CELL) {
  const L = [];
  const row = (k, w) => L.push(`  ${k.padEnd(22)} ${w.toFixed(3).padStart(6)} wu = ${S.toM(w).toFixed(2)}m`);
  L.push(`1 ワールド単位 = ${S.mPerWu.toFixed(3)}m / 1 セル = ${S.cellM.toFixed(2)}m`);
  row('住民 (基準)', S.humanWu);
  row('セル', CELL);
  row('車 長さ', S.CAR.len); row('車 幅', S.CAR.wid); row('車 高さ', S.CAR.cabZ[1]);
  row('木 (木のセル)', S.TREE.h); row('木 (街路樹)', S.TREE.streetH);
  row('街灯 高さ', S.LAMP.h); row('街灯 支柱の径', S.LAMP.poleR * 2);
  row('街灯 灯具の幅', S.LAMP.headW * 2);
  row('建物 幅 (1x1)', CELL * S.BLDG.fill);
  row('建物の間の隙間', CELL * (1 - S.BLDG.fill));
  row('建物 1階の高さ', S.BLDG.baseH);
  row('建物 基準階の高さ', S.BLDG.floorH);
  row('車道 全幅', 0.66 * CELL); row('車道 1車線', 0.33 * CELL);
  row('歩道 幅', 0.17 * CELL);
  return L.join('\n');
}

module.exports = { HUMAN_M, make, report };
