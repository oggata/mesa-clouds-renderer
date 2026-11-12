// mystery.js — 事件を「謎として成立しているか」で採点する。
//
// ── なぜ採点なのか ──
// 「面白い」は定義できない。だが **謎として解ける形になっているか** は定義できるし、
// 計算もできる。そして面白さのうち機械が握れるのはそこだけである。
// ここが握るのは形式で、面白さそのものは視聴者が決める (下の audience を参照)。
//
// ── 解くのは手続きであって探偵ではない ──
// 探偵を「推理するキャラクター」として書くと必ず破綻する。ここでやるのは消去法で、
//   1. 人相    … 目撃証言に当てはまらない住民を落とす (witness.js)
//   1b.変装    … 当てはまる住民が**全員アリバイ持ち**なら、化けていたと結論する
//   2. アリバイ … 証言の時刻の**幅ぜんぶ**を裏付けられた住民を落とす (alibi.js)
//   3. 動機    … 残った中で動機のある者を挙げる (**消去はしない**)
//   4. 決め手  … 動機のある者のうち、事件の瞬間に金が増えた者を指す
// この4段だけ。増やすほど「解けるが読めない」話になる。
//
// ★ 3 と 4 の順番が肝。最初は金回りを動機より**前**に置いていたが、それだと
//   「動機のある容疑者が複数残る」= 赤鰊がいる状態が、そのまま「絞りきれない」に
//   なってしまう。解ける話と赤鰊のいる話が**両立しなくなり**、どんな事件も
//   0.8点で頭打ちになっていた (探索の全枝が 0.8 で並んで判明した)。
//   動機で容疑者を並べ、最後に物証で1人を指す — この順にして初めて
//   「二人とも怪しいが、金が動いたのはこちらだった」という形が作れる。
//
// ★ 2 が「幅ぜんぶ」なのが肝。時刻を一点に決めると、その一瞬だけ裏の取れない人しか
//   残らず、毎回1人に絞れて謎にならない。幅があると数人残り、聞き込みの余地ができる。
//
// ── 良い謎の条件 ──
//   ・解ける           手がかりだけで答えが一つに決まる
//   ・自明でない       素朴な推理 (一番怪しい奴が犯人) では外れる
//   ・赤鰊がいる       動機はあるが犯人ではない人物が残る
//   ・手数が 2〜4      1手で解けるのは謎ではなく、5手以上は視聴者が降りる
//   ・フェア           犯人が途中で消去されない (=手がかりが嘘をついていない)
//   ・伏線がある       犯人が被害者の来歴に事件前から出ている
// 重みは下の W にまとめてある。**これは当て推量の初期値**で、正しくは
// 視聴者の当てっぷり (audience) に合わせて後から調整するもの。

'use strict';

const WIT = require('./witness.js');

// 採点の重み。合計 1.0。★ 実測で調整する前提の初期値。
const W = Object.freeze({
  solvable:   0.30,   // 解けること。これが無ければ何も始まらない
  redHerring: 0.20,   // 誤答の候補。無いと「消去したら1人残った」だけの話になる
  naiveWrong: 0.15,   // 素朴な推理が外れること
  chain:      0.15,   // 手数が 2〜4 に収まっていること
  foreshadow: 0.10,   // 動機が来歴に見えていること
  fair:       0.10,   // 犯人が消去されていないこと
});
// 手数の許容幅。
//   証拠は3軸 (人相 / アリバイ / 金回り) なので chain は最大 3。
//   スリには3軸すべてが効き、万引きは被害者が居ないので金回りが使えず最大2になる。
//   4 を上限に残してあるのは、次の軸を足したときに天井が見えるようにするため。
const CHAIN_MIN=2, CHAIN_MAX=4;
// 「金回りが良くなった」とみなす跳ねの大きさ (盗られた額に対する割合)。
//   低くするほど消去は甘くなるが、犯人を誤って消す危険が減る。
//   **手がかりは真実を消してはいけない** ので、迷ったら低いほうへ倒す。
const CASH_NEED_FRAC=0.4;

/**
 * 消去法を回す。
 *   ctx = {
 *     looks:      街の全員の見た目 [{aid,name,color,hair,gender,age}]
 *     alibiOf:    aid => {ok, why, atScene, by:[名前]} | null
 *     motiveOf:   aid => {score, why} | null
 *     naiveName:  「街で一番怪しい人」の名前 (素朴な推理の答え)
 *     foreshadow: bool  犯人が被害者の来歴に事件前から出ているか
 *   }
 */
