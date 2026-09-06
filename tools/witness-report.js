#!/usr/bin/env node
'use strict';
// witness-report.js — 恨み (social.js) と目撃台帳 (witness.js) を、街を起動せずに数える。
//
//   node tools/witness-report.js [--pop=300] [--n=4000] [--density=0.05]
//
// 見たいのは3つ。
//   1. **何回もめると動機になるか。** 一度の口論で憎み合うようでは街が壊れる。
//   2. **証言がどれくらい劣化するか。** 全部が「名前まで分かる」なら謎にならないし、
//      全部が「誰か」なら手がかりが無い。距離と明るさで階段になっている必要がある。
//   3. **証言だけで何人まで絞れるか。** ここがいちばん大事。1人に絞れる事件は
//      謎として易しすぎ、街の全員が残る事件は手がかりゼロ。3〜8人が良い幅で、
//      その幅に入る事件が全体の何割あるかが「ミステリーの素材の歩留まり」になる。

const SOC = require('../social.js');
const WIT = require('../witness.js');
const EV  = require('../events.js');

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?parseFloat(a.split('=')[1]):d;};
const POP=arg('pop',300), N=arg('n',4000), DENSITY=arg('density',0.05);
const w=(s,n)=>String(s)+' '.repeat(Math.max(0,n-[...String(s)].reduce((a,c)=>a+(c.charCodeAt(0)>0xff?2:1),0)));
const pct=(x,t)=>t?(100*x/t).toFixed(1)+'%':'-';

// ── 1. 恨みが動機になるまで ────────────────────────────────────────────────
const S=SOC.createState();
console.log('── 1. 何回もめると「遺恨あり」になるか ──────────────────────────');
console.log(`   grudgeEnemy=${S.cfg.grudgeEnemy}  grudgeDecay=${S.cfg.grudgeDecay}/日`);
for(const pair of EV.PAIRS.filter(p=>p.grudge)){
  for(const side of ['a','b']){
    const amt=pair.grudge[side]; if(!amt) continue;
    const A={aid:'A',rel:{}}, B={aid:'B'};
    let hit=null, trail=[];
    for(let n=1;n<=6;n++){
      if(SOC.bumpGrudge(S,A,B,amt,0) && !hit) hit=n;
      trail.push(SOC.grudgeOf(A,'B').toFixed(2));
    }
    console.log(`   ${w(pair.from,10)} ${side}側 +${amt.toFixed(2)} → `
      +w(hit?hit+'回でこじれる':'6回でも届かない',16)+trail.join(' → '));
  }
}
// 忘れるまで
{
  const A={aid:'A',rel:{}}, B={aid:'B'};
  SOC.bumpGrudge(S,A,B,0.30,0); SOC.bumpGrudge(S,A,B,0.30,0); SOC.bumpGrudge(S,A,B,0.30,0);
  let d=0; while(SOC.grudgeOf(A,'B')>=S.cfg.grudgeEnemy && d<90){ SOC.dailyDecay(S,[A]); d++; }
  let d2=d; while(A.rel['B'] && d2<400){ SOC.dailyDecay(S,[A]); d2++; }
  console.log(`   3回もめた恨み (${(0.3+0.3*0.7+0.3*0.49).toFixed(2)}) は ${d}日で閾値を割り、${d2}日で忘れる`);
}
// trimRel が恨みを食わないか (親しさ0の相手が relMax 溢れで消えないこと)
{
  const A={aid:'A',rel:{}};
  SOC.bumpGrudge(S,A,{aid:'ENEMY'},0.9,0);
  for(let i=0;i<S.cfg.relMax+6;i++) SOC.bumpRel(S,A,{aid:'F'+i,def:{sociability:0.9}},0);
  console.log(`   ${w('trimRel',10)} 顔見知りを ${S.cfg.relMax+6} 人作っても恨みは残るか → `
    +(SOC.grudgeOf(A,'ENEMY')>0 ? 'OK (残る)' : '★ NG (消えた)'));
}

// ── 2. 証言の劣化 ──────────────────────────────────────────────────────────
const W=WIT.createState();
const LOOK={aid:'x', name:'花屋ミカ', color:0xe14747, hair:0, gender:'f', age:24};
console.log('\n── 2. どこまで見えるか (犯人=赤い服の若い女・黒髪) ──────────────');
console.log('   ' + w('距離',6)+w('昼/晴',34)+w('昼/雨',30)+'夜/晴');
for(const d of [1,2,3,4,5,6,7,8,9]){
  const cell=(light,rain)=>{
    const s=WIT.sight(W, LOOK, {dist:d, light, rain, known:0}, ()=>0.5);
    return s ? `${w(s.level,8)}${WIT.describe(s.traits,true)}` : '—';
  };
  console.log('   '+w(d+'セル',6)+w(cell(1,false),34)+w(cell(1,true),30)+cell(0.05,false));
}
{
  const s=WIT.sight(W, LOOK, {dist:1, light:1, known:0.6}, ()=>0.5);
  console.log(`   顔見知り (親しさ0.6) が 1セルで見ると → ${s.level} 「${s.named}」`);
}

