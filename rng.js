// rng.js — 街ぜんぶで使う、種の決まった乱数。
//
// ── なぜ要るか ──
// 物語を「1000年まわして良いところを再生する」には、**録画ではなく再現**が要る。
// 同じ種から同じ世界が出てくるなら、保存するのは種と時刻の範囲だけで済み、
// ログは1バイトも要らない。再生は同じ種で回し直すこと、そのものになる。
//
// ── 二つの流れを混ぜない ──
// 決定的でいられるのは **毎tick同じ順序で回るもの** だけ。HTTP のリクエスト、
// チャット、描画ループ、雨粒、車は、いつ何回呼ばれるか分からないので、
// ここから引かせてはいけない。引かせると1回のアクセスで先の未来が全部ずれる。
//   ・シミュレーション (stepAll / stepOneSecond / cityTick) … R() を使う
//   ・それ以外 (描画・配信・HTTP・チャット)                  … Math.random() のまま
// この境界だけが決定性を支えている。**迷ったら Math.random() 側に置く。**
//
// ── 状態は int ひとつ ──
// mulberry32 の内部状態は 32bit 整数ひとつなので、スナップショットに1個持てば
// 復元できる。「n回空回しして戻す」ような復元は要らない (分岐探索で毎回やると
// 回数に比例して遅くなる)。

'use strict';

let _s = 1;          // 内部状態
let _seed = 1;       // 最初に与えた種 (記録用)
let _n = 0;          // 何回引いたか (診断用。ずれの発見に効く)

/** 種を入れ直す。世界を作り直すときと、分岐を張るときに呼ぶ。 */
function seed(v){
  _seed = (v >>> 0) || 1;
  _s = _seed | 0;
  _n = 0;
  return _seed;
}

/** [0,1)。mulberry32。 */
function R(){
  _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  _n++;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

const Ri    = n => Math.floor(R() * n);            // [0,n) の整数
const Rpick = a => a[Math.floor(R() * a.length)];  // 配列から1つ
const Rrange= (a,b) => a + R()*(b-a);

/** いまの状態。スナップショットに入れる。 */
const state = () => ({s:_s, seed:_seed, n:_n});
/** 状態を戻す。O(1)。 */
function restore(st){
  if(!st) return;
  _s = st.s|0; _seed = st.seed>>>0 || 1; _n = st.n||0;
}
const draws = () => _n;

module.exports = { seed, R, Ri, Rpick, Rrange, state, restore, draws };