function solve(inc, ctx){
  const steps=[];
  const cut=(name, before, after, note)=>{
    steps.push({name, from:before.length, to:after.length,
                removed:before.length-after.length, note});
    return after;
  };
  const named=(inc.seen||[]).find(s=>s.level==='name') || null;

  // 1) 人相
  let pool=ctx.looks;
  const afterLook=WIT.narrow(inc, pool);
  pool=cut('人相', pool, afterLook, (inc.seen||[]).length ? '目撃証言の服・性別・年代・髪' : '証言なし');

  // 2) アリバイ。**時刻の幅ぜんぶ**を裏の取れる別の場所で過ごした人だけが消える。
  //    「一人で家に居た」は消えない — アリバイとは他人が証言できる居場所のこと。
  const win=ctx.window || null;
  const alibi={};
  const afterAlibi=pool.filter(l=>{
    const al=ctx.alibiOf(l.aid, win);
    alibi[l.aid]=al;
    return !(al && al.ok && !al.atScene);
  });
  pool=cut('アリバイ', pool, afterAlibi,
    win ? `${(win.slack*2+1)}スロット幅ぜんぶを裏付けられた住民を除く` : '時刻が分からず消せない');

  // 2b) 変装の発覚。
  //   **証言に当てはまる住民が居ない / 居ても全員に裏が取れている** ときは、
  //   その人相の人物は犯行時に現場に居られなかったことになる。証言は嘘をつかない
  //   のだから、残る説明は一つしかない — **当てはまらない誰かが化けていた。**
  //   ここで人相の絞り込みを捨て、時刻の幅に裏の取れない住民へ振り直す。
  //   ★ 犯人は現場に居た = 裏が取れないので、必ずこの網に残る。フェアは保たれる。
  let disguise=false;
  if(pool.length===0 && (inc.seen||[]).length && !named){
    disguise=true;
    const reopened=ctx.looks.filter(l=>{
      const al=ctx.alibiOf(l.aid, win);
      alibi[l.aid]=al;
      return !(al && al.ok && !al.atScene);
    });
    steps.push({name:'変装', from:0, to:reopened.length,
                removed:0,
                note:'その人相の住民は全員その時間の裏が取れている → 化けていた'});
    pool=reopened;
  }

  // 2c) 最後に被害者と一緒に居た人。**殺人のときだけ**。
  //   目撃者が一人も居ない事件でも、被害者の足取りは台帳に残っている。
  //   死亡推定時刻の幅のあいだに被害者と同じ場所に居た住民へ絞る。
  //   ★ 犯人は現場で被害者と同じ場所に居るので、必ずこの網に残る (フェア)。
  if(ctx.withVictim && inc.kind==='murder'){
    const near=pool.filter(l=>ctx.withVictim(l.aid));
    if(near.length) pool=cut('最後に一緒に居た人', pool, near,
      '死亡推定時刻のあいだに被害者と同じ場所に居た住民');
  }

  // 3) 動機。**消去はしない。** 動機は証拠ではないので、容疑者を挙げるだけ。
  //    ここに複数残るのが良い謎の形で、その全員が「怪しい人」になる。
  const motive={};
  const motived=pool.filter(l=>{
    const m=ctx.motiveOf(l.aid);
    motive[l.aid]=m;
    return m && m.score>0;
  });
  steps.push({name:'動機', from:pool.length, to:motived.length, removed:0,
              note:'被害者への恨み / 困窮 / 前科 (消去はしない)'});

  // 4) 決め手。スリだけ。**盗った金は、盗った瞬間に必ず現れる。**
  //    見るのは幅の前後差ではなく **1スロットあたりの跳ね**。差で見ると、
  //    盗った直後に使った犯人が消えてしまう (= 手がかりが嘘をつく)。
  //    記録に欠けがある人は消さない — 「分からない」と「増えていない」は別物。
  //    ★ 掛けるのは **動機のある者** に対して。ここが最後の一手になる。
  const gain={};
  let decided=null;
  if(ctx.jumpOf && inc.kind==='pickpocket' && inc.amount>0){
    const base=motived.length ? motived : pool;
    const need=Math.max(2, inc.amount*CASH_NEED_FRAC);
    const kept=base.filter(l=>{
      const j=ctx.jumpOf(l.aid, win);
      gain[l.aid]=j;
      if(!j || !j.complete || j.max==null) return true;   // 記録が足りない → 消さない
      return j.max>=need;
    });
    steps.push({name:'決め手', from:base.length, to:kept.length,
                removed:base.length-kept.length,
                note:`事件の瞬間に所持金が ${Math.round(need)} 以上跳ねた者`});
    decided=kept;
  }

  const answer = (decided && decided.length===1) ? decided[0]
               : motived.length===1 ? motived[0]
               : pool.length===1    ? pool[0]
               : null;
  // ★ 「犯人が候補から消えた」には二種類あって、混ぜてはいけない。
  //     inTown=false … 犯人はもう街に居ない。**採点できない事件**であって、
  //                    手がかりが悪いわけではない (転入転出のある街では避けられない)。
  //     inTown=true かつ pool に居ない … 手がかりが犯人を消した = 本当に不公平。
  //   ここを一緒にすると、街の人の入れ替わりが全部「証拠のバグ」に見える (実際になった)。
  const inTown = ctx.looks.some(l=>l.aid===inc.culprit.aid);
  const culpritIn = pool.some(l=>l.aid===inc.culprit.aid);

  return {
    named, steps, suspects:pool, motived, answer, window:win, disguise,
    alibi, motive, gain, inTown,
    // アリバイ台帳の保持期間を過ぎた事件は消去のしようがない。冷えた事件。
    cold: ctx.alibiWindow===false,
    fair: culpritIn,
    correct: !!(answer && answer.aid===inc.culprit.aid),
    // 手数 = 実際に容疑者を減らした段の数
    chain: steps.filter(s=>s.removed>0).length,
    // 赤鰊 = **動機があって容疑者に残ったが、犯人ではない人物**。
    //   決め手で落ちる前の段階で数える。最後まで疑われていた人が赤鰊なので、
    //   決め手のあとで数えると常に 0 になってしまう。
    redHerrings: motived.filter(l=>l.aid!==inc.culprit.aid).map(l=>l.name),
    decided: decided ? decided.map(l=>l.name) : null,
    naiveWrong: !!ctx.naiveName && ctx.naiveName!==inc.culprit.name,
    foreshadow: !!ctx.foreshadow,
  };
}

