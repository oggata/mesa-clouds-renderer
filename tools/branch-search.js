#!/usr/bin/env node
'use strict';
// branch-search.js — 同じ瞬間から未来を何本も引いて、いちばん良かった一本を選ぶ。
//
//   node tools/branch-search.js [--branches=24] [--days=3] [--rounds=4]
//                               [--warmup=20] [--pop=250] [--grid=36] [--jobs=8]
//                               [--from=state.json] [--out=chosen.json]
//
// ── これは「後付け」ではない ──
// どの枝も、本物の状態から本物の規則で**前向きに**回した結果でしかない。
// 犯人も動機もアリバイも、枝の中で自然に起きたことだけ。ここでやっているのは
// 事実を作ることではなく、**どの本物を見せるかを選ぶこと**。1000時間撮って
// 1時間を放送する自然番組と同じ立場で、事実は一つも動いていない。
//
// ── 録画は要らない ──
// 決定的なので、選んだ未来は「スナップショット + 種」だけで完全に再現できる。
// 保存するのは1行。再生は同じ種で回し直すこと、そのもの。
//   → tools/determinism-check.js で一致を確認してから使うこと。
//
// ── 直線に回すのではなく枝を張る理由 ──
// 1000年を直線で回すと、良い事件は単発でしか拾えない。良くなりかけた状態から
// 枝を張れば、**物語を育てられる**。恨みが溜まりかけた地点から50本引いて、
// 事件に発展した枝だけ残す。それを繰り返す (ビームサーチ)。

const {spawn} = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const BRANCHES=+arg('branches','24'), DAYS=+arg('days','3'), ROUNDS=+arg('rounds','4');
const WARMUP=+arg('warmup','20'), POP=arg('pop','250'), GRID=arg('grid','36');
const JOBS=Math.max(1, +arg('jobs', String(Math.max(1, Math.min(8, os.cpus().length-1)))));
const SEED0=+arg('seed','1000');
const FROM=arg('from',null), OUT=arg('out','story-frontier.json');
const REPLAY=arg('replay',null);          // 選んだ歴史をもう一度再生して突き合わせる
const SERVER=path.join(__dirname,'..','server.js');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-branch-'));
const w=(s,n)=>String(s)+' '.repeat(Math.max(0,n-[...String(s)].reduce((a,c)=>a+(c.charCodeAt(0)>0xff?2:1),0)));

let port=9800;
function runSim(stateFile, seed, days, extra){
  return new Promise((resolve)=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:String(days), SIM_FAST_REPORT_DAYS:'9999',
      NUM_AGENTS:POP, GRID, START_SIZE:String(Math.max(20, Math.round(+GRID*0.85))),
      SIM_SEED:String(seed), CITY_SEED:arg('cityseed','42'),
      // ★ 人口上限での街のリセットを止める。せっかく育てた蓄積 (道・店・人間関係)
      //   ごと作り直してしまうので、物語を探すあいだは邪魔にしかならない。
      POP_MAX:'0', NUM_AGENTS:POP,
      // START_VILLAGE=0 は「生成された街まるごと」から始める。村から育てると
      // 人口が数百に届くまでに何十日も掛かり、探索の出発点を作るだけで日が暮れる。
      START_VILLAGE:arg('village','1'),
      CITY_STATE_FILE:stateFile, PORT:String(port++),
    }, extra||{});
    const p=spawn(process.execPath, [SERVER], {env});
    let out='';
    p.stdout.on('data',d=>{out+=d;}); p.stderr.on('data',d=>{out+=d;});
    p.on('close',()=>{
      const st=/\[StoryJSON\] (\{.*\})/.exec(out);
      const fa=/\[FastJSON\] (\{.*\})/.exec(out);
      resolve({ story: st?JSON.parse(st[1]):null, fast: fa?JSON.parse(fa[1]):null,
                ok: !!st, tail: out.slice(-800) });
    });
  });
}

// 同時に走らせる本数を JOBS に抑える
async function pool(items, fn){
  const out=new Array(items.length);
  let i=0;
  await Promise.all(Array.from({length:Math.min(JOBS, items.length)}, async ()=>{
    while(i<items.length){ const k=i++; out[k]=await fn(items[k], k); }
  }));
  return out;
}

// ── 再生 ────────────────────────────────────────────────────────────────────
// 「録画」は種の並びでしかない。出発点に戻して同じ順に種を入れ直すだけで、
// 同じ未来がもう一度そのまま出てくる。**ここで hash が一致すれば、
// 保存していたのが数行だったにもかかわらず完全に再現できている**という証明になる。
async function replay(file){
  const h=JSON.parse(fs.readFileSync(file,'utf8'));
  const start=file.replace(/\.history\.json$/,'')+'.start.json';
  if(!fs.existsSync(start)){ console.error(`出発点が見つかりません: ${start}`); process.exit(1); }
  console.log(`選んだ歴史を再生します: ${h.chosen.length}周 / 出発点 ${path.basename(start)}`);
  const f=path.join(TMP,'replay.json');
  fs.copyFileSync(start, f);
  let ok=true;
  for(const c of h.chosen){
    const r=await runSim(f, c.seed, c.days);
    const got=r.story?r.story.hash:'(失敗)';
    const same=got===c.hash;
    if(!same) ok=false;
    console.log(`  第${c.round}周 種=${c.seed} ${c.days}日 → ${got} `
      + (same ? '✔ 一致' : `✘ 記録は ${c.hash}`));
  }
  console.log('');
  console.log(ok ? '✔ 全周一致 — 種の並びだけで、同じ歴史がそのまま再生できました。'
                 : '✘ 不一致 — シミュレーションのどこかが決定的でありません。');
  fs.rmSync(TMP,{recursive:true,force:true});
  process.exit(ok?0:1);
}

