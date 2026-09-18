#!/usr/bin/env node
'use strict';
// tech-report.js — 時代と研究を早送りで回し、「配信が止まらないか」を確かめる。
//
//   node tools/tech-report.js [--days=80] [--scale=0.25] [--pop=200] [--seeds=2] [--scenario=all]
//
//   --scale … TECH_DAY_SCALE (研究の日数の目盛りをまとめて縮める。課題の中身は変わらない)
//
// ── 何を見るか ──
// 配信で困るのは「研究が止まって何も起きない時間」。止まりうる理由ごとに、
// わざとその状況を作って**打開策が発火して時代が進むか**を見る。
//
//   normal    … 既定の設定
//   no-find   … 住民が素材に一切気づかない (TECH_FIND_P=0)          → 行商人が届けるか
//   no-hands  … 誰も実験に出られない (TECH_MAX_ACTIVE=0)             → 期限で偶然の大発見になるか
//   no-board  … 掲示板を読まない (TECH_BOARD=0)                      → 遅くても進むか
//   policy    … 学習した方策で選ぶ (TECH_MODE=policy)
//
// ── 合格の条件 ──
//   ① 研究が開いた時代は、時代の安全の期限 (TECH_MAX_DAYS) の翌日までに必ず次の時代へ進む
//   ② 研究中に「前進 (発見・候補の減少・ひらめき)」が無い日が 3×行き詰まり判定日数 以上続かない
//   ③ server.js がエラーで落ちない

const {spawn} = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

const arg=(k,d)=>{const a=process.argv.find(v=>v.startsWith('--'+k+'='));return a?a.split('=')[1]:d;};
const DAYS=+arg('days','80'), SCALE=arg('scale','0.25'), POP=arg('pop','200'), SEEDS=+arg('seeds','2');
const ONLY=arg('scenario','all');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'mesa-tech-'));

const SCENARIOS = {
  'normal':   {},
  'no-find':  {TECH_FIND_P:'0'},
  'no-hands': {TECH_MAX_ACTIVE:'0'},
  'no-board': {TECH_BOARD:'0'},
  'policy':   {TECH_MODE:'policy'},
};

function run(name, extra, seed, port){
  return new Promise(resolve=>{
    const env=Object.assign({}, process.env, {
      SIM_FAST:'1', SIM_FAST_DAYS:String(DAYS), SIM_FAST_REPORT_DAYS:'9999',
      NUM_AGENTS:POP, GRID:'32', START_SIZE:'25', SIM_SEED:String(seed), CITY_SEED:String(seed),
      POP_MAX:'0', START_VILLAGE:'1', TECH_DAY_SCALE:String(SCALE), NO_STREAM:'1',
      CITY_STATE_FILE:path.join(TMP, `${name}_${seed}.json`), PORT:String(port),
    }, extra);
    const p=spawn(process.execPath, [path.join(__dirname,'..','server.js')], {env});
    let out='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>out+=d);
    p.on('close',code=>{
      const days=[...out.matchAll(/\[TechJSON\] (\{.*\})/g)].map(m=>JSON.parse(m[1]));
      const errs=[...out.matchAll(/(TypeError|ReferenceError|RangeError)[^\n]*/g)].map(m=>m[0]);
      const news=[...out.matchAll(/\[News\] Day\d+ ([^\n]*)/g)].map(m=>m[1])
        .filter(t=>/[🔬✨🔎🧳🧪💡📦🎉🌀📚🏗🔧🤝💬💻📱🤖]/u.test(t));
      const start=/\[Tech\] on [^\n]*/.exec(out);
      const records=[...out.matchAll(/\[Tech\] 記録 (\S+): 研究 (\d+)日 \/ 試した組み合わせ (\d+)/g)]
        .map(m=>({era:m[1], days:+m[2], tried:+m[3]}));
      resolve({code, days, errs, news, records, start:start?start[0]:null});
    });
  });
}

