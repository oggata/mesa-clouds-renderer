#!/usr/bin/env node
'use strict';
// vec-report.js — 行動のベクトル化 (VEC=1) を、従来の段 (VEC=0) と同じ種で並べる。
//
//   node tools/vec-report.js [--days=6] [--pop=150] [--seed=4242] [--eras]
//
// ── 見るもの ──
//   ① 暮らしの健全さ … 飢えている人 / 疲れ切った人 / 深夜に自宅 / 来店 (経済活動) / 開業と閉店
//   ② 過ごし方の種類 … 1 日に出た「効いたチャンネル上位 2 つ + 場所」の署名の数とエントロピー
//   ③ --eras        … 時代を固定して、在宅勤務・通販・通勤・屋外の人流を並べる
//                      (ベクトル版では**規則として書いていない**ので、ここに出る差は自宅の提供ベクトルの差から出たもの)
//
// ★ server.js は native の headless-gl を使うので、ビルドした Node で回すこと
//   (違う版の Node だと ERR_DLOPEN_FAILED で落ちる)。子プロセスは自分と同じ Node で起動する。

const {spawn} = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const DAYS=arg('days','6'), POP=arg('pop','150'), SEED=arg('seed','4242'), ERAS=process.argv.includes('--eras');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-vec-'));

function run(tag, extra, port){
  return new Promise(resolve=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:DAYS, SIM_FAST_REPORT_DAYS:'9999', NO_STREAM:'1',
      NUM_AGENTS:POP, GRID:'32', START_VILLAGE:'0', POP_MAX:'0', SIM_SEED:SEED, CITY_SEED:SEED,
      CITY_STATE_FILE:path.join(TMP, tag+'.json'), PORT:String(port),
    }, extra);
    const p=spawn(process.execPath, [path.join(__dirname,'..','server.js')], {env});
    let out='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
    p.on('close',()=>{
      const pick=re=>[...out.matchAll(re)].map(m=>JSON.parse(m[1]));
      resolve({life:pick(/\[LifeJSON\] (\{.*\})/g), vec:pick(/\[VecJSON\] (\{.*\})/g),
        flow:pick(/\[TechFlow\] (\{.*\})/g), unmet:pick(/\[VecUnmet\] (\{.*\})/g),
        errs:(out.match(/(TypeError|ReferenceError|ERR_DLOPEN_FAILED)[^\n]*/g)||[])});
    });
  });
}
const avg=(rows,k)=>rows.length ? rows.reduce((s,r)=>s+(r[k]||0),0)/rows.length : null;
const f1=v=>v==null?'-':(+v).toFixed(1);

(async()=>{
  console.log(`行動のベクトル化  ${DAYS}日 / 人口${POP} / seed=${SEED}  (Node ${process.version})`);
  const [A,B]=await Promise.all([run('legacy',{VEC:'0'},9601), run('vec',{VEC:'1'},9602)]);
  for(const [n,r] of [['VEC=0',A],['VEC=1',B]]) if(r.errs.length) console.log(`  ⚠ ${n}: ${r.errs[0]}`);
  const L=r=>r.life, last=r=>r.life[r.life.length-1]||{};
  console.log('\n① 暮らしの健全さ (日の平均)            VEC=0 (段)   VEC=1 (ベクトル)');
  for(const [k,label] of [['starving','飢えている人 %'],['exhausted','疲れ切った人 %'],['nightAtHome','深夜に自宅 %'],['workersWorking','平日11時に働いている %']])
    console.log(`  ${label.padEnd(24)} ${f1(avg(L(A),k)).padStart(8)}   ${f1(avg(L(B),k)).padStart(8)}`);
  console.log(`  ${'経済活動 (来店の累計)'.padEnd(21)} ${String(last(A).econ).padStart(8)}   ${String(last(B).econ).padStart(8)}`);
  console.log(`  ${'開業 / 閉店'.padEnd(24)} ${(last(A).opened+'/'+last(A).closed).padStart(8)}   ${(last(B).opened+'/'+last(B).closed).padStart(8)}`);
  console.log(`  ${'人口'.padEnd(26)} ${String(last(A).pop).padStart(8)}   ${String(last(B).pop).padStart(8)}`);
  console.log('\n② 過ごし方の種類 (VEC=1)  ※段の版は Option の数 (8) を超えない');
  console.log(`  1日の種類 平均 ${f1(avg(B.vec,'kinds'))}  エントロピー ${f1(avg(B.vec,'entropyBits'))} bit`);
  const lastV=B.vec[B.vec.length-1];
  if(lastV) console.log('  多い過ごし方: '+lastV.top.slice(0,6).map(([k,v])=>`${k} ${v}%`).join('  '));
  if(B.unmet.length) console.log('  叶わなかった欲求: '+B.unmet.map(u=>`D${u.day} ${u.top.join('×')}(${u.n})→${u.want||'-'}`).join('  '));

  const out={legacy:{life:A.life}, vec:{life:B.life, kinds:B.vec}};
  if(ERAS){
    console.log('\n③ 時代ごとの人流 (VEC=1、平日の平均。規則は書いていない)');
    const R=await Promise.all([0,1,2,3].map(e=>run('era'+e,{VEC:'1',TECH_START_ERA:String(e)},9610+e)));
    console.log('  時代      朝の通勤  通勤ピーク  在宅勤務  屋外の人流  通販(累計)');
    ['アナログ','PC','スマホ','AI'].forEach((nm,e)=>{
      const wd=R[e].flow.filter((_,i)=>i<4);    // 最初の 4 日 (平日)
      const o=R[e].flow[R[e].flow.length-1]||{};
      console.log(`  ${nm.padEnd(6)}  ${f1(avg(wd,'commutePerCapita')).padStart(8)}  ${(+avg(wd,'commutePeakShare')||0).toFixed(2).padStart(9)}`
        + `  ${f1(avg(wd,'teleworkPerCapita')).padStart(8)}  ${f1(avg(wd,'outdoorsPerCapita')).padStart(10)}  ${String(o.orders||0).padStart(9)}`);
    });
    out.eras=R.map(r=>r.flow);
  }
  console.log('\n[VecReportJSON] '+JSON.stringify(out));
})();
