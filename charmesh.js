// charmesh.js — 住民の「型紙 → three のジオメトリ」変換。
//
// **なぜ server.js から切り出すか。**
// skeleton.js が持っているのは寸法の記述 (bodyParts) までで、それを
// BufferGeometry に起こす部分は server.js の中にあった。すると
// **キャラクターの見た目を確かめる手段が「配信を立ち上げる」しか無い**。
// 住民は画面上 40px ほどにしか映らないので、それでは形の良し悪しが分からない。
// ここに出しておけば tools/preview-char.js が同じコードで大きく描ける。
//
// three は引数で受け取る (require しない)。skeleton.js と同じく、three と
// headless-gl の要らない場所からも読めるようにしておくため。

'use strict';

const SK = require('./skeleton.js');

/**
 * 型紙 1 個を BufferGeometry に起こす。
 *   H    … 身長 (ワールド単位)。skeleton.js の比率にこれを掛ける
 *   base … 足元のローカル z
 *
 * rest pose では手足の骨がすべて鉛直なので、cone は「Y 軸で作って Z 向きに倒し、
 * 前後だけ潰して中点へ運ぶ」で足りる。傾いた骨を足すならここに回転が要る。
 */
function partGeo(THREE, it, H, base) {
  const wz = z => base + z * H;
  let g;
  if (it.type === 'cone') {
    const L = Math.abs(it.b.z - it.a.z) * H;
    // CylinderGeometry は +Y が上。どちらの端点が上かは z で決める。
    const upIsB = it.b.z >= it.a.z;
    const rTop = (upIsB ? it.r2 : it.r1) * H, rBot = (upIsB ? it.r1 : it.r2) * H;
    g = new THREE.CylinderGeometry(rTop, rBot, L, it.seg || 8, 1, false);
    g.rotateX(Math.PI / 2);                     // +Y 上 → +Z 上
    g.scale(1, it.sy || 1, 1);                  // 前後を潰して人の断面にする
    g.translate((it.a.x + it.b.x) / 2 * H, (it.a.y + it.b.y) / 2 * H,
                (wz(it.a.z) + wz(it.b.z)) / 2);
  } else if (it.type === 'ball') {
    g = new THREE.SphereGeometry(it.r * H, it.seg[0], it.seg[1]);
    g.scale(it.sx || 1, it.sy || 1, it.sz || 1);
    g.translate(it.p.x * H, it.p.y * H, wz(it.p.z));
  } else if (it.type === 'cap') {               // 髪 = 上半分だけの球
    g = new THREE.SphereGeometry(it.r * H, it.seg[0], it.seg[1], 0, Math.PI * 2, 0, it.theta);
    g.rotateX(Math.PI / 2);                     // 極を +Z (頭頂) へ
    g.scale(it.sx || 1, it.sy || 1, it.sz || 1);
    g.translate(it.p.x * H, it.p.y * H, wz(it.p.z));
  } else {                                      // box (靴)
    g = new THREE.BoxGeometry(it.w * H, it.d * H, it.h * H);
    g.translate(it.p.x * H, it.p.y * H, wz(it.p.z));
  }
  return g;
}

/** 服を着た人型。色は頂点に焼かず、部位 (part) だけ持たせてシェーダで解決する。 */
function humanParts(THREE, H, base) {
  return SK.bodyParts().map(it => ({
    geo: partGeo(THREE, it, H, base), bone: it.bone, part: it.part,
    // BAKED の部位 (靴) だけ型紙に色を焼く。他は白 (シェーダが上書きする)
    color: new THREE.Color(it.part === SK.PART.BAKED ? (it.col || 0x888888) : 0xffffff),
  }));
}

/**
 * 姿勢推定オーバーレイ風の骨格 (CHAR_STYLE=skeleton)。骨=細い円柱・関節=玉。
 * 頭だけ住民ごとの色 (TOP) にする。胴まで色を付けると骨格に見えなくなり、
 * かといって全部固定色だと 1000 人の見分けが付かない。
 */
function skeletonParts(THREE, H, base, seg) {
  const S = Object.assign({ bone: 5, joint: [5, 3], head: [8, 5] }, seg || {});
  const list = [];
  const P = p => new THREE.Vector3(p.x * H, p.y * H, base + p.z * H);
  for (const b of SK.boneSegments()) {
    const a = P(b.a), c = P(b.b), d = new THREE.Vector3().subVectors(c, a);
    const L = d.length(); if (L < 1e-6) continue;
    const g = new THREE.CylinderGeometry(b.r * H, b.r * H, L, S.bone, 1, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    g.translate((a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2);
    list.push({ geo: g, color: new THREE.Color(b.col), bone: b.bone, part: SK.PART.BAKED });
  }
  for (const sp of SK.jointSpheres()) {
    const p = P(sp.p), isHead = sp.r >= SK.HEAD_R - 1e-9;
    const sg = isHead ? S.head : S.joint;
    const g = new THREE.SphereGeometry(sp.r * H, sg[0], sg[1]);
    g.translate(p.x, p.y, p.z);
    // 頭は instanceColor が掛かる側なので**頂点カラーは白**にする
    // (骨格の配色を残すと掛け算になって色が濁る)。
    list.push({ geo: g, bone: sp.bone, part: isHead ? SK.PART.TOP : SK.PART.BAKED,
                color: new THREE.Color(isHead ? 0xffffff : sp.col) });
  }
  return list;
}

/** style ('human' | 'skeleton') に応じた型紙一覧。 */
function partList(THREE, style, H, base) {
  return style === 'skeleton' ? skeletonParts(THREE, H, base) : humanParts(THREE, H, base);
}

/**
 * 部位ごとの色を実際の色に解決する。**頂点シェーダ (WEAR_COLOR_GLSL) と同じ規則**。
 * 配信では毎フレームシェーダが引くが、プレビューのように 1 枚絵を焼くときは
 * ここで同じ答えを得られる。
 */
function partColor(part, wear, top) {
  if (part === SK.PART.TOP) return top;
  if (part === SK.PART.BOTTOM) return wear.pants;
  const si = Math.floor(wear.tone / 4);
  if (part === SK.PART.SKIN) return SK.SKIN_TONES[si];
  if (part === SK.PART.HAIR) return SK.HAIR_TONES[wear.tone - si * 4];
  return null;                                   // BAKED = 型紙の色をそのまま
}

module.exports = { partGeo, partList, humanParts, skeletonParts, partColor };
