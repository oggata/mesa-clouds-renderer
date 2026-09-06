#!/usr/bin/env node
'use strict';
// mystery-report.js — 「良い謎」がどれくらいの割合で出てくるかを、街を起動せずに測る。
//
//   node tools/mystery-report.js [--pop=300] [--n=3000] [--density=0.05] [--motive=0.06]
//
// これは **報酬関数の分布** を見るための道具。分岐探索 (1000回まわして良いものを選ぶ)
// が成立するかどうかは、ここで測る「使える事件の割合」で決まる。
//   ・0% なら、いくら回しても出てこない → 材料 (証拠の種類) が足りない
//   ・50% なら、そもそも探索が要らない → 謎が易しすぎる
//   ・数% なら、探索が効く帯
//
// 街の中身は使わず、事件・目撃・アリバイ・動機を**同じ確率構造で**でっち上げる。
// 本物の街で測るには /mystery を叩く (こちらは仕掛けの当たりを取るための机上検算)。

const WIT = require('../witness.js');
const AL  = require('../alibi.js');
const MYS = require('../mystery.js');
const POOL= require('../persona_pool.json').personas;

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?parseFloat(a.split('=')[1]):d;};
const POP=arg('pop',300), N=arg('n',3000), DENSITY=arg('density',0.05), MOTIVE_P=arg('motive',0.06);
const STEAL=arg('steal',12);      // スリで奪われた額 (金回りの手がかりの閾値になる)
const GRID=40;
const w=(s,n)=>String(s)+' '.repeat(Math.max(0,n-[...String(s)].reduce((a,c)=>a+(c.charCodeAt(0)>0xff?2:1),0)));
const pct=(x,t)=>t?(100*x/t).toFixed(1)+'%':'-';
const rnd=n=>Math.floor(Math.random()*n);

// ── 街をでっち上げる ────────────────────────────────────────────────────────
const looks=[], agents=[];
for(let i=0;i<POP;i++){
  const p=POOL[rnd(POOL.length)], hi=Math.max(p.ageMin,p.ageMax);
  const l={aid:'a'+i, name:'住民'+i, color:p.color, hair:rnd(4),
    gender:p.gender!=='any'?p.gender:(Math.random()<0.5?'m':'f'),
    age:p.ageMin+rnd(hi-p.ageMin+1)};
  looks.push(l); agents.push({aid:l.aid, name:l.name});
}
const byAid=new Map(agents.map(a=>[a.aid,a]));

const W=WIT.createState();
const A=AL.createState({grid:GRID});

// ── 識別力: 人相はどれだけ人を絞ってしまうか ────────────────────────────────
// **これが謎の成否を決める一番の変数。** 街の人口より人相の組み合わせ数が多いと、
// 「水色っぽい服の年配の女」で一人に決まってしまい、消去する余地が残らない。
// (実測: 81人の街では人相だけで常に1人に絞れて、全部 trivial になった。)
{
  const key=(l, lv)=>{
    const c=WIT.colorOf(l.color).en, b=WIT.ageBand(l.age);
    if(lv==='glimpse') return c;
    if(lv==='look')    return c+'|'+l.gender+'|'+(b?b.key:'');
    return c+'|'+l.gender+'|'+(b?b.key:'')+'|'+l.hair;
  };
  console.log('── 人相の識別力 (同じ人相の住民が平均何人いるか) ──────');
  for(const lv of ['glimpse','look','face']){
    const m={};
    for(const l of looks){ const k=key(l,lv); m[k]=(m[k]||0)+1; }
    const buckets=Object.keys(m).length;
    const avg=looks.length/buckets;
    console.log(`  ${w(lv,10)}組み合わせ ${w(buckets,6)}  1組あたり ${w(avg.toFixed(2)+'人',9)}`
      + (avg<1.5 ? '← 一人に決まってしまう (消去の余地なし)' : avg>12 ? '← 絞れなさすぎ' : '★ 良い幅'));
  }
  console.log('');
}

// 場所。屋内=建物セル / 屋外=ゾーン。街の「行き先の偏り」を粗く真似る
// (みんなが同じ数か所に集まると、アリバイが一気に成立して消去が効きすぎる)。
const PLACES=[];
for(let i=0;i<24;i++) PLACES.push(AL.placeCode(A, rnd(GRID), rnd(GRID), true));
for(let i=0;i<40;i++) PLACES.push(AL.placeCode(A, rnd(GRID), rnd(GRID), false));
const pickPlace=()=>PLACES[Math.floor(Math.pow(Math.random(),1.6)*PLACES.length)];

