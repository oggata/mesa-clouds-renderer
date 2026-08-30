'use strict';
// png.js — 依存パッケージ無しの PNG 読み書き。
//
// sharp は package.json の依存に入っているが、tools/ のスクリプトは
// node_modules が無い状態でも動いてほしい (make-building-glb.js も fs だけで
// 動く)。8bit RGBA・フィルタ 0 固定という割り切った実装で、このリポジトリが
// 自分で書いた PNG を読み書きできれば十分。

const zlib = require('zlib');

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** 8bit RGBA の Uint8Array を PNG の Buffer にする。 */
function encode(rgba, w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                      // filter 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * encode() が書いた PNG を戻す。**フィルタ 0 のみ対応** (他所の PNG は読めない)。
 * 返り値の px(x,y) は [r,g,b,a]。
 */
function decode(buf) {
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); }
    if (type === 'IDAT') idat.push(buf.slice(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  for (let y = 0; y < h; y++) if (raw[y * (w * 4 + 1)] !== 0)
    throw new Error(`png.js: フィルタ ${raw[y * (w * 4 + 1)]} の PNG は読めません (行 ${y})`);
  return { w, h, px: (x, y) => { const o = y * (w * 4 + 1) + 1 + x * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; } };
}

module.exports = { encode, decode };
