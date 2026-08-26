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
    const n=arr.length, off=n>1 ? (Math.random()*n)|0 : 0;
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

// 相性。社交的な人ほど早く親しくなる。personas.json の sociability (既定 0.4)。
function compat(a, b){
  const sa=(a.def && a.def.sociability!=null) ? a.def.sociability : 0.4;
  const sb=(b.def && b.def.sociability!=null) ? b.def.sociability : 0.4;
  return 0.35 + (sa+sb)*0.65;      // 0.35 〜 1.65 倍
}

// 覚えていられる人数には上限がある。溢れたら一番薄い相手を忘れる。
function trimRel(a, relMax){
  const keys=Object.keys(a.rel);
  if(keys.length<=relMax) return;
  keys.sort((x,y)=>a.rel[x].s-a.rel[y].s);
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

const friendsOf = (a, thr) => Object.entries(a.rel||{})
  .filter(([,e])=>e.s>=(thr!=null?thr:DEFAULTS.relFriend))
  .sort((x,y)=>y[1].s-x[1].s).map(([id])=>id);

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
  const rng=ctx.rng || Math.random;

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
    if(a.rel && near.length>1)
      near.sort((x,y)=>relOf(a,y.aid)-relOf(a,x.aid));

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
      const p=cfg.talkP*(0.4+relOf(a,b.aid));
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
      if(e.s<0.02) delete a.rel[k];
    }
  }
}

// ── 保存 / 復元 ─────────────────────────────────────────────────────────────
// 上位 n 件だけ保存する (1000人ぶん全部持つと状態ファイルが膨らむ)。
// 形式: {相手aid: [親密度, 会った回数, 最後に会った日]}
function serializeAgent(a, n){
  if(!a.rel) return undefined;
  const top=Object.entries(a.rel).sort((x,y)=>y[1].s-x[1].s).slice(0, n||6);
  if(!top.length) return undefined;
  return Object.fromEntries(top.map(([k,e])=>[k, [+e.s.toFixed(2), e.n||0, e.d||0]]));
}
function restoreAgent(a, saved){
  if(!saved) return;
  a.rel={};
  for(const k of Object.keys(saved)){
    const v=saved[k];
    a.rel[k]={s:+v[0]||0, n:+v[1]||0, d:+v[2]||0};
  }
}

module.exports = {
  DEFAULTS, createState,
  buildGrid, neighbors,
  relOf, friendsOf, degreeOf, topConnected, compat,
  isTalking, step, dailyDecay,
  serializeAgent, restoreAgent,
};
