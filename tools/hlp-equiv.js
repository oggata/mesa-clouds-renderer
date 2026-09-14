#!/usr/bin/env node
'use strict';
// hlp-equiv.js — 新しい HLP が、既存の needOf() / pickLifeGoal() と
//                **完全に同じ答えを返すこと**を総当たりで確かめる。
//
//   node tools/hlp-equiv.js
//
// ── なぜ要るか ──
// 行動決定を if-else 梯子から Option レジストリへ移すのは、街の見た目を一切
// 変えずに済ませたい類の改造だ。「たぶん同じ」では困る。ここが通らない限り
// server.js の HLP=1 を既定にしてはいけない。
//
// 確かめるのは2つ:
//   ① 選択    needOf(a)            == hlp.choose(a).opt.need
//   ② 行き先  pickLifeGoal(a, ex)  == llp.resolve(a, targetSpec, ex)
//              (乱数の引き方まで含めて。ここがずれると determinism-check が落ちる)

const path = require('path');
const ROOT = path.join(__dirname, '..');
const OPT = require(path.join(ROOT, 'options.js'));
const HLP = require(path.join(ROOT, 'hlp.js'));
const LLP = require(path.join(ROOT, 'llp.js'));

// ── server.js から写した定数 (server.js:3801-3850, 7639-7641) ────────────────
const NEED_HI = 0.62, SLEEP_HI = 0.88, SICK_HI = 0.35;
const SCHOOL_FROM = 8, SCHOOL_TO = 15;
const WORK_FROM = 9, WORK_TO = 17;
const PREF_WEIGHT = 6, TEACH_BONUS = 1.2;
const IDX = { food: [0, 3, 4, 5, 6], home: [8, 11], care: [20, 2], buy: [1, 15, 7, 24], fun: [23, 16, 22, 19] };

// ── 参照実装: server.js:7643 needOf() の逐語コピー ──────────────────────────
function needOf_ref(a, env) {
  const h = env.hour;
  if ((a.sick || 0) > SICK_HI) return 'sick';
  const fa = a.fatigue || 0;
  if (h < 6 || h >= 22 || fa > SLEEP_HI) return 'sleep';
  if (fa > NEED_HI) return env.restOn ? 'rest' : 'sleep';
  if ((a.hunger || 0) > NEED_HI) return 'eat';
  if (env.student) return (!env.weekend && h >= SCHOOL_FROM && h < SCHOOL_TO) ? 'work' : nonWorkNeed_ref(a);
  if (h >= WORK_FROM && h < WORK_TO && !env.weekend) return 'work';
  if ((a.supply || 0) > NEED_HI) return 'shop';
  if ((a.bored || 0) > NEED_HI) return 'bored';
  return null;
}
function nonWorkNeed_ref(a) {
  if ((a.supply || 0) > NEED_HI) return 'shop';
  if ((a.bored || 0) > NEED_HI) return 'bored';
  return null;
}

// ── ctx の組み立て (server.js 側の buildHlpCtx と同じ形) ────────────────────
function ctxOf(env) {
  return {
    hour: env.hour, weekend: env.weekend, restOn: env.restOn, now: 0,
    thr: { needHi: NEED_HI, sleepHi: SLEEP_HI, sickHi: SICK_HI },
    school: { from: SCHOOL_FROM, to: SCHOOL_TO },
    work: { from: WORK_FROM, to: WORK_TO },
    IDX, prefWeight: PREF_WEIGHT, teachBonus: TEACH_BONUS,
    isStudent: () => env.student,
    isCourier: () => false, onDeliveryDuty: () => false,
    indoorsAt: () => false,
    personaOn: false, temp: 0,
    resolveMode: 'map', perceptMode: 'off',
  };
}

