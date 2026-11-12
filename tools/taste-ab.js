#!/usr/bin/env node
'use strict';
// taste-ab.js — 見た目の好み (src/taste.js) が行き先を動かしているかを、同じ種で比べる。
//
//   node tools/taste-ab.js [--days=3] [--pop=120] [--seeds=4242,7,99] [--w=0,0.05,0.15]
//
// 種は**順番に**回す (1つの種の中で w だけ並列)。全部を同時に立てると CPU を奪い合って配信が詰まる。
//
// ── 見るもの ──
//   meanZ … 来店した店の種類が、その人の好み (z 値) でどれだけ上だったか。
//           w=0 は「好みは育つが選択には効かせない」= 基準。w を上げてここが上がれば効いている。
//   来店 / 開業 / 閉店 / 飢え … 好みを足したせいで暮らしや経済が壊れていないか。
//
// ★ server.js は native の headless-gl を使うので、ビルドした Node で回すこと
//   (子プロセスは自分と同じ Node で起動する)。

const {spawn} = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const DAYS=arg('days','3'), POP=arg('pop','120'), SEEDS=arg('seeds',arg('seed','4242')).split(',');
const WS=arg('w','0,0.05,0.15').split(',');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-taste-'));

function run(w, seed, port){
  return new Promise(resolve=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:DAYS, SIM_FAST_REPORT_DAYS:'9999', NO_STREAM:'1',
      NUM_AGENTS:POP, GRID:'32', START_VILLAGE:'0', POP_MAX:'0', SIM_SEED:seed, CITY_SEED:seed,
      CITY_STATE_FILE:path.join(TMP, 's'+seed+'w'+w+'.json'), PORT:String(port), TASTE_W:w,
    });
    const p=spawn(process.execPath, [path.join(__dirname,'..','server.js')], {env});
    let out='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
    p.on('close',()=>{
      const pick=re=>[...out.matchAll(re)].map(m=>JSON.parse(m[1]));
      resolve({w, seed, taste:pick(/\[TasteJSON\] (\{.*\})/g), life:pick(/\[LifeJSON\] (\{.*\})/g),
        errs:(out.match(/(TypeError|ReferenceError|ERR_DLOPEN_FAILED)[^\n]*/g)||[])});
    });
  });
}
const sum=(rows,k)=>rows.reduce((s,r)=>s+(r[k]||0),0);
const avg=(rows,k)=>rows.length ? sum(rows,k)/rows.length : null;

// 1行ぶん: 来店の合計で重みを付けた meanZ (日によって来店数が違うので単純平均にしない)
function row(label, rs){
  const T=rs.flatMap(r=>r.taste), n=sum(T,'visits'), z=T.reduce((s,t)=>s+(t.meanZ||0)*t.visits,0)/(n||1);
  const last=rs.map(r=>r.life[r.life.length-1]||{});
  const starving=rs.reduce((s,r)=>s+(avg(r.life,'starving')||0),0)/rs.length;
  const err=rs.flatMap(r=>r.errs)[0];
  return `  ${label.padEnd(14)} ${String(n).padStart(6)}  ${z.toFixed(3).padStart(6)}  ${starving.toFixed(1).padStart(5)}  `
    + `${String(sum(last,'opened')).padStart(4)}  ${String(sum(last,'closed')).padStart(4)}` + (err?`  エラー: ${err}`:'');
}

(async()=>{
  console.log(`[TasteAB] ${DAYS}日 × ${POP}人 seeds=${SEEDS.join(',')} w=${WS.join(' / ')}`);
  const all=[];
  for(const seed of SEEDS){
    const R=await Promise.all(WS.map((w,i)=>run(w, seed, 18700+i)));
    all.push(...R);
    console.log(`\n  seed=${seed}      来店   meanZ   飢え%  開業  閉店`);
    for(const r of R) console.log(row('w='+r.w, [r]));
  }
  if(SEEDS.length>1){
    console.log(`\n  合計 (${SEEDS.length}種)   来店   meanZ   飢え%  開業  閉店`);
    for(const w of WS) console.log(row('w='+w, all.filter(r=>r.w===w)));
  }
  fs.rmSync(TMP, {recursive:true, force:true});
})();