// ── 3. 事件を N 件でっち上げて、証言の歩留まりを見る ────────────────────────
// 街の人の見た目を POP 人ぶん作る。**実際のペルソナプールから引く**
// (色の種類と年齢の分布がここの絞り込みをそのまま決めるので、仮の値では意味がない)。
const POOL=require('../persona_pool.json').personas;
const rnd=n=>Math.floor(Math.random()*n);
const looks=[];
for(let i=0;i<POP;i++){
  const p=POOL[rnd(POOL.length)];
  const hi=Math.max(p.ageMin, p.ageMax);
  looks.push({aid:'a'+i, name:'住民'+i, color:p.color, hair:rnd(4),
    gender:p.gender!=='any' ? p.gender : (Math.random()<0.5?'m':'f'),
    age:p.ageMin + rnd(hi-p.ageMin+1)});
}
console.log(`\n   (見た目はペルソナプール ${POOL.length}種から抽選: 色`
  + ` ${new Set(POOL.map(p=>p.color)).size}通り x 髪4 x 性別2 x 年代4)`);

const W2=WIT.createState();
const hist={}, lvl={name:0,face:0,look:0,glimpse:0};
let unseen=0, sightings=0;
for(let i=0;i<N;i++){
  const culprit=looks[rnd(looks.length)];
  const night=Math.random()<0.35, rain=Math.random()<0.2, indoors=Math.random()<0.4;
  const light=indoors ? 1 : (night ? 0.05+Math.random()*0.2 : 0.6+Math.random()*0.4);
  // 半径 range の円に密度 DENSITY で人が居るとして、居合わせた人数と距離を引く
  const R=W2.cfg.range;
  const k=Math.max(0, Math.round(Math.PI*R*R*DENSITY*(indoors?0.25:1) + (Math.random()*3-1.5)));
  const seen=[];
  for(let j=0;j<k;j++){
    const d = indoors ? 1.5 : Math.sqrt(Math.random())*R;
    if(!indoors && Math.random()<0.35) continue;            // 建物の陰 (losClear 相当)
    const known = Math.random()<0.12 ? 0.3+Math.random()*0.5 : Math.random()*0.15;
    const s=WIT.sight(W2, culprit, {dist:d, light, rain:rain&&!indoors, indoors, known});
    if(s){ s.aid='w'+j; s.name='目撃者'+j; seen.push(s); }
  }
  seen.sort((a,b)=>b.q-a.q);
  const inc=WIT.record(W2, {day:0, hour:12, kind:'shoplift', at:[0,0], indoors,
    culprit:{aid:culprit.aid, name:culprit.name}, victim:null,
    act:{ja:'品物を持ち出すのを見た', en:'taking goods'}, seen});
  for(const s of inc.seen){ sightings++; lvl[s.level]++; }
  if(!inc.seen.length) unseen++;
  const pool=WIT.narrow(inc, looks);
  // 真犯人が候補に残っているか (残らなければ証言が嘘をついている = 不公平)
  if(!pool.some(l=>l.aid===culprit.aid)) hist.UNFAIR=(hist.UNFAIR||0)+1;
  const b=pool.length;
  const key=b===0?'0':b===1?'1':b<=3?'2-3':b<=8?'4-8':b<=20?'9-20':'21+';
  hist[key]=(hist[key]||0)+1;
}
console.log(`\n── 3. 事件 ${N} 件 (人口${POP} / 密度${DENSITY}人/セル²) ────────────────`);
console.log(`   誰にも見られなかった  ${w(unseen,7)} ${pct(unseen,N)}`);
console.log(`   証言の総数            ${w(sightings,7)} (1件あたり ${(sightings/N).toFixed(2)}人)`);
for(const k of ['name','face','look','glimpse'])
  console.log(`     ${w(k,20)}${w(lvl[k],7)} ${pct(lvl[k],sightings)}`);
console.log('\n   証言だけで容疑者が何人に絞れるか (★ が物語になる幅)');
for(const k of ['0','1','2-3','4-8','9-20','21+']){
  const v=hist[k]||0;
  console.log(`     ${w(k+'人',8)}${w(v,7)} ${w(pct(v,N),8)}`
    + (k==='1' ? '証言だけで解ける = 易しすぎ'
      : k==='2-3'||k==='4-8' ? '★ 聞き込みで潰せる幅'
      : k==='0' ? '証言が食い違っている (0 のはず)' : ''));
}
if(hist.UNFAIR) console.log(`   ★ NG: 真犯人が候補から漏れた事件が ${hist.UNFAIR} 件 (証言が嘘をついている)`);
else console.log('   真犯人はすべての事件で候補に残っている (証言は曖昧になるだけで嘘はつかない)');
