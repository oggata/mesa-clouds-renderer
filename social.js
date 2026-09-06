// social.js — 住民どうしの関係と立ち話。
//
// server.js から切り出してある。理由は、街の物理 (world.js) / 街の経済 (server.js の
// CITY まわり) と、**人間関係**が混ざると誰も読めなくなるため。
//
// ── このモジュールが持つもの ──
//   ・誰と誰が会ったか (関係グラフ)      … a.rel
//   ・いま立ち話しているか (会話の状態機械) … a.talk
//   ・どの話題を選ぶか
//   ・近接判定の空間ハッシュ (O(N²) を避ける)
//
// ── このモジュールが持たないもの ──
//   ・話題の「効果」(好みが伝わる / 潰れた店を忘れる) — 好みは server.js の
//     pref 機構が持っているので、ここは話題を決めて呼び戻すだけにする。
//   ・描画・カメラ・ニュース — すべて server.js 側のコールバックへ渡す。
//
// server.js からは ctx (コールバックの束) を渡してもらう。このファイルは
// server.js のグローバルを一切参照しない (world.js と同じ作法)。

'use strict';

// ── 既定値 ──────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  relMax:      12,    // 1人が覚えていられる相手の数 (保存サイズと O(N²) 対策)
  relGain:     0.18,  // 1回の出会いでどれだけ親しくなるか
  relDecay:    0.98,  // 会わないと薄れる (日次)
  relFriend:   0.50,  // これを超えたら「友人」
  // ── 恨み (grudge) ──
  // 親しさ s とは**別の軸**にする。s を負に振らないのは、それだと
  // 「毎日顔を合わせるのに恨んでいる」が表せなくなるため。同僚と毎日すれ違って
  // 毎日もめる、という関係が動機としてはいちばん濃いので、ここを潰したくない。
  //   ★ 恨みは「相手が誰か分かっている」ときにしか立たない。ここは器だけを持ち、
  //     何が恨みを生むかは呼ぶ側 (server.js の言い合い / スリの被害) が決める。
  grudgeDecay: 0.96,  // 会わなくても薄れる。**親しさ (0.98/日) より速く忘れる**が、
                      //   動機として使える長さは要る。0.96/日 だと 3回もめた恨みが
                      //   「遺恨あり」でいるのは約5日、完全に忘れるまで約80日。
  grudgeEnemy: 0.45,  // これを超えたら「遺恨あり」。1回のもめ事では届かない値にする
  // ── 貸し借り ──
  // **貸した側が覚えている。** 借りた側の自己申告に頼ると取り立てが成立しない。
  // 返さないまま日が経つと、貸した側の恨みがじりじり育つ (下の ageDebts)。
  debtGrudge:  0.08,  // 返済されないまま1日過ぎるごとに積む恨み
  debtBuffer:  16,    // これ以上の余裕が手元にできたら返す
  meetRadius:  3,     // 何セル以内を「出会い」とみなすか (既存の孤独判定と同じ)
  meetCoolSec: 45,    // 同じ相手をもう一度カウントするまでの間隔
  talkP:       0.35,  // 出会ったときに立ち話になる確率
  talkSec:     4,     // 立ち話の長さ (秒)
  talkMax:     6,     // 同時に立ち話できる組の数 (道を塞がないための上限)
  talkCoolSec: 25,    // 同じ人が次に立ち話するまでの間隔
  // ── 混雑への上限 ──
  // 本番は NUM_AGENTS=6000。密集した場所では半径3セルに数百人居るので、
  // 近傍を全部見ると 1tick で数十万ペアになる (実測 246,000/秒)。
  // 「人混みの中で全員に挨拶はしない」を素直に実装して、見る人数を絞る。
  meetScan:    8,     // 1tickに何人まで視界に入れるか
  meetPerTick: 2,     // そのうち何人まで実際に「出会った」ことにするか
});

