#!/usr/bin/env node
'use strict';
// make-dummy-hlp.js — 学習を待たずに配備の配線を試すための、でたらめな hlp.onnx を作る。
//
//   node tools/make-dummy-hlp.js [--out=data] [--state=46] [--emb=64]
//
// ── なぜ要るか ──
// ハイポリシーの本体は Colab で数十分〜数時間かけて学習する。その間、server.js 側の
// 400 行 (メタ読み込み / 行動カタログ生成 / 観測の組み立て / 非同期スコア先読み /
// choose への差し込み) は**一度も動かさずに置かれる**ことになる。配線の間違いは
// 学習の失敗と見分けがつかないので、先に潰しておく。
//
// 出すのは `scores = (state · A) · optᵀ` だけの最小グラフ。**中身に意味は無い。**
// 確かめるのは「読める / 形が合う / 候補数が可変で通る / 街が動く」の4つだけ。
//
// ★ onnx も torch も要らないように、ONNX の protobuf を直に書いている。
//   触るのは ModelProto / GraphProto / NodeProto / TensorProto の数フィールドだけ。

const fs = require('fs'), path = require('path');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };

// ── protobuf の最小エンコーダ ──────────────────────────────────────────────
const varint = n => { const o = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return Buffer.from(o); };
const tag    = (f, wire) => varint((f << 3) | wire);
const lenf   = (f, buf) => Buffer.concat([tag(f, 2), varint(buf.length), buf]);      // length-delimited
const varf   = (f, n)   => Buffer.concat([tag(f, 0), varint(n)]);                    // varint
const strf   = (f, s)   => lenf(f, Buffer.from(s, 'utf8'));
const cat    = (...b)   => Buffer.concat(b.filter(Boolean));

// TensorProto { dims=1, data_type=2, name=8, raw_data=9 }
const tensor = (name, dims, floats) => {
  const raw = Buffer.alloc(floats.length * 4);
  floats.forEach((v, i) => raw.writeFloatLE(v, i * 4));
  return cat(...dims.map(d => varf(1, d)), varf(2, 1), strf(8, name), lenf(9, raw));
};
// TypeProto.Tensor { elem_type=1, shape=2 } / TensorShapeProto { dim=1 } / Dimension { dim_value=1, dim_param=2 }
const dim   = d => lenf(1, typeof d === 'string' ? strf(2, d) : varf(1, d));
// ValueInfoProto { name=1, type=2 }
const vinfo = (name, dims) => cat(
  strf(1, name),
  lenf(2, lenf(1, cat(varf(1, 1), lenf(2, cat(...dims.map(dim)))))));
// NodeProto { input=1, output=2, name=3, op_type=4, attribute=5 }
// ★ name は**グラフ内で一意**でなければ onnxruntime が読み込みを拒否する。
let _nodeSeq = 0;
const node = (op, ins, outs, attrs) => cat(
  ...ins.map(i => strf(1, i)), ...outs.map(o => strf(2, o)),
  strf(3, `${op}_${_nodeSeq++}`), strf(4, op), ...(attrs || []));
// AttributeProto { name=1, ints=8, type=20 }  (INTS=7)
const attrInts = (name, ints) => lenf(5, cat(strf(1, name), ...ints.map(i => varf(8, i)), varf(20, 7)));

const OUT   = arg('out', 'data');
// --era で「時代つき」(ノートブック セル E2) の形にする: 観測 +5 次元、時代の行動 3 つ
const ERA   = process.argv.includes('--era');
const SDIM  = +arg('state', 46) + (ERA ? 5 : 0);
const EDIM  = +arg('emb', 64);

// A: (SDIM, EDIM) の適当な行列。**種を固定する** (毎回同じダミーになるように)
let seed = 12345 >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const A = Array.from({ length: SDIM * EDIM }, rnd);

const graph = cat(
  lenf(1, node('Transpose', ['opt'], ['optT'], [attrInts('perm', [1, 0])])),
  lenf(1, node('MatMul',    ['state', 'A'], ['q'], null)),
  lenf(1, node('MatMul',    ['q', 'optT'], ['scores'], null)),
  strf(2, 'dummy_hlp'),
  lenf(5, tensor('A', [SDIM, EDIM], A)),
  lenf(11, vinfo('state', ['batch', SDIM])),
  lenf(11, vinfo('opt',   ['n_opt', EDIM])),
  lenf(12, vinfo('scores', ['batch', 'n_opt'])),
);
const model = cat(
  varf(1, 8),                                  // ir_version
  strf(2, 'make-dummy-hlp'),
  lenf(7, graph),
  lenf(8, cat(strf(1, ''), varf(2, 17))),      // opset ai.onnx v17
);

fs.mkdirSync(OUT, { recursive: true });
const op = path.join(OUT, 'hlp.onnx');
// ★ **学習済みモデルを踏まない。** dummy でない hlp_meta.json が既にあるなら止まる。
//   (data/ が既定の出力先なので、うっかり上書きすると数時間の学習が消える)
const mp0 = path.join(OUT, 'hlp_meta.json');
if (fs.existsSync(mp0) && !process.argv.includes('--force')) {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(mp0, 'utf8')); } catch {}
  if (!existing || !existing.dummy) {
    console.error(`✗ ${mp0} に学習済みらしいメタがある。上書きしない。`);
    console.error('  本当に置き換えるなら --force、別の場所に出すなら --out=<dir>');
    process.exit(1);
  }
}
fs.writeFileSync(op, model);
console.log(`✓ ${op} (${model.length}B)  state=${SDIM} emb=${EDIM}`);

