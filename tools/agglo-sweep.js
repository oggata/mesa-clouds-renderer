#!/usr/bin/env node
'use strict';
// agglo-sweep.js — 集積の利益と混雑の罰の比を振って、店が寄り集まるかを調べる。
//
//   node tools/agglo-sweep.js [--days=80] [--rep=3] [--par=4] [--agents=60]
//
// **なぜ要るか。** 集積を入れたあと最初の計測では、店は寄り集まるどころか散った。
// つまみ (AGGLO_MAX / CROWD_MAX) の比が悪いのか、そもそも仕掛けが効かないのかは、
// 街を何十日も回さないと分からない。SIM_FAST でそれが数分で済むようになったので、
// 条件を振って総当たりする。
//
// ── 前回 (11run/15日) の失敗と、その直し ─────────────────────────────────
// 集積 0 (対照) と 0.3 / 0.5 / 0.7 が、店4軒・指数1.361 という**完全に同じ結果**を
// 出した。全 run を分解したら、近接している店のペアがどの run も**ちょうど1組**で
// 一定だった。指数が 1.361→0.544 と動いて見えたのは、分子(実際の近さ)ではなく
// 分母(店数)が変わっただけ。つまり何も測れていなかった。原因は3つ:
//
//   ① 保存済みの街をコピーして再開していた
//      → 建物24軒と道の配置を最初から引き継ぐので、立地ルールが働く余地がない。
//        測っていたのは「引き継いだ街のかたち」だった。
//        **直し: 種ファイルを渡さず、まっさらな村から立ち上げる。**
//   ② 15日では店の入れ替わりが 1〜2 軒しか起きない
//      → 立地ルールの差が形になる前に run が終わる。
//        **直し: 既定を 80日にし、開業数が少ない run は比較対象から外す。**
//   ③ 集積指数が店数に強く依存していた
//      → **直し: Clark-Evans の最近隣指数 (店数と面積で正規化される) で判定し、
//        近接ペア数と開業/閉店数を生のまま併記する。**
//
// 見るのは **CE = Clark-Evans 最近隣指数**。
//   < 1 … 寄り集まっている (集積)
//   ≈ 1 … 無作為配置と区別がつかない (仕掛けが効いていない)
//   > 1 … 散っている
// 同じ条件を rep 回、**別々の街の種で**回して平均する (同じ種だとほぼ同じ run になる)。

const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? parseFloat(a.split('=')[1]) : d; };
const DAYS = arg('days', 80), REP = arg('rep', 3), PAR = arg('par', 4), AGENTS = arg('agents', 60);
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agglo-'));

// ★ 判定に使えるかの門番。**同時に営業している店がこの数に届かない run は捨てる。**
//   CE (最近隣指数) は店が3〜4軒だとほぼ雑音で、配置の良し悪しを表さない。
//   前回はここが無かったので「店4軒の CE」を条件間で比べてしまった。
//   なお `opened` (累計の開業数) では駄目だった: あれは住宅や職場の完成も
//   数えるので、店が1軒も建っていない run でも 70 を超える。
const MIN_SHOPS = 6;

// 振る条件。AGGLO_MAX(集積の上限) と CROWD_MAX(混雑の罰の上限) の組。
//   aggloMax=0 は対照群 (集積の利益なし = 入れる前の状態)
const GRID = [
  { AGGLO_MAX: 0.00, CROWD_MAX: 0.90 },   // 対照群
  { AGGLO_MAX: 0.30, CROWD_MAX: 0.90 },   // いまの既定
  { AGGLO_MAX: 0.30, CROWD_MAX: 0.45 },
  { AGGLO_MAX: 0.50, CROWD_MAX: 0.90 },
  { AGGLO_MAX: 0.50, CROWD_MAX: 0.55 },
  { AGGLO_MAX: 0.70, CROWD_MAX: 0.55 },
  { AGGLO_MAX: 0.70, CROWD_MAX: 0.90 },
];