function createState(opts){
  const cfg=Object.assign({}, DEFAULTS, opts||{});
  return {
    cfg,
    talking: 0,          // いま立ち話している「人数」
    stats: {meets:0, talks:0, friends:0, topics:{place:0, newshop:0, closed:0}},
    _grid: new Map(),    // 空間ハッシュ (毎tick作り直す)
    _cell: Math.max(1, cfg.meetRadius),
  };
}

// ── 乱数 ────────────────────────────────────────────────────────────────────
// 既定は Math.random。**シミュレーションから使うときは setRng(RNG.R) で
// 差し替える** (rng.js を参照)。ここを差し替え忘れると、他が全部決定的でも
// この一本だけで世界が毎回ずれる — しかも症状は「たまに再現しない」なので、
// 気づくのに一番時間が掛かる種類のバグになる。
let _rnd = Math.random;
const setRng = fn => { _rnd = fn || Math.random; };
// ── 空間ハッシュ ────────────────────────────────────────────────────────────
// 300人で全ペアを見ると9万回/tick になる。セルに配ってから近傍だけ見る。
// stepNeeds の孤独判定もこれを使えるように、外へ出しておく。
function buildGrid(S, agents){
  const g=S._grid; g.clear();
  const cs=S._cell;
  for(let i=0;i<agents.length;i++){
    const a=agents[i];
    const k=(Math.floor(a.x/cs))+','+(Math.floor(a.y/cs));
    let arr=g.get(k); if(!arr) g.set(k, arr=[]);
    arr.push(a);
  }
  return g;
}

// a の近くに居る住民を out に集める (自分は含まない)。
// 3x3 バケツを見るので、cell = meetRadius なら取りこぼしが無い。
//   limit … 何人見つけたら打ち切るか (0/未指定 = 全部)。
//           密集地でバケツに数百人居ても、ここで止めれば O(1) に収まる。
//           バケツ内の開始位置をずらして、毎回同じ人ばかり拾わないようにする。
function neighbors(S, a, out, limit){
  out.length=0;
  const cs=S._cell, R=S.cfg.meetRadius;
  const br=Math.floor(a.x/cs), bc=Math.floor(a.y/cs);
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
    const arr=S._grid.get((br+dr)+','+(bc+dc));
    if(!arr) continue;
    const n=arr.length, off=n>1 ? (_rnd()*n)|0 : 0;
    for(let i=0;i<n;i++){
      const o=arr[(i+off)%n];
      if(o===a) continue;
      if(Math.abs(o.x-a.x)<R && Math.abs(o.y-a.y)<R){
        out.push(o);
        if(limit && out.length>=limit) return out;
      }
    }
  }
  return out;
}

// ── 関係グラフ ──────────────────────────────────────────────────────────────
function relOf(a, bid){ return (a.rel && a.rel[bid]) ? a.rel[bid].s : 0; }
// 恨み。相手を覚えていなければ 0。
function grudgeOf(a, bid){ return (a.rel && a.rel[bid]) ? (a.rel[bid].g||0) : 0; }
// 差し引きの感情。+ が好意、- が敵意。「親しいが恨んでもいる」は 0 付近になる。
function feelOf(a, bid){ return relOf(a, bid) - grudgeOf(a, bid); }
// 目につきやすさ。**好きな相手も嫌いな相手も目につく**ので、どちらも足す。
function salience(a, bid){ return relOf(a, bid) + grudgeOf(a, bid); }
// 覚えている理由の強さ。親しさ・恨み・貸しのうち一番濃いもの。
//   ★ 貸しも入れる。**金を貸した相手は忘れない。** ここに入れ忘れると、
//     relMax の溢れで借用書だけが先に消えて、取り立ての動機が蒸発する。
const relWeight = e => Math.max(e ? (e.s||0) : 0, e ? (e.g||0) : 0, e ? ((e.debt||0)>0?0.5:0) : 0);