// ── メタも作る (本物と同じ形。行動カタログは server.js の options.js と同じ id) ──
const OPTS = [
 ['sleep','sleep','home',null,420,0],       ['rest','rest','fun',null,45,3],
 ['seek-care','sick','care',null,60,20],    ['work','work','work',null,300,-60],
 ['eat-ramen','eat','food','ramen',40,9],   ['eat-gyudon','eat','food','gyudon',25,5],
 ['eat-cafe','eat','food','cafe',50,8],     ['eat-bento','eat','food','bento',20,6],
 ['eat-kiosk','eat','food','kiosk',15,3],
 ['shop-conbini','shop','buy','conbini',20,10], ['shop-super','shop','buy','supermarket',45,18],
 ['shop-mall','shop','buy','mall',90,30],   ['shop-store','shop','buy','shop',30,12],
 ['fun-museum','bored','fun','museum',90,15], ['fun-stadium','bored','fun','stadium',120,25],
 ['fun-library','bored','fun','library',75,0], ['fun-temple','bored','fun','temple',45,2],
 ['idle',null,'-',null,25,0],               ['explore',null,'other',null,60,0],
 ['food-crawl',null,'food',null,35,7],      ['socialize',null,'fun',null,50,4],
 ['found-shop',null,'other',null,240,120],  ['pickpocket',null,'-',null,20,-40],
 ...(ERA ? [['errand','errand','work','post',30,2,[0,1]], ['order-online','order','home',null,10,12,[2,3]],
            ['telework','work','home',null,300,-60,[2,3]]] : []),
];
const emb = (i) => { let s2 = (i * 7919 + 13) >>> 0;
  const r = () => { s2 = (s2 * 1664525 + 1013904223) >>> 0; return s2 / 4294967296 - 0.5; };
  const v = Array.from({ length: EDIM }, r); const n = Math.hypot(...v);
  return v.map(x => x / n); };
const meta = {
  model_type: 'high_level_policy', version: 1, dummy: true,
  _warning: 'これは配線の確認用のでたらめなモデル。行動の選択に意味は無い。',
  state_dim: SDIM, emb_dim: EDIM, key_dim: EDIM,
  state_layout: [
    { name:'traits', dim:8 }, { name:'needs', dim:5 }, { name:'money', dim:1 },
    { name:'clock', dim:4 }, { name:'memory', dim:8 }, { name:'alone', dim:1 },
    { name:'has_percept', dim:1 }, { name:'near', dim:7 }, { name:'has', dim:7 },
    { name:'percept', dim:4 },
    ...(ERA ? [{ name:'era', dim:5, keys:['analog','pc','mobile','ai','errand_due'] }] : []),
  ],
  ...(ERA ? { era_dim: 5 } : {}),
  traits: ['curiosity','gourmet','sociability','diligence','thrift','enterprise','honesty','homebody'],
  categories: ['food','buy','fun','care','home','work','other'],
  options: OPTS.map(([id, need, cat_, ttype, dwell, cost, eras], i) => ({
    id, need, cat: cat_, ttype, dwell_min: dwell, cost, text: id.replace(/-/g, ' '), emb: emb(i),
    ...(eras ? { eras } : {}) })),
  train: { updates: 0, note: 'dummy' },
  validation: { persona_differentiation: ['dummy モデルなので未検証'],
                unknown_action: ['dummy モデルなので未検証'] },
};
fs.writeFileSync(path.join(OUT, 'hlp_meta.json'), JSON.stringify(meta, null, 2));
console.log(`✓ ${path.join(OUT, 'hlp_meta.json')}  行動 ${OPTS.length} 種`);

// 自分で読み返して形を確かめる (書けたが読めない、を防ぐ)
(async () => {
  let ort; try { ort = require('onnxruntime-node'); } catch { console.log('  (onnxruntime-node が無いので読み返しは省略)'); return; }
  const s = await ort.InferenceSession.create(op);
  const st = new ort.Tensor('float32', new Float32Array(SDIM), [1, SDIM]);
  const flat = new Float32Array(OPTS.length * EDIM);
  meta.options.forEach((o, i) => flat.set(o.emb, i * EDIM));
  const r1 = await s.run({ state: st, opt: new ort.Tensor('float32', flat, [OPTS.length, EDIM]) });
  const r2 = await s.run({ state: st, opt: new ort.Tensor('float32', flat.slice(0, 5 * EDIM), [5, EDIM]) });
  const o1 = r1[s.outputNames[0]], o2 = r2[s.outputNames[0]];
  console.log(`  読み返し: 入力 ${s.inputNames.join(',')} → 出力 ${o1.dims} / 候補5個でも ${o2.dims}`);
  if (o1.dims[1] !== OPTS.length || o2.dims[1] !== 5) { console.error('  ✗ 候補数が可変になっていない'); process.exit(1); }
  console.log('  ✓ 形は正しい');
})();
