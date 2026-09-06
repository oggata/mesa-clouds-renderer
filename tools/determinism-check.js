#!/usr/bin/env node
'use strict';
// determinism-check.js — 同じ種から同じ世界が出てくるか。
//
//   node tools/determinism-check.js [--days=3] [--pop=120] [--grid=32] [--runs=2]
//
// **これが通らないと録画再生も分岐探索も成り立たない。** 一致しなければ、
// シミュレーションのどこかがまだ実時計か Math.random を見ている。
// 二度回して stateHash が一致するかだけを見る。

const {spawn} = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const DAYS=arg('days','3'), POP=arg('pop','120'), GRID=arg('grid','32'), RUNS=+arg('runs','2');
const SEED=arg('seed','12345');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-det-'));

function run(i, stateFile, seed, days){
  return new Promise((resolve,reject)=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:String(days||DAYS), SIM_FAST_REPORT_DAYS:'9999',
      NUM_AGENTS:POP, GRID, START_SIZE:String(Math.max(20, Math.round(GRID*0.8))),
      SIM_SEED:String(seed||SEED), CITY_SEED:SEED,
      // ★ 人口上限での街のリセットを止める。せっかく育てた蓄積 (道・店・人間関係)
      //   ごと作り直してしまうので、物語を探すあいだは邪魔にしかならない。
      POP_MAX:'0', NUM_AGENTS:POP,
      // START_VILLAGE=0 は「生成された街まるごと」から始める。村から育てると
      // 人口が数百に届くまでに何十日も掛かり、探索の出発点を作るだけで日が暮れる。
      START_VILLAGE:arg('village','1'),
      // ★ 毎回まっさらな街から始める。保存を読むと run ごとに出発点が変わる。
      CITY_STATE_FILE: stateFile || path.join(TMP, `run${i}.json`),
      PORT: String(9700+i),
    });
    const p=spawn(process.execPath, [path.join(__dirname,'..','server.js')], {env});
    let out='';
    p.stdout.on('data',d=>{ out+=d; });
    p.stderr.on('data',d=>{ out+=d; });
    p.on('close',()=>{
      const m=/\[FastJSON\] (\{.*\})/.exec(out);
      const st=/\[StoryJSON\] (\{.*\})/.exec(out);
      const ini=/\[InitJSON\] (\{.*\})/.exec(out);
      const days=[...out.matchAll(/\[DayHash\] (.+)/g)].map(x=>x[1].trim());
      const parts=[...out.matchAll(/\[DayParts\] (\d+) (\{.*\})/g)]
        .map(x=>({day:+x[1], p:JSON.parse(x[2])}));
      if(!m) return resolve({ok:false, tail:out.slice(-1500)});
      resolve({ok:true, fast:JSON.parse(m[1]), story:st?JSON.parse(st[1]):null,
               init:ini?JSON.parse(ini[1]):null, days, parts});
    });
  });
}

