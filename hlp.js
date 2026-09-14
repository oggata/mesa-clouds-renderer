// hlp.js — ハイレベル方策。「いま何をするか」を1つ選ぶ。
//
// ── 責務 ──
//   入力  性格 / 内部状態 / 時刻・曜日 / 記憶 / 社会文脈 / 街の状態 / 割り込み
//   出力  Option ひとつ (options.js の一覧から)
//
// **経路も座標も扱わない。** 行き先は targetSpec (「安いラーメン屋」のような仕様)
// までしか決めず、どのセルなのかは llp.js が解決する。ここを混ぜると
// 「視覚で目的地を確かめる」が原理的に成立しなくなる。
//
// ── 呼ばれる頻度 ──
// 毎tick呼んでよい。候補 8 個の precond は数値比較だけで、
// **いま server.js が 1エージェント1tickあたり 5〜7 回やり直している
// needOf() の梯子より軽い** (needOf は 25 箇所から呼ばれている)。
// それでも重ければ HLP_EVERY で間引ける。
//
// ── MOVE_MODE と無関係 ──
// ここは ONNX も DINOv2 も触らない。MOVE_MODE=pursuit (配信の既定) でも
// policy でも、同じ選択が走る。負荷が変わるのは llp.js の下段だけ。

'use strict';

const OPT = require('./options.js');

// ── 乱数 ────────────────────────────────────────────────────────────────────
// pastime.js と同じ約束。**シミュレーションから使うときは setRng(RNG.R)**。
// 忘れると他が全部決定的でもここ一本で世界がずれる (症状が「たまに再現しない」)。
let _rnd = Math.random;
const setRng = fn => { _rnd = fn || Math.random; };

const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

// ── 効用 ────────────────────────────────────────────────────────────────────
// score(o) = tier(o) + persona(o) + hook(o)
//
//   tier    … options.js の段。**これだけが効いているとき、選択は既存の
//             needOf() と完全に一致する** (tools/hlp-equiv.js が総当たりで確認)。
//   persona … 性格ボーナス。C.personaOn (HLP_PERSONA=1) のときだけ加える。
//             段差 50 より小さい PERSONA_MAX=20 に収めてあるので、
//             「腹が減っているのに寝る」のような生命に関わる逆転は起こらない。
//   hook    … Phase B/D の縫い目。f(state)·g(embed(option)) を後から差す場所。
//             **固定サイズの softmax にしないため**の口で、いまは未接続。
function score(o, a, C) {
  if (!o.precond(a, C)) return -Infinity;
  // ── 学習したハイポリシーがあるなら、それが効用そのもの ──────────────────
  //   手書きの段 (tier) は足さない。**足すと、段差 50 が学習したスコアを
  //   完全に押し潰す**ので、方策が何を選んでも結果が変わらなくなる。
  //   null が返るのは「まだ推論が回っていない」ときだけ (起動直後の1周)。
  if (C.netScore) {
    const ns = C.netScore(o, a, C);
    if (ns != null && ns === ns) return ns;
  }
  let s = o.tier;
  if (C.personaOn) s += clamp(o.persona(a, C) || 0, -OPT.PERSONA_MAX, OPT.PERSONA_MAX);
  if (C.scoreHook) s += C.scoreHook(o, a, C) || 0;
  return s;
}

/**
 * いま選ぶべき Option。
 *   C.temp = 0 (既定) … 最大値をそのまま採る = 決定論。同点は登録順で先勝ち。
 *   C.temp > 0        … softmax サンプル。性格由来のばらつきを出したいとき。
 * 戻り値: { opt, score, cands:[{id,score}] }
 */
function choose(a, C) {
  const cands = [];
  let best = null, bestS = -Infinity;
  for (const o of OPT.ACTS) {
    const s = score(o, a, C);
    if (s === -Infinity) continue;
    cands.push({ id: o.id, score: s });
    if (s > bestS) { bestS = s; best = o; }     // > なので同点は先に登録した方が残る
  }
  // 候補が1つも無い = precond の書き方が厳しすぎる。**落とさずに何かを返す。**
  // (夜に sleep が登録されていない、など。カタログの取り違えで起きる)
  if (!best) return { opt: OPT.byId.idle || OPT.ACTS[0], score: 0, cands };
  const temp = C.temp || 0;
  if (temp <= 0) return { opt: best, score: bestS, cands };

  // softmax。**段差 50 に対して temp が小さいと決定論と変わらない**ので、
  // 段を跨がせたくない場合はそれで良い (既定はそれ)。
  let sum = 0;
  const w = cands.map(c => { const e = Math.exp((c.score - bestS) / temp); sum += e; return e; });
  let r = _rnd() * sum;
  for (let i = 0; i < cands.length; i++) {
    r -= w[i];
    if (r <= 0) return { opt: OPT.byId[cands[i].id], score: cands[i].score, cands };
  }
  return { opt: best, score: bestS, cands };
}

