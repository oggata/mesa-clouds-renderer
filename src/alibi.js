// alibi.js — 「その時間、誰がどこに居たか」の粗い記録。
//
// ── なぜ要るか ──
// 目撃台帳 (witness.js) は「犯人はどう見えたか」を持つが、それだけでは
// **容疑者を減らせない**。「赤っぽい服の若い男」に当てはまる住民が12人いても、
// そこから先へ進む手がかりが無い。推理が推理になるのは消去ができるときだけで、
// 消去に要るのは犯人の情報ではなく **犯人以外の情報** — その時間、他の全員が
// どこに居たか、である。
//
// ── アリバイは「居場所」ではない ──
// ここがこの模組の肝。「家に一人で居た」はアリバイではない。アリバイとは
// **他人が証言できる居場所**のことで、裏を取れなければ意味がない。
// だから記録するのは場所だけにして、アリバイが成立するかは
//   「同じ時間に同じ場所を記録している住民が他に居るか」
// で後から judge する。一人で居た住民は自動的に容疑が晴れない。
// これで「アリバイのない人物」が仕込みなしに生まれる。
//
// ── 粗くする ──
// 10分刻み / 屋内は建物単位・屋外は 4x4 セルのゾーン単位。細かくすると
// 全員のアリバイが一意に決まってしまい、消去が一瞬で終わって謎にならない。
// **粗さは手加減ではなく、謎が成立するための条件**。
//
// ── 場所だけでなく所持金も刻む ──
// 同じ輪バッファに、そのスロットの所持金も入れておく。これで
// **「事件のあと金回りが良くなった人」** という第三の手がかりが引ける。
// 場所と証言だけでは消去が2手で終わり、推理が推理にならない。
//
// ── 2日で消える ──
// 輪バッファなので古い事件のアリバイは残らない。これは制約ではなく設計で、
// 聞き込みは事件から2日以内にやらないと間に合わない、という締め切りになる。
// (1000人 x 288スロット x 2バイト = 576KB。保存はしない。)

'use strict';

const DEFAULTS = Object.freeze({
  slotMin: 10,   // 何分を1スロットにするか
  days:    2,    // 何日ぶん覚えるか
  grid:    30,   // 街の一辺 (場所コードの符号化に要る)
  zone:    4,    // 屋外は何セル四方をひとまとめにするか
  outMin:  2,    // 屋外のアリバイは裏取りが何人必要か (屋内は1人)
});

// 場所コード
//   0            記録なし
//   1..grid²     屋内。1 + r*grid + c (建物のセル)
//   0x8000|zone  屋外。zone = (r/zone)*zw + (c/zone)
// 屋内の最大 (120x120 なら 14400) は 0x8000 (32768) より小さいので衝突しない。
const OUT_FLAG = 0x8000;

function createState(opts){
  const cfg=Object.assign({}, DEFAULTS, opts||{});
  const perDay=Math.max(1, Math.round(24*60/cfg.slotMin));
  return {
    cfg, perDay,
    cap: perDay*cfg.days,
    zw:  Math.ceil(cfg.grid/cfg.zone),
    stats:{marks:0, slots:0},
  };
}

/** 何日目の何時が、通しで何スロット目か。 */
const absSlot = (S, day, hour) =>
  day*S.perDay + Math.min(S.perDay-1, Math.floor(hour*60/S.cfg.slotMin));

/** スロットの開始時刻 (時)。証言を「6時20分ごろ」と書くのに使う。 */
const slotHour = (S, slot) => ((slot % S.perDay) * S.cfg.slotMin) / 60;

function placeCode(S, r, c, indoors){
  if(indoors) return 1 + r*S.cfg.grid + c;
  return OUT_FLAG | ((((r/S.cfg.zone)|0) * S.zw) + ((c/S.cfg.zone)|0));
}

function decode(S, code){
  if(!code) return null;
  if(code & OUT_FLAG){
    const z=code & ~OUT_FLAG;
    return {indoors:false, zone:[(z/S.zw)|0, z%S.zw], zoneSize:S.cfg.zone};
  }
  const k=code-1;
  return {indoors:true, cell:[(k/S.cfg.grid)|0, k%S.cfg.grid]};
}