// ── 貸し借り ────────────────────────────────────────────────────────────────
// lender.rel[borrower].debt = 借り手がまだ返していない額。
/** 貸す。戻り値は貸した後の残高。 */
function lend(S, lender, borrower, amt, day){
  if(!(amt>0)) return 0;
  if(!lender.rel) lender.rel={};
  const e=lender.rel[borrower.aid] || (lender.rel[borrower.aid]={n:0, s:0, g:0, d:day});
  e.debt=(e.debt||0)+amt; e.d=day;
  e.since=(e.since==null) ? day : e.since;
  trimRel(lender, S.cfg.relMax);
  return e.debt;
}
/** その相手にいくら貸しているか。 */
const debtOf = (lender, bid) => (lender.rel && lender.rel[bid]) ? (lender.rel[bid].debt||0) : 0;
/** 返済。返しきったら借用書を消す。 */
function repay(S, lender, borrowerId, amt){
  const e=lender.rel && lender.rel[borrowerId];
  if(!e || !(e.debt>0)) return 0;
  const paid=Math.min(e.debt, amt);
  e.debt-=paid;
  if(e.debt<=0.001){ e.debt=0; e.since=undefined; }
  return paid;
}
/** 街じゅうの貸し借りを [貸した人, 借りた人, 額, 何日から] で列挙する。 */
function debts(agents, n){
  const by=new Map(agents.map(a=>[a.aid, a]));
  const out=[];
  for(const a of agents) for(const k of Object.keys(a.rel||{})){
    const e=a.rel[k];
    if((e.debt||0)>0 && by.has(k)) out.push({lender:a, borrower:by.get(k), amt:e.debt, since:e.since});
  }
  out.sort((x,y)=>y.amt-x.amt);
  return n ? out.slice(0,n) : out;
}

// 相性。社交的な人ほど早く親しくなる。personas.json の sociability (既定 0.4)。
function compat(a, b){
  const sa=(a.def && a.def.sociability!=null) ? a.def.sociability : 0.4;
  const sb=(b.def && b.def.sociability!=null) ? b.def.sociability : 0.4;
  return 0.35 + (sa+sb)*0.65;      // 0.35 〜 1.65 倍
}

// 覚えていられる人数には上限がある。溢れたら一番薄い相手を忘れる。
//   ★ 親しさ s だけで切ってはいけない。恨みは s=0 のまま立つので、s 順に捨てると
//     「一度もめただけの相手」が真っ先に忘れられ、恨みが積み上がる前に消える。
//     max(親しさ, 恨み) で切る。
function trimRel(a, relMax){
  const keys=Object.keys(a.rel);
  if(keys.length<=relMax) return;
  keys.sort((x,y)=>relWeight(a.rel[x])-relWeight(a.rel[y]));
  for(let i=0;i<keys.length-relMax;i++) delete a.rel[keys[i]];
}

// 片方向ぶんの更新。戻り値 = 「いま友人になった」なら true。
function bumpRel(S, a, b, day){
  const cfg=S.cfg;
  if(!a.rel) a.rel={};
  const e=a.rel[b.aid] || (a.rel[b.aid]={n:0, s:0, d:day});
  const wasFriend = e.s>=cfg.relFriend;
  e.n++; e.d=day;
  e.s = Math.min(1, e.s + cfg.relGain*compat(a,b)*(1-e.s));
  trimRel(a, cfg.relMax);
  return !wasFriend && e.s>=cfg.relFriend;
}