(async()=>{
  if(REPLAY) return replay(REPLAY);
  // ── 出発点 ──────────────────────────────────────────────────────────────
  let frontier=path.join(TMP,'frontier.json');
  if(FROM){
    fs.copyFileSync(FROM, frontier);
    console.log(`出発点: ${FROM}`);
  }else{
    console.log(`出発点を作ります: 人口${POP} GRID=${GRID} を ${WARMUP}日 まわす …`);
    const r=await runSim(frontier, SEED0, WARMUP);
    if(!r.ok){ console.error('出発点の生成に失敗:\n'+r.tail); process.exit(1); }
    console.log(`  → Day${r.story.days} 人口${r.story.pop} 事件${r.story.incidents}件 hash=${r.story.hash}`);
  }

  // 出発点を控えておく。これと下の種の並びだけで、選んだ未来は完全に再生できる。
  const startCopy=OUT.replace(/\.json$/,'')+'.start.json';
  fs.copyFileSync(frontier, startCopy);

  const chosen=[];   // 選んだ枝の履歴。**これが「録画」の全部**
  for(let round=1; round<=ROUNDS; round++){
    const seeds=Array.from({length:BRANCHES},(_,i)=>SEED0 + round*10007 + i);
    console.log(`\n═══ 第${round}周 — ${BRANCHES}本の未来を ${DAYS}日ぶん引きます (同時${JOBS}本) ═══`);
    const t0=Date.now();
    const results=await pool(seeds, async (seed, k)=>{
      const f=path.join(TMP,`r${round}_b${k}.json`);
      fs.copyFileSync(frontier, f);        // ★ 全部おなじ地点から始める
      const r=await runSim(f, seed, DAYS);
      return {seed, file:f, ...r};
    });
    const good=results.filter(r=>r.ok);
    if(!good.length){ console.error('全部の枝が失敗:\n'+(results[0]&&results[0].tail)); process.exit(1); }

    good.sort((a,b)=>((b.story.best?b.story.best.score:0)-(a.story.best?a.story.best.score:0)));
    const secs=((Date.now()-t0)/1000).toFixed(0);
    console.log(`  ${good.length}本 完走 (${secs}秒)  点数の上位:`);
    for(const r of good.slice(0,5)){
      const b=r.story.best;
      console.log(`    種${w(r.seed,8)}${w(b?b.score:0,7)}${w(b?b.verdict:'-',14)}`
        + `新規事件${w(r.story.incidents,4)} 遺恨${w(r.story.feuds,4)}`
        + (b?` 手数${b.chain} 容疑者${b.suspects}人 赤鰊${b.redHerrings}`:''));
    }
    const win=good[0];
    const scores=good.map(r=>r.story.best?r.story.best.score:0);
    const avg=scores.reduce((a,b)=>a+b,0)/scores.length;
    const withInc=good.filter(r=>r.story.incidents>0).length;
    console.log(`  この3日で事件が起きた枝 ${withInc}/${good.length}`
      + `   平均 ${avg.toFixed(3)} → 採用 ${win.story.best?win.story.best.score:0}`
      + `  (探索の取り分 +${((win.story.best?win.story.best.score:0)-avg).toFixed(3)})`);

    chosen.push({round, seed:win.seed, days:DAYS, hash:win.story.hash,
                 score:win.story.best?win.story.best.score:0,
                 best:win.story.best, verdicts:win.story.verdicts});
    fs.copyFileSync(win.file, frontier);   // 勝った枝の終わりが次の出発点
  }

  fs.copyFileSync(frontier, OUT);
  // 選んだ枝でいちばん良かった話を、そのまま読める形で出す
  const top=chosen.reduce((b,c)=>(!b||c.score>b.score)?c:b, null);
  if(top && top.best && top.best.trace){
    console.log(`\n═══ この探索でいちばん良かった事件 (第${top.round}周 / ${top.best.score}点) ═══`);
    for(const l of top.best.trace) console.log('  '+l);
    const w=top.best.who||{};
    console.log(`  素朴な推理: ${w.naive}`);
    if(w.herrings && w.herrings.length) console.log(`  動機はあるが違う: ${w.herrings.join(' / ')}`);
    console.log(`  消去法の答え: ${w.answer}   真相: ${w.culprit}`);
    console.log(`  内訳: ${Object.entries(top.best.parts||{}).map(([k,v])=>k+'='+v).join(' ')}`);
  }
  console.log(`\n═══ 選ばれた歴史 ═══`);
  console.log('  この ' + chosen.length + ' 行が「録画」の全部です。');
  console.log('  同じ出発点と種で回し直せば、一字一句おなじ未来が再生されます。');
  for(const c of chosen)
    console.log(`    第${c.round}周 種=${c.seed} ${c.days}日 → ${c.score} `
      + `${c.best?c.best.verdict:'-'} (${c.hash})`);
  const meta=OUT.replace(/\.json$/,'')+'.history.json';
  fs.writeFileSync(meta, JSON.stringify({start:FROM||`warmup ${WARMUP}日 種${SEED0}`,
    pop:POP, grid:GRID, branches:BRANCHES, daysPerRound:DAYS, chosen}, null, 1));
  console.log(`\n  最終状態 → ${OUT}`);
  console.log(`  選んだ枝の履歴 → ${meta}   (出発点 → ${startCopy})`);
  console.log(`  再生して確かめる: node tools/branch-search.js --replay=${meta} --pop=${POP} --grid=${GRID}`);
  console.log(`  続きを探す: node tools/branch-search.js --from=${OUT} --pop=${POP} --grid=${GRID}`);
  fs.rmSync(TMP,{recursive:true,force:true});
})();