/** 形の採点。0..1 と、なぜその点なのかの内訳。 */
function grade(inc, sol){
  const p={};
  p.solvable   = sol.answer ? 1 : 0;
  p.redHerring = sol.redHerrings.length ? 1 : 0;
  p.naiveWrong = sol.naiveWrong ? 1 : 0;
  p.chain      = (sol.chain>=CHAIN_MIN && sol.chain<=CHAIN_MAX) ? 1
               : sol.chain===CHAIN_MAX+1 ? 0.5 : 0;
  p.foreshadow = sol.foreshadow ? 1 : 0;
  p.fair       = sol.fair ? 1 : 0;

  let score=0; for(const k in W) score += W[k]*(p[k]||0);

  // ── 打ち切り条件 ──────────────────────────────────────────────────────
  let verdict='good';
  if(!sol.inTown){ verdict='stale'; score=0; }          // 犯人が街に居ない = 採点対象外
  else if(sol.cold){ verdict='cold'; score=0; }         // アリバイ台帳の外 = 捜査打ち切り
  // ★ 手がかりが本当に無いのは「証言も無く、時刻の幅も無い」ときだけ。
  //   殺人は目撃者が一人も居なくても、死体が死亡推定時刻をくれるので消去は始まる。
  //   ここを証言の有無だけで見ていると、**密室ものが全部 0 点になる**。
  else if(!(inc.seen||[]).length && !sol.window){ verdict='no-evidence'; score=0; }
  else if(!sol.fair){
    // 犯人が容疑者から漏れた。**原因が二つあり、混ぜてはいけない。**
    //   ・変装が効いた … 人相が別人を指し、その人相の住民に裏が取れてしまった。
    //     トリックが成功した状態で、仕組みの穴ではない。ただし解けないので0点。
    //     (完全に成功した変装は謎として成立しない。作中でも必ずどこかで綻びる。)
    //   ・それ以外    … 手がかりが嘘をついている = **こちらは本当のバグ**。
    //     unfair の件数は仕組みの健全性を測る指標として残す。
    verdict = inc.disguised ? 'disguised' : 'unfair';
    score=0;
  }
  else if(sol.answer && !sol.correct){ verdict='wrong-answer'; score=0; }
  else if(sol.named){ verdict='named'; score*=0.15; }     // 名指しされている = 謎ではない
  else if(sol.chain<=1 && sol.answer){ verdict='trivial'; score*=0.4; }
  else if(!sol.answer){ verdict='unsolvable'; score*=0.5; }

  return {score:+score.toFixed(3), verdict, parts:p, weights:W};
}