// 恨みを片方向ぶん足す。戻り値 = 「いま遺恨あり (grudgeEnemy 越え) になった」なら true。
//   ・相手を覚えていなくても立つ。初対面ともめることはあるので、無ければ作る。
//   ・飽和加算。すでに恨んでいる相手をさらに恨んでも伸びは鈍る (1 で頭打ち)。
//   ・**1回では閾値に届かない**。既定 (0.30 ずつ) なら3回もめてようやく 0.45 を越える。
//     動機は積み重ねでしか生まれない、というのがこの数字の意味。
function bumpGrudge(S, a, b, amt, day){
  if(!(amt>0)) return false;
  const cfg=S.cfg;
  if(!a.rel) a.rel={};
  const e=a.rel[b.aid] || (a.rel[b.aid]={n:0, s:0, d:day, g:0});
  const was=e.g||0;
  e.d=day;
  e.g=Math.min(1, was + amt*(1-was));
  trimRel(a, cfg.relMax);
  return was < cfg.grudgeEnemy && e.g >= cfg.grudgeEnemy;
}

const friendsOf = (a, thr) => Object.entries(a.rel||{})
  .filter(([,e])=>e.s>=(thr!=null?thr:DEFAULTS.relFriend))
  .sort((x,y)=>y[1].s-x[1].s).map(([id])=>id);

// 遺恨のある相手を濃い順に。ミステリー層が「動機のある人物」を引くための入口。
const enemiesOf = (a, thr) => Object.entries(a.rel||{})
  .filter(([,e])=>(e.g||0)>=(thr!=null?thr:DEFAULTS.grudgeEnemy))
  .sort((x,y)=>(y[1].g||0)-(x[1].g||0)).map(([id])=>id);

// 街じゅうの遺恨を [恨む側, 恨まれる側, 濃さ] で列挙する (濃い順)。
//   ★ 双方向にこじれていれば2行出る。片思いの恨みと相互の反目は別物なので潰さない。
function feuds(agents, thr, n){
  const t=(thr!=null?thr:DEFAULTS.grudgeEnemy), out=[];
  const by=new Map(agents.map(a=>[a.aid, a]));
  for(const a of agents) for(const k of Object.keys(a.rel||{})){
    const g=a.rel[k].g||0;
    if(g>=t && by.has(k)) out.push({a, b:by.get(k), g});
  }
  out.sort((x,y)=>y.g-x.g);
  return n ? out.slice(0, n) : out;
}

// 「何人と知り合いか」。評判 (フェーズ2) の土台。
const degreeOf = (a, thr) => friendsOf(a, thr).length;

// 街で一番顔が広い住民を返す
function topConnected(agents, n, thr){
  return agents.map(a=>({a, deg:degreeOf(a, thr)}))
    .filter(x=>x.deg>0).sort((x,y)=>y.deg-x.deg).slice(0, n||1);
}

// ── 話題選び ────────────────────────────────────────────────────────────────
// 効果は server.js 側 (ctx.applyTopic) が持つ。ここは「何を話すか」だけ決める。
//   newshop … 最近できた店を教える (自分の一番の行きつけとは限らないので gossip では広まらない)
//   closed  … 潰れた店の話。聞いた側はその店を忘れる
//   place   … 行きつけの話 (従来の口コミ)
function pickTopic(S, a, b, ctx){
  // 相手が知らない「最近できた店」を自分が知っていれば、まずそれを教える
  const fresh=ctx.freshShopFor(a, b);
  if(fresh) return {kind:'newshop', key:fresh};
  // 自分の好みの中に潰れた店があれば、その話をする (聞いた側も忘れられる)
  const dead=ctx.deadShopFor(a, b);
  if(dead) return {kind:'closed', key:dead};
  return {kind:'place'};
}

// ── 立ち話 ──────────────────────────────────────────────────────────────────
const isTalking = (a, now) => !!(a.talk && a.talk.until>now);

function startTalk(S, a, b, now, topic){
  const cfg=S.cfg, until=now+cfg.talkSec*1000;
  // 互いに向き合わせる。世界の進行方向は (sin th, cos th) なので、
  // 相手へのベクトル (dx,dy) から th = atan2(dy, dx) ではなく atan2(dx, dy) になる。
  const th=(from,to)=>Math.atan2(to.y-from.y, to.x-from.x);
  a.talk={with:b.aid, until, th:th(a,b), topic:topic.kind};
  b.talk={with:a.aid, until, th:th(b,a), topic:topic.kind};
  S.talking+=2; S.stats.talks++;
  S.stats.topics[topic.kind]=(S.stats.topics[topic.kind]||0)+1;
}