/**
 * 1スロットぶん記録する。呼ぶ側はスロットが変わったときだけ全員ぶん回せばよい。
 * 記録が飛んだぶん (屋内で寝ていた等ではなく、単に呼ばれなかったぶん) は
 * **0 で埋める**。埋めないと一周前の値が「その時間の居場所」として読めてしまう。
 */
function mark(S, a, slot, code, cash){
  const cap=S.cap;
  const ix=s=>((s%cap)+cap)%cap;
  const money=Math.max(0, Math.min(65534, Math.round(cash==null ? (a.cash||0) : cash)))+1;
  if(!a.alib){ a.alib=new Uint16Array(cap); a.alibCash=new Uint16Array(cap); a.alibLast=slot-1; }
  const last=(a.alibLast==null) ? slot-1 : a.alibLast;
  if(slot<=last){ a.alib[ix(slot)]=code; a.alibCash[ix(slot)]=money; return; }
  const gap=slot-last;
  if(gap>=cap){ a.alib.fill(0); a.alibCash.fill(0); }
  else for(let t=last+1; t<slot; t++){ a.alib[ix(t)]=0; a.alibCash[ix(t)]=0; }
  a.alib[ix(slot)]=code; a.alibCash[ix(slot)]=money;
  a.alibLast=slot;
  S.stats.marks++;
}

/** そのスロットの場所コード。古すぎる / 記録がない なら 0。 */
function codeAt(S, a, slot){
  if(!a.alib || a.alibLast==null) return 0;
  if(slot>a.alibLast || slot<=a.alibLast-S.cap) return 0;
  return a.alib[((slot%S.cap)+S.cap)%S.cap];
}

/**
 * 時間の幅ぶんの「その時間・その場所に居た人」の索引。
 *
 * ★ 素直に書くと、容疑者1人の裏を取るのに全住民を舐めることになる
 *   (1500人 x 7スロット x 25容疑者 x 64事件 = 1600万回)。捜査は事件のたびに
 *   走るので、人口を増やした途端にここが効いてくる。先に配っておけば
 *   1スロットにつき全住民1回で済む。
 *   ★ 1か所あたりに覚える人数は cap で頭打ちにする。裏取りは数人取れれば
 *     十分で、駅前に200人居ても200人ぶん覚える意味が無い。
 */
function buildIndex(S, agents, from, to, cap){
  const lim=cap||6;
  const idx=[];
  for(let t=from; t<=to; t++){
    const m=new Map();
    for(const b of agents){
      const code=codeAt(S, b, t);
      if(!code) continue;
      let arr=m.get(code);
      if(!arr) m.set(code, arr=[]);
      if(arr.length<lim) arr.push(b);
    }
    idx.push(m);
  }
  idx.from=from; idx.to=to;
  return idx;
}

/** 同じ時間に同じ場所を記録している住民。= 裏を取れる相手。 */
function corroborators(S, agents, a, slot, max, idx){
  const code=codeAt(S, a, slot);
  if(!code) return [];
  const out=[];
  if(idx && slot>=idx.from && slot<=idx.to){
    for(const b of (idx[slot-idx.from].get(code) || [])){
      if(b===a) continue;
      out.push(b); if(max && out.length>=max) break;
    }
    return out;
  }
  for(const b of agents){
    if(b===a) continue;
    if(codeAt(S, b, slot)===code){ out.push(b); if(max && out.length>=max) break; }
  }
  return out;
}

/**
 * その人のアリバイ。
 *   ok=false は「アリバイが無い」= 容疑が晴れない。理由は3通りあり、
 *   どれなのかを `why` で返す (聞き込みの台詞がここで決まる)。
 *     'nodata'  記録が古くて残っていない
 *     'alone'   場所は分かるが裏を取れる人が居ない ← いちばん物語になる
 *     'weak'    屋外で裏取りが足りない
 */