// 保存して再開しても同じか。**分岐探索はこの往復に全部乗っている**ので、
// 素の連続実行が一致するだけでは足りない。スナップショットが取りこぼしている
// 状態があると、再開の1周目は合っても2周目でずれる (実際にそうなった)。
async function resumeCheck(){
  const base=path.join(TMP,'base.json');
  console.log(`まず ${DAYS}日 まわして保存 …`);
  const w=await run(0, base, SEED, DAYS);
  if(!w.ok){ console.error('失敗:\n'+w.tail); process.exit(2); }
  console.log(`  → hash=${w.fast.hash}`);
  const hs=[], inits=[], runs=[];
  for(let i=0;i<2;i++){
    const f=path.join(TMP,`resume${i}.json`);
    fs.copyFileSync(base, f);
    process.stdout.write(`  そこから ${DAYS}日 再開 (${i+1}回目) …`);
    const r=await run(10+i, f, SEED+900, DAYS);
    runs.push(r.ok?r:null);
    hs.push(r.ok?r.fast.hash:'(失敗)');
    inits.push(r.ok&&r.init?r.init.hash:'(失敗)');
    console.log(` 復元直後=${inits[i]} → ${DAYS}日後=${hs[i]}`);
  }
  // 何日目から食い違ったか
  if(runs[0] && runs[1]){
    const A=runs[0].days||[], B=runs[1].days||[];
    let first=-1;
    for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]){ first=i; break; }
    if(first<0) console.log('  1日ごとの指紋は最後まで一致');
    else{
      console.log(`\n  食い違いは ${first+1} 日目から:`);
      const PA=(runs[0].parts||[])[first], PB=(runs[1].parts||[])[first];
      if(PA && PB){
        const bad=Object.keys(PA.p).filter(k=>PA.p[k]!==PB.p[k]);
        console.log(`    食い違った部位: ${bad.length?bad.join(', '):'(なし)'}`);
        console.log(`    一致した部位  : ${Object.keys(PA.p).filter(k=>PA.p[k]===PB.p[k]).join(', ')}`);
      }
      for(let i=Math.max(0,first-1); i<=Math.min(A.length-1, first+1); i++){
        console.log(`    ${i===first?'★':' '} A: ${A[i]||'-'}`);
        console.log(`    ${i===first?'★':' '} B: ${B[i]||'-'}`);
      }
    }
  }
  if(inits[0]!==inits[1])
    console.log('\n  ★ 復元した直後から違う → 読み込みの側 (initCity/initAgents) が非決定的');
  else if(hs[0]!==hs[1])
    console.log('\n  ★ 出発点は同じで、回すと違ってくる → tick の中に実時計か素の乱数が残っている');
  const same=hs[0]===hs[1];
  console.log(same ? '\n✔ 保存して再開しても一致 — 分岐探索が成り立ちます。'
    : '\n✘ 再開すると結果が変わります。スナップショットが状態を取りこぼしています。');
  fs.rmSync(TMP,{recursive:true,force:true});
  process.exit(same?0:1);
}

(async()=>{
  if(arg('resume',null)) return resumeCheck();
  console.log(`種=${SEED} 人口=${POP} GRID=${GRID} ${DAYS}日 を ${RUNS} 回まわして突き合わせます`);
  const rs=[];
  for(let i=0;i<RUNS;i++){
    process.stdout.write(`  run${i+1} …`);
    const r=await run(i);
    rs.push(r);
    console.log(` hash=${r.fast.hash} econ=${r.fast.econ} pop=${r.fast.pop} `
      + `事件=${r.story?r.story.incidents:'-'} ${r.fast.secs}秒`);
  }
  const h=rs.map(r=>r.fast.hash);
  const same=h.every(x=>x===h[0]);
  console.log('');
  if(same){
    console.log(`✔ 一致 (${h[0]})  — 同じ種から同じ世界が出ています。`);
    console.log('  「面白かった時間帯」は 種 + 日付の範囲 だけ控えれば再生できます。');
  }else{
    console.log('✘ 不一致: ' + h.join(' / '));
    console.log('  シミュレーションのどこかがまだ実時計 (Date.now) か Math.random を見ています。');
    console.log('  探し方: 毎tick回る経路 (stepAll / stepOneSecond / cityTick) から');
    console.log('          呼ばれている関数だけを見る。描画・HTTP・チャットは無関係です。');
    // 何がずれたかの当たりを付ける
    const keys=['pop','shops','econ','opened','closed','unmet'];
    for(const k of keys){
      const v=rs.map(r=>r.fast[k]);
      if(!v.every(x=>x===v[0])) console.log(`    ${k}: ${v.join(' / ')} ← ここから違う`);
    }
  }
  fs.rmSync(TMP,{recursive:true,force:true});
  process.exit(same?0:1);
})().catch(e=>{ console.error(e.message); process.exit(2); });