const tally={}, parts={}, chainHist={}, scoreHist={}, slackHist={};
const BAR=0.75;                    // 「使える」とみなす点数。verdict だけでは甘い
let usable=0, good=0;
for(let i=0;i<N;i++){
  const slot=1000+i*7;                     // 事件ごとに別スロット (使い回さない)
  const culprit=looks[rnd(looks.length)];
  const victim =looks[rnd(looks.length)];
  if(victim.aid===culprit.aid) continue;
  const night=Math.random()<0.35, rain=Math.random()<0.2, indoors=Math.random()<0.4;
  const light=indoors?1:(night?0.05+Math.random()*0.2:0.6+Math.random()*0.4);
  const scene=AL.placeCode(A, rnd(GRID), rnd(GRID), indoors);

  // 全員の居場所を **時刻の幅ぶん** (前後 slack+1 スロット)。現場に居る人が目撃者候補。
  //   ★ 1スロットしか埋めないと、幅つきアリバイが「記録なし」だらけになって
  //     誰も消せなくなる。実際の街では毎スロット記録されるので、そこに合わせる。
  const R=W.cfg.range;
  const k=Math.max(0, Math.round(Math.PI*R*R*DENSITY*(indoors?0.25:1)+(Math.random()*3-1.5)));
  const atScene=new Set([culprit.aid, victim.aid]);
  const others=looks.filter(l=>!atScene.has(l.aid));
  for(let j=0;j<k && j<others.length;j++) atScene.add(others[rnd(others.length)].aid);
  const SLACK=4;                                   // 幅の最大 (slackGlimpse=3) より広く埋める
  for(let t=slot-SLACK-1; t<=slot+SLACK; t++){
    // 人はスロットごとに少しだけ動く。ずっと同じ場所に居ると全員アリバイが立つ。
    for(const l of looks){
      const a=byAid.get(l.aid);
      if(t===slot && atScene.has(l.aid)){ AL.mark(A, a, t, scene, a._cash|0); continue; }
      if(a._place==null || Math.random()<0.45) a._place=pickPlace();
      // 所持金。ふだんは減る (買い物) / たまに増える (給料・売上)
      a._cash = Math.max(0, (a._cash|0) + (Math.random()<0.18 ? rnd(20) : -rnd(4)));
      AL.mark(A, a, t, a._place, a._cash);
    }
  }
  // 犯人は **盗った瞬間だけ** 跳ねて、そのあとは普通に使う。
  //   差分で見ると消えてしまう挙動をわざと作る (手がかりが真実を消さないことの確認)。
  {
    const c=byAid.get(culprit.aid);
    let v=(AL.cashAt(A, c, slot)||0)+STEAL;
    for(let t=slot; t<=slot+SLACK; t++){
      if(t>slot) v=Math.max(0, v - rnd(12));       // 盗った直後にどんどん使う
      AL.mark(A, c, t, AL.codeAt(A,c,t)||scene, v);
    }
  }

  // 目撃
  const seen=[];
  let j=0;
  for(const aid of atScene){
    if(aid===culprit.aid) continue;
    // 屋内も散らばらせる (server.js の witnessesAt と同じ考え方)
    const d=indoors ? (1+Math.random()*3.6) : Math.sqrt(Math.random())*R;
    if(!indoors && Math.random()<0.35) continue;               // 建物の陰
    const known=Math.random()<0.12 ? 0.3+Math.random()*0.5 : Math.random()*0.15;
    const sg=WIT.sight(W, culprit, {dist:d, light, rain:rain&&!indoors, indoors, known});
    if(sg){ sg.aid=aid; sg.name=byAid.get(aid).name; seen.push(sg); if(++j>=W.cfg.maxSeen) break; }
  }
  const inc=WIT.record(W, {day:0, hour:12, slot, sceneCode:scene, kind:'pickpocket',
    at:[0,0], indoors, amount:STEAL, culprit:{aid:culprit.aid,name:culprit.name},
    victim:{aid:victim.aid,name:victim.name},
    act:{ja:victim.name+' から金を抜くのを見た', en:'lifting money'}, seen});
  const win=WIT.timeWindow(inc);

  // 動機。犯人は必ず持ち、他は MOTIVE_P で持つ (= 赤鰊の湧く率)
  const motives=new Set([culprit.aid]);
  for(const l of looks) if(Math.random()<MOTIVE_P) motives.add(l.aid);
  // 素朴な推理の答え。当たることもある (当たったら naiveWrong が落ちる)
  const naiveName = Math.random()<0.08 ? culprit.name : looks[rnd(looks.length)].name;

  const sol=MYS.solve(inc, {
    looks, window:win,
    alibiOf: (aid, w)=>{
      const a=byAid.get(aid);
      const al=AL.alibiOver(A, agents, a, w?w.from:slot, w?w.to:slot, scene);
      al.by=(al.by||[]).map(b=>b.name);
      return al;
    },
    jumpOf: (aid, w)=>AL.maxJump(A, byAid.get(aid), (w?w.from:slot), (w?w.to:slot)+1),
    motiveOf: aid=>({score:motives.has(aid)?1:0, why:motives.has(aid)?['恨み']:[]}),
    naiveName,
    foreshadow: Math.random()<0.3,
  });
  const g=MYS.grade(inc, sol);
  tally[g.verdict]=(tally[g.verdict]||0)+1;
  for(const p in g.parts) parts[p]=(parts[p]||0)+g.parts[p];
  chainHist[sol.chain]=(chainHist[sol.chain]||0)+1;
  if(win) slackHist[win.slack]=(slackHist[win.slack]||0)+1;
  const b=Math.min(9, Math.floor(g.score*10));
  scoreHist[b]=(scoreHist[b]||0)+1;
  if(g.verdict==='good'){ good++; if(g.score>=BAR) usable++; }
}