function alibiFor(S, agents, a, slot, idx){
  const code=codeAt(S, a, slot);
  if(!code) return {ok:false, why:'nodata', code:0, by:[]};
  const out = !!(code & OUT_FLAG);
  const need = out ? S.cfg.outMin : 1;
  const by=corroborators(S, agents, a, slot, need+2, idx);
  if(by.length>=need) return {ok:true, code, outdoors:out, by, place:decode(S, code)};
  return {ok:false, why: by.length ? 'weak' : 'alone',
          code, outdoors:out, by, place:decode(S, code)};
}

/** そのスロットの所持金。記録がなければ null (0 と区別する)。 */
function cashAt(S, a, slot){
  if(!a.alibCash || a.alibLast==null) return null;
  if(slot>a.alibLast || slot<=a.alibLast-S.cap) return null;
  const v=a.alibCash[((slot%S.cap)+S.cap)%S.cap];
  return v ? v-1 : null;
}

/**
 * 時間の幅 [from,to] のあいだの **1スロットあたりの最大の増え方**。
 *
 * ★ 「幅の始めと終わりの差」で見てはいけない。盗った直後に使ってしまえば
 *   差はゼロにも負にもなるので、**犯人を消してしまう** (実測で24%が誤って消えた)。
 *   金が動いた瞬間を1スロットずつ探せば、盗った瞬間は必ずどこかに現れる。
 *   使ったのはその後の別スロットなので、最大値は残る。
 *
 * 戻り値 {max, complete}。complete=false は記録に欠けがあるということで、
 * このとき消去に使ってはいけない (「分からない」を「増えていない」と混ぜない)。
 */
function maxJump(S, a, from, to){
  let max=null, complete=true;
  for(let t=from; t<=to; t++){
    const prev=cashAt(S, a, t-1), cur=cashAt(S, a, t);
    if(prev==null || cur==null){ complete=false; continue; }
    const d=cur-prev;
    if(max==null || d>max) max=d;
  }
  return {max, complete};
}

/**
 * 幅のあるアリバイ。証言の時刻には幅があるので、**その幅ぜんぶを裏付けられて
 * 初めてアリバイになる。** 一瞬でも空白があれば容疑は晴れない。
 *   ★ ここを「代表の1スロットだけ見る」にすると消去が効きすぎて、
 *     容疑者が毎回1人に絞れてしまう (= 謎にならない)。
 */
function alibiOver(S, agents, a, from, to, sceneCode, idx){
  let anyScene=false, gaps=0, best=null, firstGap=null;
  for(let t=from; t<=to; t++){
    const code=codeAt(S, a, t);
    if(code && code===sceneCode){ anyScene=true; }
    const al=alibiFor(S, agents, a, t, idx);
    if(!al.ok){ gaps++; if(!firstGap) firstGap=al; }
    if(!best || (al.ok && !best.ok)) best=al;
  }
  const span=to-from+1;
  // ★ 理由は **最初に裏が取れなかったスロット** から採る。
  //   以前は best (一番よく裏の取れたスロット) から採っていたが、そちらが
  //   ok のときは why を持たないので undefined が表示に出ていた。
  //   知りたいのは「どこで途切れたか」なので、失敗した側を見るのが正しい。
  return {
    ok: gaps===0 && !anyScene,     // 幅ぜんぶを裏付けられ、現場には居ない
    atScene: anyScene,
    gaps, span,
    why: anyScene ? 'scene' : (firstGap ? firstGap.why : 'ok'),
    by: (best && best.by) ? best.by : [],
    place: best ? best.place : null,
  };
}

/** その場所に居たか (犯行現場との突き合わせ)。 */
const wasAt = (S, a, slot, code) => codeAt(S, a, slot)===code;

module.exports = {
  DEFAULTS, OUT_FLAG, createState,
  absSlot, slotHour, placeCode, decode,
  mark, codeAt, cashAt, maxJump, buildIndex, corroborators, alibiFor, alibiOver, wasAt,
};