/** 捜査の経過を読める形に。配信でそのまま出せる粒度にしてある。 */
function explain(inc, sol, ja){
  const L=[];
  const seen=inc.seen||[];
  if(inc.kind==='murder' && inc.found){
    L.push(ja ? `Day${inc.found.day+1} ${Math.floor(inc.found.hour)}時 — ${inc.place||'路上'} で ${inc.victim?inc.victim.name:'住民'} が見つかった`
              : `Day${inc.found.day+1} ${Math.floor(inc.found.hour)}:00 - ${inc.victim?inc.victim.name:'a resident'} found at ${inc.place||'the street'}`);
    if(sol.window)
      L.push(ja ? `  死亡推定時刻: ${sol.window.to-sol.window.from+1}スロットの幅 (最後に裏の取れた時刻 〜 発見)`
                : `  time of death: a window of ${sol.window.to-sol.window.from+1} slots`);
  } else
  L.push(ja ? `Day${inc.day+1} ${Math.floor(inc.hour)}時ごろ — ${inc.place||'路上'}`
            : `Day${inc.day+1} around ${Math.floor(inc.hour)}:00 - ${inc.place||'the street'}`);
  for(const s of seen) L.push('  ' + (ja?'証言: ':'saw: ') + s.name + '「' + WIT.line(inc, s, ja) + '」');
  if(sol.window)
    L.push('  ' + (ja ? `時刻: 証言を突き合わせて ±${sol.window.slack}スロットまで絞れた`
                      : `time: narrowed to +-${sol.window.slack} slots`));
  if(sol.disguise)
    L.push('  ' + (ja ? '★ 人相に合う住民が一人も現場に居られない — 化けていた'
                      : '* nobody matching the description could have been there - a disguise'));
  for(const st of sol.steps)
    L.push(`  ${st.name}: ${st.from} → ${st.to}人` + (st.note?`  (${st.note})`:''));
  if(sol.redHerrings.length)
    L.push('  ' + (ja?'動機のある容疑者: ':'suspects with motive: ')
      + [...sol.redHerrings, inc.culprit.name].sort().join(' / '));
  if(sol.answer) L.push('  ' + (ja?'→ 決め手が指したのは ':'→ points to ') + sol.answer.name);
  else L.push('  ' + (ja?`→ ${sol.suspects.length}人に絞れたところまで` : `→ narrowed to ${sol.suspects.length}`));
  return L;
}

// ── 面白さの正解は視聴者が持っている ────────────────────────────────────────
// 上の grade は「解ける形か」しか見ていない。**面白いかどうかは定義できない**ので、
// 定義しようとせず、当てっぷりから測る。配信のチャットで解決前に犯人を当ててもらう。
//
//   ・誰も当てられない (correct≈0)  → 手がかりが足りない。不親切な謎
//   ・ほぼ全員当てる  (correct≈1)  → 自明。謎になっていない
//   ・3〜4割が当てて、残りが割れる  → いちばん良い
//
// split (推測の割れ具合) が高いほど「複数の容疑者が本気で疑われた」ことを意味する。
// これが grade の重み W を調整するための唯一の外部信号になる。
function audience(votes, truthName){
  const names=Object.keys(votes||{});
  const n=names.reduce((s,k)=>s+votes[k], 0);
  if(!n) return {n:0, correct:null, split:null, grade:null};
  const correct=(votes[truthName]||0)/n;
  let H=0;
  for(const k of names){ const q=votes[k]/n; if(q>0) H-=q*Math.log(q); }
  const split = names.length>1 ? H/Math.log(names.length) : 0;
  const IDEAL=0.35;
  const fit = 1 - Math.abs(correct-IDEAL)/Math.max(IDEAL, 1-IDEAL);
  return {n, correct:+correct.toFixed(3), split:+split.toFixed(3),
          grade:+(0.65*Math.max(0,fit) + 0.35*split).toFixed(3)};
}

module.exports = { W, CHAIN_MIN, CHAIN_MAX, CASH_NEED_FRAC, solve, grade, explain, audience };