// ═══ ① 選択の一致 ═════════════════════════════════════════════════════════
function testChoice() {
  const LV = [0, NEED_HI - 1e-6, NEED_HI + 1e-6, SLEEP_HI + 1e-6, 1];
  const SK = [0, SICK_HI - 1e-6, SICK_HI + 1e-6, 1];
  let n = 0, bad = 0;
  const seen = {};
  for (let hour = 0; hour < 24; hour++)
    for (const weekend of [false, true])
      for (const student of [false, true])
        for (const restOn of [true, false])
          for (const sick of SK)
            for (const fatigue of LV)
              for (const hunger of LV)
                for (const supply of LV)
                  for (const bored of LV) {
                    const a = { sick, fatigue, hunger, supply, bored };
                    const env = { hour, weekend, student, restOn };
                    const C = ctxOf(env);
                    const want = needOf_ref(a, env);
                    const got = HLP.choose(a, C).opt.need;
                    n++;
                    seen[want === null ? 'null' : want] = (seen[want === null ? 'null' : want] || 0) + 1;
                    if (want !== got) {
                      if (bad < 5) console.log(`  ✗ h=${hour} we=${weekend} st=${student} rest=${restOn} `
                        + `sick=${sick} fa=${fatigue} hu=${hunger} su=${supply} bo=${bored}  want=${want} got=${got}`);
                      bad++;
                    }
                  }
  console.log(`① 選択      : ${n.toLocaleString()} 通り / 不一致 ${bad}`);
  console.log(`   内訳      : ${Object.entries(seen).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  return bad;
}

// ═══ ② 行き先の一致 ═══════════════════════════════════════════════════════
// mulberry32 を2本立て、同じ種から同じ順序で引けているかまで見る。
function mulberry(seed) {
  let s = seed | 0;
  return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function makeWorld(rndSeed) {
  // 25 種類の建物を格子状に置いた模擬の街。
  const BUILDINGS = [], TYPE = {};
  let k = 0;
  for (let r = 1; r < 20; r += 2) for (let c = 1; c < 20; c += 2) {
    const t = k % 25; BUILDINGS.push([r, c]); TYPE[r + '_' + c] = t; k++;
  }
  const structAt = (r, c) => TYPE[r + '_' + c] == null ? null
    : { r, c, state: (r + c) % 17 === 0 ? 'closed' : 'open', typeIdx: TYPE[r + '_' + c] };
  return {
    BUILDINGS, TYPE, structAt,
    buildingsOfTypes: idxs => BUILDINGS.filter(b => idxs.includes(TYPE[b[0] + '_' + b[1]])),
    structByKey: key => { const [r, c] = key.split('_').map(Number); return structAt(r, c); },
    prefKey: st => st ? st.r + '_' + st.c : null,
    prefOf: (a, key) => key ? ((key.charCodeAt(0) * 7 + key.length * 13) % 100) / 100 : 0,
    openLotCells: () => [[4, 4], [12, 12]],
    nearestHome: a => { const h = BUILDINGS.filter(b => IDX.home.includes(TYPE[b[0] + '_' + b[1]])); if (!h.length) return null; h.sort((p, q) => (p[0] - a.x) ** 2 + (p[1] - a.y) ** 2 - ((q[0] - a.x) ** 2 + (q[1] - a.y) ** 2)); return [...h[0]]; },
    randB: null,   // 後で差す (乱数を使うため)
    typeAt: (r, c) => TYPE[r + '_' + c] ?? null,
    losClear: () => true,
  };
}

// 参照実装: server.js:7731 pickLifeGoal() の逐語コピー
function pickLifeGoal_ref(a, ex, need, Wd, rnd) {
  const n = need;
  if (n === 'sleep') { if (a.home) return [...a.home]; const h = Wd.nearestHome(a); if (h) return h; }
  if (n === 'rest') {
    const spots = [].concat(Wd.buildingsOfTypes(IDX.food), Wd.buildingsOfTypes(IDX.fun), Wd.openLotCells());
    if (spots.length) { spots.sort((p, q) => (Math.hypot(p[0] - a.x, p[1] - a.y)) - (Math.hypot(q[0] - a.x, q[1] - a.y))); return spots[0]; }
    if (a.home) return [...a.home];
    const h2 = Wd.nearestHome(a); if (h2) return h2;
  }
  if (n === 'work' && a.school) return [...a.school];
  if (n === 'work' && a.work) return [...a.work];
  const CAT = { eat: IDX.food, sick: IDX.care, shop: IDX.buy, bored: IDX.fun }[n];
  if (CAT) {
    const f = Wd.buildingsOfTypes(CAT);
    if (f.length) {
      if (a.taught && !a.taught.tried) {
        const tSt = Wd.structByKey(a.taught.key);
        if (tSt && tSt.state === 'open' && CAT.includes(tSt.typeIdx)) return [tSt.r, tSt.c];
      }
      const w = n === 'sick' ? PREF_WEIGHT * 0.3 : PREF_WEIGHT;
      const scored = f.map(b => {
        const st = Wd.structAt(b[0], b[1]); const key = Wd.prefKey(st);
        let sc = -Math.hypot(b[0] - a.x, b[1] - a.y) + w * Wd.prefOf(a, key);
        if (a.taught && a.taught.key === key && !a.taught.tried) sc += w * TEACH_BONUS;
        return { b, sc };
      });
      scored.sort((p, q) => q.sc - p.sc);
      const k = n === 'sick' ? 2 : 3;
      return [...scored[Math.floor(rnd() * Math.min(k, scored.length))].b];
    }
  }
  return Wd.randB(ex, rnd);
}

function testGoal() {
  const Wd = makeWorld();
  Wd.randB = (ex, rnd) => { const b = Wd.BUILDINGS[Math.floor(rnd() * Wd.BUILDINGS.length)]; return [...b]; };
  let n = 0, bad = 0, drawsBad = 0;
  const HOMES = Wd.buildingsOfTypes(IDX.home);
  for (let it = 0; it < 20000; it++) {
    const r1 = mulberry(1234 + it), r2 = mulberry(1234 + it);
    let d1 = 0, d2 = 0;
    const rndA = () => { d1++; return r1(); };
    const rndB = () => { d2++; return r2(); };
    const seed = mulberry(999 + it);
    const a = {
      x: seed() * 20, y: seed() * 20,
      home: seed() < 0.8 && HOMES.length ? [...HOMES[Math.floor(seed() * HOMES.length)]] : null,
      work: seed() < 0.6 ? [...Wd.BUILDINGS[Math.floor(seed() * Wd.BUILDINGS.length)]] : null,
      school: seed() < 0.2 ? [...Wd.BUILDINGS[Math.floor(seed() * Wd.BUILDINGS.length)]] : null,
      taught: seed() < 0.3 ? { key: Wd.BUILDINGS[Math.floor(seed() * Wd.BUILDINGS.length)].join('_'), tried: seed() < 0.5 } : null,
    };
    const need = ['sleep', 'rest', 'work', 'eat', 'sick', 'shop', 'bored', null][it % 8];
    const optId = { sleep: 'sleep', rest: 'rest', work: 'work', eat: 'eat', sick: 'seek-care', shop: 'shop', bored: 'entertain', null: 'idle' }[need === null ? 'null' : need];
    const C = ctxOf({ hour: 12, weekend: false, student: false, restOn: true });

    LLP.attach(Object.assign({}, Wd, { randB: ex => Wd.randB(ex, rndB) }));
    LLP.setRng(rndB);
    const ex = [0, 0];
    const want = pickLifeGoal_ref(a, ex, need, Object.assign({}, Wd, { randB: (e, r) => Wd.randB(e, rndA) }), rndA);
    const got = LLP.resolve(a, OPT.byId[optId].target(a, C), ex, C);
    n++;
    if (!want || !got || want[0] !== got[0] || want[1] !== got[1]) {
      if (bad < 5) console.log(`  ✗ need=${need} want=${want} got=${got} home=${a.home} work=${a.work} school=${a.school}`);
      bad++;
    }
    if (d1 !== d2) { if (drawsBad < 5) console.log(`  ✗ 乱数の消費回数が違う need=${need} ref=${d1} new=${d2}`); drawsBad++; }
  }
  console.log(`② 行き先    : ${n.toLocaleString()} 通り / 不一致 ${bad} / 乱数消費のずれ ${drawsBad}`);
  return bad + drawsBad;
}

console.log('HLP 等価性の確認 (options.js / hlp.js / llp.js  vs  server.js の既存ロジック)');
console.log('');
const e1 = testChoice();
const e2 = testGoal();
console.log('');
if (e1 + e2 === 0) { console.log('✅ 完全に一致。HLP=1 を既定にしてよい。'); process.exit(0); }
console.log(`❌ 不一致あり (選択 ${e1} / 行き先 ${e2})。既定にしてはいけない。`); process.exit(1);