// 終わった立ち話を片付ける。毎tick先頭で呼ぶ。
function reapTalks(S, agents, now){
  let n=0;
  for(const a of agents){
    if(!a.talk) continue;
    if(a.talk.until>now){ n++; continue; }
    a.talk=null;
  }
  S.talking=n;
}

// ── 本体 ────────────────────────────────────────────────────────────────────
// ctx で server.js から受け取るもの:
//   agents, dtSec, day, now
//   isIndoors(a)          屋内か (屋内どうしは会わない)
//   canTalkAt(a)          そこで立ち止まってよいか (狭い道を塞がないため)
//   freshShopFor(a,b)     a が知っていて b が知らない「最近できた店」のキー or null
//   deadShopFor(a,b)      a か b の好みに残っている潰れた店のキー or null
//   applyTopic(a,b,topic) 話題の効果を適用する (好みの伝播など)
//   onTalk(a,b,topic)     立ち話が始まった (吹き出し / ティッカー / カメラ)
//   onFriend(a,b)         友人になった瞬間 (1組につき1回)
//   rng()                 [0,1)
function step(S, ctx){
  const {agents, dtSec, day, now}=ctx;
  const cfg=S.cfg;
  const rng=ctx.rng || _rnd;

  reapTalks(S, agents, now);
  buildGrid(S, agents);

  const near=[];
  for(const a of agents){
    if(ctx.isIndoors(a)) continue;
    if(isTalking(a, now)) continue;
    neighbors(S, a, near, cfg.meetScan);
    if(!near.length) continue;
    // 人混みでは「知っている顔」に先に気づく。こうしないと 6000人の中で
    // 毎回別人とすれ違うだけになり、関係がいつまでも育たない。
    //   ★ 目につくのは仲のいい相手だけではない。**恨んでいる相手も目につく**ので
    //     salience (親しさ+恨み) で並べる。ここを s だけにすると、一度もめた二人が
    //     二度と近づかなくなり、恨みは薄れて消えるだけになる (= 動機が育たない)。
    if(a.rel && near.length>1)
      near.sort((x,y)=>salience(a,y.aid)-salience(a,x.aid));

    let done=0;
    for(const b of near){
      if(done>=cfg.meetPerTick) break;
      // 片側だけで処理する (aid の順で固定) と、同じ組を2回見なくて済む
      if(a.aid>=b.aid) continue;
      if(ctx.isIndoors(b) || isTalking(b, now)) continue;

      // ── 出会い ──
      // 同じ相手とすれ違い続けても水増しされないよう、間隔を空ける
      const e=a.rel && a.rel[b.aid];
      const lastAt=(e && e._t) || 0;
      if(now-lastAt < cfg.meetCoolSec*1000) continue;

      done++;
      const f1=bumpRel(S, a, b, day);
      const f2=bumpRel(S, b, a, day);
      const ea=a.rel[b.aid], eb=b.rel[a.aid];
      // trimRel で捨てられている場合があるので存在確認してから触る
      if(ea) ea._t=now;
      if(eb) eb._t=now;
      S.stats.meets++;
      // 片側だけ trimRel で捨てられると、双方向の親密度がズレる。
      // 「両方が同時に閾値を越える」を条件にすると永久に成立しないので、
      // どちらかが越えた時点で成立させ、_f 印で二重発火を防ぐ。
      if((f1||f2) && !(ea&&ea._f) && !(eb&&eb._f)){
        if(ea) ea._f=1; if(eb) eb._f=1;
        S.stats.friends++; ctx.onFriend(a, b);
      }

      // ── 立ち話 ──
      if(S.talking >= cfg.talkMax*2) continue;
      if(now-(a._talkAt||0) < cfg.talkCoolSec*1000) continue;
      if(now-(b._talkAt||0) < cfg.talkCoolSec*1000) continue;
      // 親しいほど話し込む。初対面でも稀に話す。
      //   恨みも「立ち止まる理由」になる。無視して通り過ぎるだけなら口論は起きず、
      //   もめる→また出くわす→またもめる の輪が回らない。この輪があって初めて
      //   恨みが動機と呼べる濃さ (grudgeEnemy) まで育つ。
      const p=cfg.talkP*(0.4+relOf(a,b.aid)+grudgeOf(a,b.aid)*0.5);
      if(rng()>=p) continue;
      if(!ctx.canTalkAt(a) || !ctx.canTalkAt(b)) continue;

      const topic=pickTopic(S, a, b, ctx);
      startTalk(S, a, b, now, topic);
      a._talkAt=b._talkAt=now;
      ctx.applyTopic(a, b, topic);
      ctx.onTalk(a, b, topic);
      break;                      // 1tickに1人1組まで
    }
  }
}

