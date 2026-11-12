// embed.mjs — 建物と住民を MobileCLIP-S0 の同じ空間に埋め込み、data/clip_emb.json に書く。
//
// **サーバーはこの JSON を読むだけ。** 推論は事前に1回、ここで済ませる。
// 建物の見た目は種類ごとに決まっていて (textures/v4/<name>.jpg) 時間で変わらないので、
// 住民ごと・フレームごとに画像を見る必要が無い。新しい種類を足したら、ここを回し直す。
//
//   cd tools/clip && npm install && node embed.mjs
//
// 書き出すもの (どれも L2 正規化前の生の埋め込み。中心化はサーバー側 src/taste.js が行う):
//   types[name]  … 建物の見た目 (ファサード写真)。写真の無い種類 (公園・グラウンド) は文で代用
//   labels[name] … 建物を言葉で書いたもの (見た目の埋め込みが意味を持っているかの検算用)
//   pool[id]     … persona_pool.json の住民の説明文
//   policy[id]   … personas.json の行動モデルの説明文 (プールを使わない旧方式の住民用)

import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer, CLIPTextModelWithProjection, AutoProcessor,
         CLIPVisionModelWithProjection, RawImage, env } from '@huggingface/transformers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MODEL = 'Xenova/mobileclip_s0';
// 文は量子化版 (q8) で十分だが、**画像側の量子化版は壊れている** (31種の写真当てが 0〜1 = 偶然と同じ)。
// 画像だけ fp32 にすると 13/31 (上位3つに入るのは 19/31)。外れの多くは小学校/中学校/高校のような
// 見た目の近い種類どうし。
const TEXT_DTYPE = process.env.CLIP_TEXT_DTYPE || 'q8';
const VISION_DTYPE = process.env.CLIP_VISION_DTYPE || 'fp32';
env.cacheDir = path.join(HERE, '.cache');              // gitignore 済み

// 建物の種類 → 英語の言い方。server.js の BLDG_TYPES と名前で対応する。
// ★ 種類を足したらここにも足すこと (無いと文の埋め込みが作られない)。
const LABELS = {
  shop:'a small shop', house:'a house', post:'a post office', bank:'a bank',
  apartment:'an apartment building', hotel:'a hotel', office:'an office building',
  tower:'a skyscraper', supermarket:'a supermarket', temple:'a japanese shrine',
  school:'a school', station:'a train station', library:'a library', hospital:'a hospital',
  cityhall:'a city hall', museum:'a museum', stadium:'a stadium', mall:'a shopping mall',
  park:'a park with trees and grass', ground:'a sports ground',
  kiosk:'a street food stall', conbini:'a convenience store', pharmacy:'a pharmacy',
  cafe:'a cafe', gyudon:'a beef bowl restaurant', ramen:'a ramen shop', bento:'a bento lunch shop',
  police:'a police station', elementary:'an elementary school', junior:'a junior high school',
  high:'a high school', university:'a university', warehouse:'a warehouse',
};
const TEX_DIR = path.join(ROOT, 'textures', 'v4');

const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const round = v => Array.from(v, x => Math.round(x * 1e4) / 1e4);

const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: TEXT_DTYPE });
const processor = await AutoProcessor.from_pretrained(MODEL);
const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: VISION_DTYPE });

async function embedTexts(texts) {
  // MobileCLIP は max_length で揃えないと埋め込みが崩れる (モデルカードの注意)
  const inputs = tokenizer(texts, { padding: 'max_length', truncation: true });
  const { text_embeds } = await textModel(inputs);
  const [n, d] = text_embeds.dims;
  return Array.from({ length: n }, (_, i) => text_embeds.data.slice(i * d, (i + 1) * d));
}
// ファサード写真は縦長 (例 290x399) なので、既定の中央切り抜きだと**店先が切れる**
// (ラーメン屋の暖簾は写真の下端にある)。全体を灰色で正方形に収めたものと、
// 下端の正方形 (歩いている人の目に入る店先) の2枚を見て平均する。
async function embedCrop(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  const { image_embeds } = await visionModel(await processor(img));
  return unit(image_embeds.data);
}
async function embedImage(file) {
  const m = await sharp(file).metadata(), s = Math.min(m.width, m.height);
  const whole = await sharp(file).resize(256, 256, { fit: 'contain', background: { r: 128, g: 128, b: 128 } }).toBuffer();
  const front = await sharp(file).extract({ left: Math.floor((m.width - s) / 2), top: m.height - s, width: s, height: s }).toBuffer();
  const a = await embedCrop(whole), b = await embedCrop(front);
  return a.map((x, i) => x + b[i]);
}
const unit = v => { const s = Math.hypot(...v) || 1; return Array.from(v, x => x / s); };

// ── 建物 ────────────────────────────────────────────────────────────────────
const names = Object.keys(LABELS);
const labelVecs = await embedTexts(names.map(n => `a photo of ${LABELS[n]}`));
const types = {}, labels = {};
for (let i = 0; i < names.length; i++) {
  const n = names[i];
  labels[n] = round(labelVecs[i]);
  const tex = path.join(TEX_DIR, n + '.jpg');
  types[n] = fs.existsSync(tex)
    ? { src: 'image', v: round(await embedImage(tex)) }
    : { src: 'text',  v: labels[n] };                  // 写真の無い種類は文で代用
}

// ── 住民 ────────────────────────────────────────────────────────────────────
// 説明文だけを使う。**職業は入れない** — 入れると職業の単語が全部を持っていき、
// 学生は全員「学校が好き」、新米は「倉庫が好き」になる (役割であって好みではない)。
// CLIP の文は 77 トークンまでなので、長い説明は切れる (先頭が残る)。
const personText = p => (p.desc || p.name || '').trim();
const poolList = (readJson('persona_pool.json').personas || []);
const policyList = (readJson('personas.json').personas || []);
const poolVecs = await embedTexts(poolList.map(personText));
const policyVecs = await embedTexts(policyList.map(personText));
const pool = {}, policy = {};
poolList.forEach((p, i) => { pool[p.id] = round(poolVecs[i]); });
policyList.forEach((p, i) => { policy[p.id] = round(policyVecs[i]); });

const out = { model: MODEL, dtype: { text: TEXT_DTYPE, vision: VISION_DTYPE }, dim: labelVecs[0].length,
              made: new Date().toISOString().slice(0, 10), types, labels, pool, policy };
const dst = path.join(ROOT, 'data', 'clip_emb.json');
fs.writeFileSync(dst, JSON.stringify(out));
const img = Object.values(types).filter(t => t.src === 'image').length;
console.log(`[CLIP] ${dst} — 建物 ${names.length}種 (写真 ${img} / 文 ${names.length - img}) `
          + `住民 ${poolList.length} + 行動モデル ${policyList.length} / ${out.dim}次元`);
