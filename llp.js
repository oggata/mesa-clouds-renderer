// llp.js — ローレベル方策の「方策に依存しない部分」。
//
// ── ここに置くもの / 置かないもの ────────────────────────────────────────────
//   置く   … targetSpec (「安いラーメン屋」) → 実際の建物セル の解決
//            歩きながら気づいたこと (percept) の生成
//            着いた建物が本当に目的地だったかの確認
//   置かない… ウェイポイント → 前進/左/右 の変換。**これは server.js に残す。**
//            そこが MOVE_MODE=pursuit / policy の分岐点で、既に stepAll() の中に
//            ある。分岐を2箇所に増やすより、既にある1箇所を使うほうが安全。
//
// ── 解決器と知覚源を差し替え可能にする理由 ──────────────────────────────────
// 配信 (MOVE_MODE=pursuit) では FPV レイキャストも DINOv2 も走らせたくない。
// なので **「視覚があること」を Option の側に前提させない**のが設計の不変条件:
//
//     resolve  : 'map'  (既定・地図引き)     / 'vision' (CLIPで照合)
//     percept  : 'geom' (既定・計算済みを再利用) / 'vision' (DINOv2 CLS 経由)
//
// geom 版は **すでに毎tick計算されているもの**しか見ない:
//   知り合い … stepNeeds が呼んでいる SOC.neighbors の結果
//   気になる店 … structAt + losClear (どちらも既存)
//   道が塞がった … naturalWalk が持っている crowd / carTtc
// つまり配信側の追加コストは実質ゼロ。vision 版だけが重い。
//
// 「視覚は精度を上げるが、無くても同じ行動が成立する」— これを守っている限り、
// 配信と研究環境の二本立ては破綻しない。

'use strict';

const OPT = require('./options.js');
const HLP = require('./hlp.js');

let _rnd = Math.random;
const setRng = fn => { _rnd = fn || Math.random; };

// ── 世界インタフェース ──────────────────────────────────────────────────────
// server.js から一度だけ渡してもらう。llp.js は MAP も three も知らない。
//   buildingsOfTypes(idxs) -> [[r,c],...]
//   structAt(r,c)          -> struct | null
//   structByKey(key)       -> struct | null      (a.taught.key を引く)
//   prefKey(st)            -> string | null
//   prefOf(a, key)         -> number             (行きつけの強さ)
//   openLotCells()         -> [[r,c],...]        (屋根の無い休憩場所)
//   nearestHome(a)         -> [r,c] | null
//   randB(ex)              -> [r,c]              (従来のランダム建物)
//   typeAt(r,c)            -> typeIdx | null
//   losClear(x0,y0,x1,y1)  -> bool
let W = null;
const attach = w => { W = w; };

const hypot = (dr, dc) => Math.sqrt(dr * dr + dc * dc);

// ═══ targetSpec → 建物セル ═════════════════════════════════════════════════
// **既存 pickLifeGoal() の逐語訳**。乱数を引く回数と順序まで同じにしてある
// (ずれると tools/determinism-check.js が落ちる)。
//
// どの kind も、解決できなければ最後は 'random' に落ちる。元コードが
// 「家なし・休憩場所なし・職場なし」のとき梯子を突き抜けて randB() に
// 落ちていたのと同じ動きで、ここが違うと家なしの住民が固まる。
function resolveMap(a, spec, ex, C) {
  switch (spec.kind) {
    case 'home': {
      if (a.home) return [a.home[0], a.home[1]];
      const h = W.nearestHome(a); if (h) return h;
      break;                                   // → random
    }
    case 'restSpot': {
      // 休憩は「近くで済ませる」もの。好みは効かせない (元コードのコメント通り)。
      const spots = [].concat(
        W.buildingsOfTypes(C.IDX.food), W.buildingsOfTypes(C.IDX.fun), W.openLotCells());
      if (spots.length) {
        spots.sort((p, q) => hypot(p[0] - a.x, p[1] - a.y) - hypot(q[0] - a.x, q[1] - a.y));
        return spots[0];
      }
      if (a.home) return [a.home[0], a.home[1]];
      const h2 = W.nearestHome(a); if (h2) return h2;
      break;                                   // → random
    }
    case 'workplace': {
      if (a.school) return [a.school[0], a.school[1]];   // 学生は学校が先
      if (a.work) return [a.work[0], a.work[1]];
      break;                                   // → random
    }
    case 'cat': {
      const f = W.buildingsOfTypes(spec.cat);
      if (!f.length) break;                    // → random
      // 勧められた店をまだ試していないなら、まずそこへ。上位からの抽選だと
      // せっかくの推薦が引かれずに終わってしまう。
      if (a.taught && !a.taught.tried) {
        const tSt = W.structByKey(a.taught.key);
        if (tSt && tSt.state === 'open' && spec.cat.includes(tSt.typeIdx)) {
          if (C.onTaught) C.onTaught(a, tSt);
          return [tSt.r, tSt.c];
        }
      }
      const w = spec.pref;
      const scored = f.map(b => {
        const st = W.structAt(b[0], b[1]);
        const key = W.prefKey(st);
        let sc = -hypot(b[0] - a.x, b[1] - a.y) + w * W.prefOf(a, key);
        if (a.taught && a.taught.key === key && !a.taught.tried) sc += w * C.teachBonus;
        return { b, sc };
      });
      scored.sort((p, q) => q.sc - p.sc);
      const k = spec.topK;
      return [...scored[Math.floor(_rnd() * Math.min(k, scored.length))].b];
    }
    case 'stay':
      return null;                             // その場で完結する Option
  }
  return W.randB(ex);
}