function runOne(cfg, rep) {
  return new Promise(resolve => {
    // ★ 種ファイルを**コピーしない**。存在しないパスを渡すと server は
    //   freshCity() → villageStart() でまっさらな村を作る。これで全ての店が
    //   「いま試しているルールのもとで」開業する。
    const state = path.join(TMP, `city_${cfg.AGGLO_MAX}_${cfg.CROWD_MAX}_${rep}.json`);
    const env = Object.assign({}, process.env, {
      SIM_FAST: '1', SIM_FAST_DAYS: String(DAYS), SIM_FAST_REPORT_DAYS: '9999',
      CITY_STATE_FILE: state,        // 存在しない = 新規生成。本番の街には触れない
      START_VILLAGE: '1',            // 村から始める (①の直し)
      CITY_EVOLVE: '1',              // 開業/閉店が起きないと何も測れない
      // ★ rep ごとに街の種を変える。同じ種だと rep0 と rep1 がほぼ同じ run になり、
      //   前回は「再現性がある」ではなく「同じものを2回見ている」だけだった。
      CITY_SEED: String(1000 + rep * 7 + 1),
      // ★ 人口の抑えかた。POP_MAX は「達したら街をリセット」なので 0 (無効) のまま。
      //   途中でリセットされたら蓄積した配置が消えて実験にならない。
      //   実際の上限は NUM_AGENTS (存在できる住民の上限) で掛ける。
      POP_MAX: '0', NUM_AGENTS: String(AGENTS),
      YT_STREAM_KEY: '', YT_CHAT: '0', CHAT_AI: '0',
      PORT: String(8100 + Math.floor(Math.random() * 800)),
      AGGLO_MAX: String(cfg.AGGLO_MAX), CROWD_MAX: String(cfg.CROWD_MAX),
    });
    const p = spawn('node', ['server.js'], { cwd: ROOT, env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => {
      const m = out.match(/\[FastJSON\] (\{.*\})/);
      if (!m) { console.error(`  ✘ ${JSON.stringify(cfg)} rep${rep}: 結果が取れませんでした`); return resolve(null); }
      const r = JSON.parse(m[1]); r.rep = rep;
      r.usable = r.shops >= MIN_SHOPS;
      console.log(`  ${String(cfg.AGGLO_MAX).padEnd(4)} / ${String(cfg.CROWD_MAX).padEnd(4)} rep${rep}`
        + `  店${String(r.shops).padStart(3)}  開業${String(r.opened).padStart(3)}/閉店${String(r.closed).padStart(3)}`
        + `  近接ペア${String(r.pairs).padStart(3)}  CE${String(r.ce == null ? '--' : r.ce.toFixed(3)).padStart(6)}`
        + `  人口${String(r.pop).padStart(4)}  ${r.secs}秒${r.usable ? '' : `  ← 店が${MIN_SHOPS}軒未満で比較不可`}`);
      resolve(r);
    });
  });
}

(async () => {
  const jobs = [];
  for (const cfg of GRID) for (let i = 0; i < REP; i++) jobs.push({ cfg, rep: i });
  console.log(`集積の掃引: ${GRID.length}条件 × ${REP}回 = ${jobs.length}run / 各${DAYS}日 / 並列${PAR} / 住民上限${AGENTS}`);
  console.log(`まっさらな村から開始 (保存済みの街は使わない) / 同時営業${MIN_SHOPS}軒未満の run は判定から除外\n`);
  console.log('  集積  混雑  —  結果');
  const results = [];
  for (let i = 0; i < jobs.length; i += PAR) {
    const batch = jobs.slice(i, i + PAR);
    const rs = await Promise.all(batch.map(j => runOne(j.cfg, j.rep)));
    rs.forEach(r => r && results.push(r));
  }

  const usable = results.filter(r => r.usable && r.ce != null);
  const dropped = results.length - usable.length;

  // 条件ごとに平均 (使える run だけ)
  const by = new Map();
  for (const r of usable) {
    const k = `${r.aggloMax}_${r.crowdMax}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const rows = [...by.entries()].map(([k, rs]) => {
    const avg = f => rs.reduce((a, b) => a + b[f], 0) / rs.length;
    const sd = f => { const m = avg(f); return Math.sqrt(rs.reduce((a, b) => a + (b[f] - m) ** 2, 0) / rs.length); };
    return { aggloMax: rs[0].aggloMax, crowdMax: rs[0].crowdMax, n: rs.length,
             ce: +avg('ce').toFixed(3), ceSd: +sd('ce').toFixed(3),
             pairs: +avg('pairs').toFixed(1), nn: +avg('nn').toFixed(2),
             shops: +avg('shops').toFixed(1), opened: +avg('opened').toFixed(1),
             pop: Math.round(avg('pop')), econ: Math.round(avg('econ')),
             unmet: Math.round(avg('unmet')) };
  }).sort((a, b) => a.ce - b.ce);        // CE は小さいほど集積している

  console.log(`\n使えた run: ${usable.length}/${results.length}${dropped ? ` (同時営業${MIN_SHOPS}軒未満を${dropped}件除外)` : ''}`);
  console.log('\n集積 / 混雑 / CE±sd (1.0=無作為, 小さいほど集積) / 近接ペア / 最近隣 / 店 / 開業 / 人口 / 経済 / 未充足');
  for (const r of rows)
    console.log(`  ${String(r.aggloMax).padEnd(5)} ${String(r.crowdMax).padEnd(5)} `
      + `${String(r.ce).padStart(6)}±${String(r.ceSd).padEnd(5)} ${String(r.pairs).padStart(5)} `
      + `${String(r.nn).padStart(6)} ${String(r.shops).padStart(5)} ${String(r.opened).padStart(5)} `
      + `${String(r.pop).padStart(5)} ${String(r.econ).padStart(6)} ${String(r.unmet).padStart(6)}`);

  const out = path.join(ROOT, 'docs', 'agglo-sweep.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ days: DAYS, rep: REP, agents: AGENTS, minShops: MIN_SHOPS,
                                         rows, raw: results }, null, 1));
  console.log(`\n結果を書き出しました: ${path.relative(ROOT, out)}`);

  // ── 判定。対照群と比べる。「一番良い条件」だけ見ると前回の轍を踏む ──
  const ctl = rows.find(r => r.aggloMax === 0);
  const best = rows[0];
  if (!rows.length) {
    const maxShops = results.reduce((m, r) => Math.max(m, r.shops), 0);
    console.log(`✘ 判定できる run がありませんでした (店が最大でも ${maxShops} 軒。${MIN_SHOPS} 軒必要)。`);
    console.log('  日数を増やしても直りません。街が同時に3〜4軒しか店を支えられないのが原因で、');
    console.log('  これは立地ルールではなく人口と経済の側の問題です。先にそちらを直す必要があります。');
  } else if (!ctl) {
    console.log('✘ 対照群 (集積0) の run が使えませんでした。判定できません。');
  } else if (best.aggloMax === 0) {
    console.log(`✘ 対照群 (CE ${ctl.ce}) が最も集積していました。集積の仕掛けは効いていません。`);
  } else {
    const gap = ctl.ce - best.ce;
    console.log(`対照群 CE ${ctl.ce}±${ctl.ceSd}  →  最良 集積${best.aggloMax}/混雑${best.crowdMax} CE ${best.ce}±${best.ceSd}`);
    console.log(gap > Math.max(0.05, ctl.ceSd + best.ceSd)
      ? `✔ 対照群より ${gap.toFixed(3)} 集積しました (ばらつきを超える差)。`
      : `✘ 差 ${gap.toFixed(3)} はばらつきの範囲内です。効果があるとは言えません。`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})();
