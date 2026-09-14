#!/usr/bin/env node
'use strict';
// hlp-ab.js — HLP=0 (従来の if-else 梯子) と HLP=1 (Option レジストリ) を
//             **同じ種で走らせて、街の指紋が一致するか**を見る。
//
//   node tools/hlp-ab.js [--days=3] [--pop=120] [--grid=32] [--seeds=3] [--live]
//
// ── なぜ tools/hlp-equiv.js だけでは足りないか ──
// hlp-equiv は needOf/pickLifeGoal を**関数として**総当たりするので、
// 「同じ入力に同じ答えを返す」ことしか確かめられない。実際の街では
//   ・どのタイミングで行き先を引き直すか (retargetOnNeedChange の見張り)
//   ・乱数を引く順序
// もずれる。実際、見張りに a.opt.id を使った最初の実装は hlp-equiv を通ったのに
// 実サーバの hash が食い違った (別経路の enterWander が見張りごと更新してしまい、
// 引き直しが1回抜けていた)。**関数の等価と系の等価は別物。**
//
// --live を付けると HLP_LIVE=1 (性格 + 追加Option + 割り込み) 側と比べる。
// これは**一致しないのが正しい**。どれだけ変わったかを見るために使う。

const {spawn} = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const DAYS=arg('days','3'), POP=arg('pop','120'), GRID=arg('grid','32');
const SEEDS=+arg('seeds','3'), LIVE=process.argv.includes('--live');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-hlpab-'));

function run(tag, extraEnv, seed, port){
  return new Promise(resolve=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:String(DAYS), SIM_FAST_REPORT_DAYS:'9999',
      NUM_AGENTS:POP, GRID, START_SIZE:String(Math.max(20, Math.round(+GRID*0.8))),
      SIM_SEED:String(seed), CITY_SEED:String(seed),
      POP_MAX:'0', START_VILLAGE:'1',
      CITY_STATE_FILE: path.join(TMP, `${tag}_${seed}.json`),
      PORT: String(port),
    }, extraEnv);
    const p=spawn(process.execPath, [path.join(__dirname,'..','server.js')], {env});
    let out='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
    p.on('close',()=>{
      const m=/\[FastJSON\] (\{.*\})/.exec(out);
      const days=[...out.matchAll(/\[DayHash\] (.+)/g)].map(x=>x[1].trim());
      resolve(m ? {ok:true, j:JSON.parse(m[1]), days} : {ok:false, tail:out.slice(-1200)});
    });
  });
}

(async()=>{
  const B = LIVE ? {HLP:'1', HLP_LIVE:'1'} : {HLP:'1'};
  console.log(`HLP A/B  days=${DAYS} pop=${POP} grid=${GRID} seeds=${SEEDS}`);
  console.log(`  A = HLP=0 (従来の梯子)`);
  console.log(`  B = ${LIVE ? 'HLP_LIVE=1 (性格+追加Option+割り込み)  ★一致しないのが正しい' : 'HLP=1 (Option レジストリ・既定)'}`);
  console.log('');
  let same=0, diff=0;
  for(let i=0;i<SEEDS;i++){
    const seed=12345+i*777;
    const [a,b]=await Promise.all([
      run('a', {HLP:'0'}, seed, 9810+i*2),
      run('b', B,         seed, 9811+i*2),
    ]);
    if(!a.ok||!b.ok){ console.log(`  seed=${seed}  ✗ 起動に失敗\n${(a.tail||b.tail||'').slice(-600)}`); diff++; continue; }
    const ok = a.j.hash===b.j.hash;
    // どこから食い違ったか (1日ごとの指紋)
    let firstDiff=-1;
    for(let d=0; d<Math.max(a.days.length,b.days.length); d++) if(a.days[d]!==b.days[d]){ firstDiff=d; break; }
    console.log(`  seed=${seed}  A=${a.j.hash} B=${b.j.hash}  ${ok?'✔ 一致':'✗ 相違'}`
      + (ok?'':`  (${firstDiff<0?'日次指紋は一致':`${firstDiff+1}日目から`})`)
      + `   人口 ${a.j.pop}/${b.j.pop}  店 ${a.j.shops}/${b.j.shops}  経済 ${a.j.econ}/${b.j.econ}  未充足 ${a.j.unmet}/${b.j.unmet}`);
    ok?same++:diff++;
  }
  console.log('');
  if(LIVE){ console.log(`一致 ${same} / 相違 ${diff}  — LIVE 側は変わってよい。上の人口・経済・未充足の差が「性格を入れた効き目」。`); process.exit(0); }
  if(diff===0){ console.log(`✅ ${same}/${SEEDS} 種すべてで街の指紋が一致。HLP=1 を既定にしてよい。`); process.exit(0); }
  console.log(`❌ ${diff}/${SEEDS} 種で食い違い。既定にしてはいけない。`); process.exit(1);
})();