// 視覚版の解決。**Phase B で中身を入れる。** いまは地図版に委譲するだけで、
// 呼び口だけ先に用意しておく (Option 側のコードを後から変えずに済ませるため)。
function resolveVision(a, spec, ex, C) {
  // TODO(Phase B): spec.text の CLIP テキスト埋め込みと、視界内の建物の
  //   外見埋め込み (DINOv2 CLS → CLIP 空間への射影) をコサインで照合する。
  //   学習時に存在しなかった建物でも記述だけで引けるのが狙い。
  return resolveMap(a, spec, ex, C);
}

const RESOLVERS = { map: resolveMap, vision: resolveVision };

/** targetSpec を建物セルへ。mode は 'map' (既定) / 'vision'。 */
function resolve(a, spec, ex, C) {
  if (!W) throw new Error('llp.attach(world) を先に呼ぶこと');
  if (!spec) return W.randB(ex);
  return (RESOLVERS[C.resolveMode] || resolveMap)(a, spec, ex, C);
}

// ═══ 割り込みの生成 (percept) ══════════════════════════════════════════════
// **すでに計算済みのものだけを見る。** 新しい走査は足さない。
//
// C に渡すもの (server.js 側で毎tick既に手元にあるもの):
//   near   … 近くの住民の配列 (SOC.neighbors の結果を使い回す)
//   relOf(a,bid) … 関係の強さ
//   seenType(a, typeIdx) … その種類の建物に入ったことがあるか (a.seenMask)
function scanGeom(a, C) {
  if (!W) return 0;
  let n = 0;
  // ① 知り合いを見かけた。近接バッファは stepNeeds が既に埋めている。
  if (C.near && C.near.length && C.relOf) {
    for (const o of C.near) {
      if (C.relOf(a, o.aid) >= C.friendHi) { HLP.percept(a, 'saw-friend', { aid: o.aid }); n++; break; }
    }
  }
  // ② 知らない種類の店が見えた。半径は小さく (視界に入る範囲だけ)。
  //    LOS は既存の losClear をそのまま使う。
  if (C.sightR > 0 && C.seenType) {
    const r0 = Math.floor(a.x), c0 = Math.floor(a.y), R = C.sightR;
    let found = null;
    for (let dr = -R; dr <= R && !found; dr++) for (let dc = -R; dc <= R; dc++) {
      if (dr === 0 && dc === 0) continue;
      const st = W.structAt(r0 + dr, c0 + dc);
      if (!st || st.state !== 'open') continue;
      if (C.seenType(a, st.typeIdx)) continue;                 // 見慣れた種類は無視
      if (!W.losClear(a.x, a.y, st.r + 0.5, st.c + 0.5)) continue;
      found = st; break;
    }
    if (found) { HLP.percept(a, 'saw-new-shop', { r: found.r, c: found.c, t: found.typeIdx }); n++; }
  }
  // ③ 道が塞がっている。naturalWalk が既に持っている値をそのまま読む。
  if (C.blocked) { HLP.percept(a, 'blocked', null); n++; }
  return n;
}

// 視覚版。**Phase B で中身を入れる。**
function scanVision(a, C) {
  // TODO(Phase B): DINOv2 CLS → CLIP 射影で「気になる店」「知り合いの顔」を出す。
  //   per-agent の追加コストは小行列積1回 (CLS は policy モードで既に計算済み)。
  return scanGeom(a, C);
}

const SCANNERS = { off: () => 0, geom: scanGeom, vision: scanVision };

/** 歩きながらの気づきを積む。mode は 'geom' (既定) / 'vision' / 'off'。 */
function scan(a, C) {
  return (SCANNERS[C.perceptMode] || scanGeom)(a, C);
}

// ═══ 到着の確認 ════════════════════════════════════════════════════════════
/**
 * 着いたセルが本当に Option の目的地だったか。
 *   map 版    … 建物の種類が targetSpec のカテゴリに入っていれば真 (地図を信じる)
 *   vision 版 … Phase B。見た目と記述を照合する
 * 偽なら 'target-mismatch' を上げて、HLP に選び直させる。
 */
function verifyArrival(a, cell, spec, C) {
  if (!spec || !cell) return true;
  let ok = true;
  if (spec.kind === 'cat') {
    const t = W.typeAt(cell[0], cell[1]);
    ok = t != null && spec.cat.includes(t);
  }
  if (!ok) HLP.percept(a, 'target-mismatch', { r: cell[0], c: cell[1] });
  return ok;
}

module.exports = { attach, setRng, resolve, resolveMap, scan, scanGeom, verifyArrival, RESOLVERS, SCANNERS };