console.log(`人口${POP} / 事件${N}件 / 現場の人口密度${DENSITY} / 動機を持つ率${MOTIVE_P}`);
console.log(`アリバイ: ${A.cfg.slotMin}分刻み ${A.cfg.days}日 / 屋外は裏取り${A.cfg.outMin}人`);
console.log('\n── 判定 ──────────────────────────────────────────────');
const ORDER=['good','trivial','named','unsolvable','no-evidence','unfair','wrong-answer'];
const NOTE={good:'★ 謎として使える', trivial:'消去1手で解ける = 易しすぎ',
  named:'名指しされている = 謎ではない', unsolvable:'最後まで絞りきれない',
  'no-evidence':'誰も見ていない', unfair:'★ NG 犯人が手がかりで消された',
  'wrong-answer':'★ NG 消去法が別人を指した'};
for(const k of ORDER) if(tally[k]) console.log(`  ${w(k,14)}${w(tally[k],7)}${w(pct(tally[k],N),9)}${NOTE[k]}`);
console.log('\n── 採点の内訳 (満たした割合) ──────────────────────────');
for(const k in MYS.W)
  console.log(`  ${w(k,12)}重み${w(MYS.W[k],7)}${pct(parts[k]||0, N)}`);
console.log('\n── 時刻の幅 (証言を突き合わせた結果) ──────────────────');
for(const k of Object.keys(slackHist).sort((a,b)=>a-b))
  console.log(`  ${w('±'+k+'スロット',12)}${w(slackHist[k],7)}${pct(slackHist[k],N)}`);
console.log('\n── 消去の手数 ────────────────────────────────────────');
for(const k of Object.keys(chainHist).sort())
  console.log(`  ${w(k+'手',6)}${w(chainHist[k],7)}${w(pct(chainHist[k],N),9)}`
    + (k>=MYS.CHAIN_MIN && k<=MYS.CHAIN_MAX ? '★ 読める幅' : ''));
console.log('\n── 点数の分布 ────────────────────────────────────────');
for(let b=0;b<10;b++){
  const v=scoreHist[b]||0; if(!v) continue;
  console.log(`  ${w((b/10).toFixed(1)+'〜',7)}${w(v,7)}${w(pct(v,N),9)}`
    + '#'.repeat(Math.round(40*v/N)) + (b/10>=BAR ? '  ★' : ''));
}
console.log(`\n判定が good なもの        ${good}/${N} = ${pct(good,N)}`);
console.log(`そのうち ${BAR} 点以上      ${usable}/${N} = ${pct(usable,N)}   ← これが「使える事件」`);
console.log(usable===0 ? '  → 証拠の種類が足りない。いくら回しても出てこない。'
  : usable/N>0.4 ? '  → 出すぎ。謎が易しい。証言をもっと劣化させるか動機を減らす。'
  : `  → 探索が効く帯。${Math.ceil(1/(usable/N))} 分岐まわせば期待値1件。`);
// いちばん効いていない項目を名指しする。ここが次に手を入れる場所。
const worst=Object.keys(MYS.W).map(k=>({k, r:(parts[k]||0)/N})).sort((a,b)=>a.r-b.r)[0];
console.log(`\n頭打ちになっている条件: ${worst.k} (${(worst.r*100).toFixed(1)}%)`
  + ' ← 点数を上げたいならまずここ');