// 日が変わったとき。会わない相手との関係は薄れ、消えたものは忘れる。
function dailyDecay(S, agents){
  const cfg=S.cfg;
  for(const a of agents){
    if(!a.rel) continue;
    for(const k of Object.keys(a.rel)){
      const e=a.rel[k];
      e.s*=cfg.relDecay;
      if(e.g) e.g*=cfg.grudgeDecay;
      // ★ 借用書が残っているうちは忘れない。下の削除条件から守る。
      if((e.debt||0)>0) continue;
      // 忘れるのは**親しさも恨みも薄れきったとき**だけ。どちらかが残っていれば
      // 相手を覚えている (疎遠だがまだ許していない、が表せる)。
      if(e.s<0.02 && !(e.g>0.02)) delete a.rel[k];
      else if(e.g && e.g<=0.02) e.g=0;
    }
  }
}

// ── 保存 / 復元 ─────────────────────────────────────────────────────────────
// 上位 n 件だけ保存する (1000人ぶん全部持つと状態ファイルが膨らむ)。
// 形式: {相手aid: [親密度, 会った回数, 最後に会った日, 恨み?]}
//   4要素目は恨みがあるときだけ足す。3要素の古い保存もそのまま読める。
//   ★ 並べ替えは max(親しさ, 恨み)。s 順に切ると、s=0 の「恨みしかない相手」が
//     保存から真っ先に落ちて、再起動のたびに動機が消える。
function serializeAgent(a, n){
  if(!a.rel) return undefined;
  const top=Object.entries(a.rel).sort((x,y)=>relWeight(y[1])-relWeight(x[1])).slice(0, n||6);
  if(!top.length) return undefined;
  return Object.fromEntries(top.map(([k,e])=>{
    const row=[+(e.s||0).toFixed(2), e.n||0, e.d||0];
    if(e.g>0.02 || (e.debt||0)>0) row.push(+(e.g||0).toFixed(2));
    if((e.debt||0)>0){ row.push(Math.round(e.debt)); row.push(e.since==null?-1:e.since); }
    return [k, row];
  }));
}
function restoreAgent(a, saved){
  if(!saved) return;
  a.rel={};
  for(const k of Object.keys(saved)){
    const v=saved[k];
    a.rel[k]={s:+v[0]||0, n:+v[1]||0, d:+v[2]||0, g:+v[3]||0};
    if(v.length>4){ a.rel[k].debt=+v[4]||0; if(+v[5]>=0) a.rel[k].since=+v[5]; }
  }
}

module.exports = {
  DEFAULTS, createState, setRng,
  buildGrid, neighbors,
  relOf, grudgeOf, feelOf, salience, bumpRel, bumpGrudge,
  lend, repay, debtOf, debts,
  friendsOf, enemiesOf, feuds, degreeOf, topConnected, compat,
  isTalking, step, dailyDecay,
  serializeAgent, restoreAgent,
};
