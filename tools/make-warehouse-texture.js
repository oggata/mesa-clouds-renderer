#!/usr/bin/env node
'use strict';
// make-warehouse-texture.js — 倉庫 (warehouse) のファサードを手続き的に描いて JPEG に書く。
//
//   node tools/make-warehouse-texture.js            # textures/v4/warehouse.jpg
//   node tools/make-warehouse-texture.js out.jpg
//
// ── なぜ生成なのか ──
// textures/v4/*.jpg は他の 30 種すべてが実写のファサードで、倉庫だけが無い。
// そして server.js の loadRaycastTextures() は
//     rcTexReady = rcTex.every(t=>t)
// つまり **1 枚でも欠けると観測用テクスチャ全体が無効**になる (= 全ペルソナが
// テクスチャ無しの FPV を見ることになり、学習済み方策が意味を失う)。
// 建物タイプを足すなら絵も必ず足す必要があるので、依存を増やさず手で描く。
//
// ── サイズ ──
// 同じ height=1.4 の仲間 (house / school / station) と揃えて 259x453。
// 側面比の基準は BLDG_TYPES のコメント (footprint*CELL*0.8 : height*CELL) だが、
// v4 の実物は全部この縦長で撮られているので、そちらに合わせる。

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const W = 259, H = 453;
const OUT = process.argv[2] ||
  path.join(__dirname, '..', 'textures', 'v4', 'warehouse.jpg');

const buf = Buffer.alloc(W * H * 3);
const px = (x, y, r, g, b) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = Math.max(0, Math.min(255, r | 0));
  buf[i + 1] = Math.max(0, Math.min(255, g | 0));
  buf[i + 2] = Math.max(0, Math.min(255, b | 0));
};
const rect = (x0, y0, x1, y1, f) => {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const c = f(x, y);
      if (c) px(x, y, c[0], c[1], c[2]);
    }
};
// 決定論のノイズ。Math.random() だと走らせるたびに絵が変わり、
// 「テクスチャを作り直したら方策の見え方が変わった」を追えなくなる。
let _s = 20260831;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ── 帯の割り付け (上から) ──
const ROOF_H   = 26;                 // 屋根の見切り
const SIGN_Y0  = ROOF_H,  SIGN_Y1 = ROOF_H + 46;    // 社名サイン
const WIN_Y0   = SIGN_Y1 + 30, WIN_Y1 = WIN_Y0 + 44; // 明かり取りの窓帯
const DOOR_Y0  = 232, DOOR_Y1 = 408;                 // 大型シャッター
const GROUND_Y = 430;                                // 前面の土間・アスファルト

// ① 波板の壁。縦リブを一定間隔で入れて金属らしい陰影にする。
const RIB = 11;
rect(0, 0, W, GROUND_Y, (x, y) => {
  const t = ((x % RIB) / RIB) * Math.PI * 2;
  const shade = Math.cos(t) * 13;                  // リブの陰影
  const dirt = (y / H) * 10;                       // 下ほど薄汚れる
  const n = (rnd() - 0.5) * 6;
  return [176 + shade - dirt + n, 182 + shade - dirt + n, 188 + shade - dirt + n];
});

// ② 屋根 (庇)。上端の暗い帯 + 影の落ち込み。
rect(0, 0, W, ROOF_H, () => {
  const n = (rnd() - 0.5) * 5;
  return [96 + n, 102 + n, 110 + n];
});
rect(0, ROOF_H, W, ROOF_H + 6, (x, y) => {
  const k = (ROOF_H + 6 - y) / 6;                  // 庇が壁に落とす影
  return [176 - 55 * k, 182 - 55 * k, 188 - 55 * k];
});

// ③ サイン。青地に白の横棒 3 本 = 遠目で「荷物」を連想させる記号。
//    文字は入れない (64x64 に落ちると潰れて読めず、DINOv2 には模様としてしか届かない)。
rect(10, SIGN_Y0 + 8, W - 10, SIGN_Y1, () => {
  const n = (rnd() - 0.5) * 6;
  return [30 + n, 62 + n, 112 + n];
});
for (let i = 0; i < 3; i++) {
  const y0 = SIGN_Y0 + 16 + i * 11;
  rect(26, y0, W - 26 - i * 34, y0 + 6, () => [232, 236, 240]);
}

// ④ 窓帯。すりガラスの明かり取りを 4 連で。
const WIN_N = 4, WIN_PAD = 14;
const winW = (W - WIN_PAD * 2 - (WIN_N - 1) * 8) / WIN_N;
for (let i = 0; i < WIN_N; i++) {
  const x0 = Math.round(WIN_PAD + i * (winW + 8));
  const x1 = Math.round(x0 + winW);
  rect(x0 - 2, WIN_Y0 - 2, x1 + 2, WIN_Y1 + 2, () => [86, 92, 98]);   // 枠
  rect(x0, WIN_Y0, x1, WIN_Y1, (x, y) => {
    const k = (y - WIN_Y0) / (WIN_Y1 - WIN_Y0);                        // 上が明るい
    const n = (rnd() - 0.5) * 8;
    return [150 + 60 * (1 - k) + n, 168 + 60 * (1 - k) + n, 176 + 55 * (1 - k) + n];
  });
  rect(x0, WIN_Y0 + Math.round((WIN_Y1 - WIN_Y0) / 2) - 1, x1,
       WIN_Y0 + Math.round((WIN_Y1 - WIN_Y0) / 2) + 1, () => [86, 92, 98]);  // 中桟
}

// ⑤ 大型シャッター。横スラットの繰り返し = 倉庫のいちばん強い手がかり。
rect(18, DOOR_Y0 - 8, W - 18, DOOR_Y0, () => [70, 74, 80]);            // まぐさ
rect(18, DOOR_Y0, W - 18, DOOR_Y1, (x, y) => {
  const s = (y - DOOR_Y0) % 9;
  const edge = (s < 2) ? -34 : (s > 6 ? 12 : 0);                       // スラットの継ぎ目
  const vign = Math.abs(x - W / 2) / (W / 2) * 16;                     // 左右の落ち
  const n = (rnd() - 0.5) * 5;
  return [148 + edge - vign + n, 152 + edge - vign + n, 156 + edge - vign + n];
});
// シャッターの左右のガイドレール
rect(14, DOOR_Y0 - 8, 20, DOOR_Y1, () => [88, 92, 98]);
rect(W - 20, DOOR_Y0 - 8, W - 14, DOOR_Y1, () => [88, 92, 98]);

// ⑥ 荷捌き場の黄色いゼブラ。搬入口だと一目で分かる床の印。
rect(0, DOOR_Y1, W, GROUND_Y, (x, y) => {
  const d = ((x + (y - DOOR_Y1) * 2) % 26);
  return d < 13 ? [196, 164, 44] : [72, 74, 78];
});
// ⑦ 土間。手前のアスファルト。
rect(0, GROUND_Y, W, H, () => {
  const n = (rnd() - 0.5) * 10;
  return [64 + n, 66 + n, 70 + n];
});

sharp(buf, { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 92 })
  .toFile(OUT)
  .then(() => console.log(`[warehouse] ${path.relative(process.cwd(), OUT)} (${W}x${H})`))
  .catch(e => { console.error(e.message); process.exit(1); });
