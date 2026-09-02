#!/usr/bin/env node
'use strict';
// fetch-font.js — 配信画面の日本語表示に使うフォントを fonts/ に置く。
//
//   node tools/fetch-font.js            # 既定 (M PLUS 1p Regular) を取得
//   node tools/fetch-font.js noto       # Noto Sans JP (可変) を取得
//
// ── なぜフォントを同梱するのか ──
// 配信画面の文字は sharp(librsvg) が SVG をラスタライズして焼いている。librsvg は
// fontconfig でフォントを探すので、**本番 (Linux) に日本語フォントが入っていないと
// 全部豆腐になる**。これが「配信画面は ASCII だけ」という制限の理由だった。
// リポジトリに 1 本持っておけば、どの環境に置いても同じ絵になる。
//
// ── どれを選ぶか ──
//   mplus  M PLUS 1p Regular  1.7MB  既定。JIS の常用漢字を十分に覆う UI 書体
//   noto   Noto Sans JP       9.1MB  可変フォント。覆う字は多いがリポジトリには重い
// どちらも SIL Open Font License 1.1。**OFL は著作権表示の同梱を求める**ので、
// 本体と一緒に OFL.txt も置く。
//
// 配布物を取りたくない場合は、OS のパッケージでも良い:
//   Ubuntu/Debian:  sudo apt install fonts-noto-cjk
// その場合は fonts/ を空のままにして HUD_LANG=ja で起動すればシステム側が使われる
// (server.js は fonts/ が空なら FONTCONFIG_FILE を差し替えない)。

const fs = require('fs');
const path = require('path');
const https = require('https');

const RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const FONTS = {
  mplus: { dir: 'mplus1p',    file: 'MPLUS1p-Regular.ttf',    mb: 1.7 },
  noto:  { dir: 'notosansjp', file: 'NotoSansJP[wght].ttf',   mb: 9.1 },
};

const which = (process.argv[2] || 'mplus').toLowerCase();
const F = FONTS[which];
if (!F) {
  console.error(`[Font] 不明な指定: ${which}  (使えるのは ${Object.keys(FONTS).join(' / ')})`);
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'fonts');

// リダイレクトを追ってダウンロードする。**取れたものが本当にフォントかを確かめる**。
// GitHub は LFS やリダイレクトで HTML を返してくることがあり、それをそのまま
// 置くと「フォントはあるのに豆腐」という分かりにくい壊れ方をする。
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('リダイレクトが多すぎます'));
    https.get(url, { headers: { 'User-Agent': 'mesa-city-sim' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// TrueType/OpenType の先頭 4 バイト (sfnt のタグ)
const isFont = b => b.length > 4 && (
  b.readUInt32BE(0) === 0x00010000 ||               // TrueType
  b.slice(0, 4).toString('latin1') === 'OTTO' ||    // CFF (OpenType)
  b.slice(0, 4).toString('latin1') === 'true' ||
  b.slice(0, 4).toString('latin1') === 'ttcf');     // コレクション

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const url = `${RAW}/${F.dir}/${encodeURIComponent(F.file)}`;
  console.log(`[Font] 取得中 ${F.file} (約${F.mb}MB)`);
  console.log(`[Font]   ${url}`);
  const buf = await get(url);
  if (!isFont(buf)) {
    console.error(`[Font] 取得したものがフォントではありません (${buf.length} bytes)。`
      + ' 配布元の URL が変わった可能性があります。');
    process.exit(1);
  }
  fs.writeFileSync(path.join(outDir, F.file), buf);
  console.log(`[Font] fonts/${F.file}  ${(buf.length / 1048576).toFixed(2)}MB`);

  // OFL は著作権表示の同梱を求めるので、ライセンスも一緒に置く
  try {
    const ofl = await get(`${RAW}/${F.dir}/OFL.txt`);
    fs.writeFileSync(path.join(outDir, 'OFL.txt'), ofl);
    console.log('[Font] fonts/OFL.txt (SIL Open Font License 1.1)');
  } catch (e) {
    console.warn('[Font] OFL.txt を取得できませんでした:', e.message,
      '— 再配布するときは配布元からライセンスを持ってきてください');
  }
  console.log('[Font] HUD_LANG=ja node server.js で日本語表示になります');
})().catch(e => { console.error('[Font] 失敗:', e.message); process.exit(1); });