/** 既存 needOf() の互換値。UI・カメラ・配達判定はこれを見ている。 */
const needOf = a => (a.opt && OPT.byId[a.opt.id]) ? (OPT.byId[a.opt.id].need || null) : null;

/** いまの Option (無ければ null)。 */
const current = a => (a.opt && OPT.byId[a.opt.id]) || null;

// ── 割り込み (LLP → HLP) ────────────────────────────────────────────────────
// 歩いている途中に気づいたことを積む。**押し込むだけで、ここでは判断しない。**
// 判断は pump() が次の決定タイミングでまとめて行う (毎tickで方針が揺れるのを防ぐ)。
function percept(a, kind, data) {
  const P = OPT.PERCEPTS[kind];
  if (!P) return false;                       // 語彙に無いものは割り込めない
  (a.percepts || (a.percepts = [])).push({ kind, data: data || null, gain: P.gain, pre: P.pre });
  if (a.percepts.length > 8) a.percepts.shift();   // 溜め込まない (古いものから捨てる)
  return true;
}

/**
 * 溜まった割り込みを処理して、選び直すべきかを返す。
 * 戻り値: { replan, retarget, why }
 *   replan   … Option ごと選び直す
 *   retarget … Option は続けるが行き先を取り直す (目的地が無くなった等)
 */
function pump(a, C) {
  const q = a.percepts;
  if (!q || !q.length) return { replan: false, retarget: false, why: null };
  let replan = false, retarget = false, why = null, bestGain = -1;
  const cur = current(a);
  const curScore = cur ? score(cur, a, C) : -Infinity;
  for (const p of q) {
    if (p.gain <= bestGain) continue;
    if (p.pre) {
      // 乗り換え先の効用に gain を足して、いまの Option を上回るなら乗り換える。
      const o = OPT.byId[p.pre];
      if (!o) continue;
      const s = score(o, a, C);
      if (s !== -Infinity && s + p.gain > curScore) { replan = true; bestGain = p.gain; why = p.kind; }
    } else {
      retarget = true; bestGain = p.gain; why = p.kind;
    }
  }
  q.length = 0;
  return { replan, retarget, why };
}

// ── 選び直しの門番 ──────────────────────────────────────────────────────────
// 「Option が終わった / より優先度の高い用事が生まれた / 割り込みが来た」の
// どれかのときだけ選び直す。
//
// ★ 既存 retargetOnNeedChange() は「needOf() の戻り値が前tickと変わったら
//   行き先を引き直す」だった。ここではそれを「choose() の結果が変わったら」に
//   置き換える。**personaOn=false・temp=0 のときこの2つは同値**なので、
//   Phase A では挙動が一切変わらない。
function decide(a, C) {
  const ev = pump(a, C);
  const pick = choose(a, C);
  // ★ 見張るのは a.lastOptId であって a.opt.id ではない。
  //   a.opt は「いま実行中の Option」で、行き先を引き直すたび (enterWander →
  //   pickLifeGoal) に張り替わる。それを見張りに使うと、**別の経路で
  //   enterWander が走った瞬間に見張りも一緒に更新されてしまい**、本来ここで
  //   起こすはずの引き直しが1回抜ける。既存の a.lastNeed が
  //   retargetOnNeedChange の中でしか書かれていないのと同じ約束を守る。
  const curId = a.lastOptId;
  const changed = pick.opt.id !== curId;
  if (!changed && !ev.replan && !ev.retarget) return null;
  return { opt: pick.opt, changed, retargetOnly: !changed && !ev.replan && ev.retarget, why: ev.why };
}

/** Option を張り替える。target はまだ解決しない (llp.js の仕事)。 */
function adopt(a, o, C) {
  a.opt = { id: o.id, since: C.now, tries: 0 };
  return a.opt;
}

module.exports = { setRng, score, choose, needOf, current, percept, pump, decide, adopt };
