// chronicle.js — 住民一人ひとりの来歴。
//
// ── なぜ要るか ──
// 街には出来事が絶えず起きているのに、**どれも1行流れて消えていた**。
// 財布を落とした、昇給した、友達になった、店を開いた — それぞれは面白いが、
// 「誰の話か」が積み上がらないので物語にならない。住民は pref (行きつけ) も
// rel (人間関係) も持っているのに、視聴者から見える形になっていなかった。
//
// ここでは出来事を住民ごとに数十件だけ覚えておく。チャットの `!story ミカ` で
// その人の来歴が読める。`!join` した視聴者が自分の分身の一生を追える、というのが
// いちばん効くところ。
//
// ── 覚えすぎない ──
// 住民は最大 1000 人。全員の全履歴を持つと保存ファイルが際限なく膨らむので、
// 1人 CAP 件の輪バッファにする。古いものから落ちるが、**節目 (mark=true) は
// 別枠で残す** — 引っ越してきた日や店を開いた日が消えると来歴の意味が無くなる。

'use strict';

const CAP      = 24;   // ふつうの出来事をいくつ覚えるか
const MARK_CAP = 8;    // 節目 (誕生・起業・就職など) をいくつ覚えるか

/**
 * 出来事を1件足す。
 *   e = { day, icon, ja, en, mark }
 * mark=true は「節目」。別枠に積んで、古い出来事に押し出されないようにする。
 */
function push(a, e) {
  if (!a) return;
  if (e.mark) {
    (a.marks || (a.marks = [])).push(e);
    while (a.marks.length > MARK_CAP) a.marks.shift();
    return;
  }
  (a.log || (a.log = [])).push(e);
  while (a.log.length > CAP) a.log.shift();
}

/** 節目と出来事を日付順に並べた1本の年表。 */
function timeline(a) {
  const all = [...(a.marks || []), ...(a.log || [])];
  return all.sort((x, y) => (x.day - y.day) || 0);
}

/** 表示用の行。n 件まで、新しいものを優先して古い順に並べる。 */
function lines(a, ja, n) {
  const t = timeline(a);
  const take = t.slice(Math.max(0, t.length - (n || 10)));
  return take.map(e => `Day${e.day + 1} ${e.icon} ${ja ? e.ja : e.en}`);
}

/** 保存用。日付と本文だけ残す (アイコンは再生成できないので持つ)。 */
function serialize(a) {
  const pack = arr => (arr && arr.length)
    ? arr.map(e => [e.day, e.icon, e.ja, e.en]) : undefined;
  const l = pack(a.log), m = pack(a.marks);
  return (l || m) ? { l, m } : undefined;
}

function restore(a, sv) {
  if (!sv) return;
  const un = arr => (arr || []).map(([day, icon, ja, en]) => ({ day, icon, ja, en }));
  if (sv.l) a.log = un(sv.l);
  if (sv.m) a.marks = un(sv.m).map(e => ({ ...e, mark: true }));
}

module.exports = { CAP, MARK_CAP, push, timeline, lines, serialize, restore };