function judge(r){
  const fails=[];
  if(!r.days.length) fails.push('TechJSON が 1 行も出ていない');
  if(r.errs.length) fails.push(`エラー: ${r.errs[0]}`);
  const stallDays = +((/行き詰まり判定 (\d+)日/.exec(r.start||'')||[])[1]||1);
  const maxDays = +((/時代の期限 (\d+)日/.exec(r.start||'')||[])[1]||150);
  // 時代ごとの区間に分ける
  const segs=[];
  for(const d of r.days){
    const last=segs[segs.length-1];
    if(!last || last.era!==d.era || last.cycle!==d.cycle) segs.push({era:d.era, cycle:d.cycle, eraDay:d.eraDay, rows:[]});
    segs[segs.length-1].rows.push(d);
  }
  const lines=[];
  for(let i=0;i<segs.length;i++){
    const s=segs[i], done=i<segs.length-1;
    const open=s.rows.find(x=>x.open), solved=s.rows.find(x=>x.solved!=null);
    const lastRow=s.rows[s.rows.length-1];
    const len=(done ? segs[i+1].eraDay : lastRow.day+1) - s.eraDay;
    // ① 期限
    if(open && len > maxDays+1) fails.push(`時代${s.era}(第${s.cycle}周) が ${len}日 続いた (期限 ${maxDays}日)`);
    // ② 前進の無い日の連続
    let idle=0, maxIdle=0, prev=null;
    for(const x of s.rows){
      if(!x.open || x.solved!=null){ prev=x; idle=0; continue; }
      const moved = prev && prev.open && (x.found>prev.found || x.step>prev.step || (x.step===prev.step && x.left!=null && prev.left!=null && x.left<prev.left) || x.hints>prev.hints);
      idle = moved || !prev || !prev.open ? 0 : idle+1;
      maxIdle=Math.max(maxIdle, idle);
      prev=x;
    }
    if(maxIdle >= stallDays*3) fails.push(`時代${s.era}: 前進の無い日が ${maxIdle}日 続いた`);
    lines.push(`    時代${s.era} 第${s.cycle}周  ${s.eraDay+1}日目〜 ${len}日`
      + (open ? `  研究 ${open.day+1}日目〜` : '  研究なし')
      + (solved ? `  発明 ${solved.solved+1}日目${lastRow.forced||(done&&segs[i+1].rows[0].stats.forced>lastRow.stats.forced)?' (偶然の大発見)':''}` : '')
      + `  段 ${(lastRow.step||0)+(solved?1:0)}/3  最大の停滞${maxIdle}日`);
  }
  return {fails, lines, segs};
}

(async()=>{
  const names = ONLY==='all' ? Object.keys(SCENARIOS) : ONLY.split(',');
  console.log(`時代と研究の早送り  ${DAYS}日 / 日数の目盛り×${SCALE} / 人口上限${POP} / 種${SEEDS}`);
  let bad=0;
  const summary={};
  for(const name of names){
    const jobs=[];
    for(let i=0;i<SEEDS;i++) jobs.push(run(name, SCENARIOS[name], 12345+i*777, 9870+i+names.indexOf(name)*10));
    const res=await Promise.all(jobs);
    console.log(`\n■ ${name} ${JSON.stringify(SCENARIOS[name])}`);
    summary[name]=[];
    res.forEach((r,i)=>{
      const j=judge(r);
      const last=r.days[r.days.length-1]||{};
      const eras=j.segs.length-1;
      console.log(`  seed=${12345+i*777}  ${j.fails.length?'✗':'✔'}  時代の交代 ${eras}回  統計 ${JSON.stringify(last.stats||{})}`);
      for(const l of j.lines) console.log(l);
      if(r.records.length) console.log('    記録 (課題は同じ): ' + r.records.map(x=>`${x.era} ${x.days}日/${x.tried}通り`).join('  '));
      for(const f of j.fails) console.log(`    ✗ ${f}`);
      if(i===0) for(const n of r.news.slice(0,14)) console.log(`      | ${n}`);
      if(j.fails.length) bad++;
      summary[name].push({seed:12345+i*777, ok:!j.fails.length, eraChanges:eras, stats:last.stats, records:r.records, fails:j.fails});
    });
  }
  console.log('\n[TechReportJSON] '+JSON.stringify(summary));
  console.log(bad ? `\n❌ ${bad} 本で打開策が間に合わなかった` : '\n✅ すべての筋書きで、研究は止まらずに時代が進んだ');
  process.exit(bad?1:0);
})();
