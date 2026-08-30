// skeleton.js — 住民の骨格 (関節・骨・色) と歩行ポーズ。
//
// **server.js から切り出す理由は world.js / roads.js と同じ。**
// 同じ式が最低 2 か所から引かれる:
//   ・server.js  … ジオメトリを組み、頂点シェーダに焼き込む定数を出す
//   ・tools/preview-walk.js … 歩行サイクルを絵にして確かめる
// three と headless-gl が要る server.js はテスト環境で動かせないので、
// ポーズの式をここに置いておかないと「歩き方が正しいか」を確かめる手段が無い。
//
// ── 座標系 ──
//   x = 左右 (+ が左)   y = 前後 (+ が進行方向)   z = 高さ (+ が上)
// server.js の住民ジオメトリと同じ (鼻が +Y にあった向き)。
// 単位は**身長 H の比**。server.js が H = CELL*0.66 を掛ける。
//
// ── なぜボーンではなく頂点シェーダか ──
// three r132 に InstancedSkinnedMesh が無く、SkinnedMesh はインスタンシングと
// 排他になる。住民は全員同じ骨格で、違うのは位相と振幅だけなので、
// 頂点属性 aWalk=(位相,振幅) と aBone=(骨番号) を渡して
// シェーダ側で関節を回せば足りる。ドローコールは 2 本のまま。

'use strict';

// ── 関節 (rest pose)。z は足元からの高さ、身長 H に対する比 ────────────────
// 実際の人体の比率に合わせてある (膝 28% / 腰 53% / 肩 82% / 肘 62%)。
const J = {
  foot:     { x: 0.055, y: 0.075, z: 0.010 },   // つま先 (前に出ている)
  ankle:    { x: 0.055, y: 0.000, z: 0.045 },
  knee:     { x: 0.055, y: 0.000, z: 0.285 },
  hip:      { x: 0.055, y: 0.000, z: 0.530 },
  pelvis:   { x: 0.000, y: 0.000, z: 0.530 },
  chest:    { x: 0.000, y: 0.000, z: 0.700 },
  shoulder: { x: 0.105, y: 0.000, z: 0.818 },
  neck:     { x: 0.000, y: 0.000, z: 0.860 },
  head:     { x: 0.000, y: 0.000, z: 0.935 },
  elbow:    { x: 0.105, y: 0.000, z: 0.620 },
  wrist:    { x: 0.105, y: 0.000, z: 0.440 },
};
const HEAD_R = 0.072;      // 頭の半径 (H 比)
const BONE_R = 0.019;      // 骨の太さ
const JOINT_R = 0.030;     // 関節の玉

// ── 骨番号。シェーダの分岐と 1 対 1 で対応する ─────────────────────────────
const BONE = { TORSO:0, LTHIGH:1, LSHIN:2, RTHIGH:3, RSHIN:4,
               LUARM:5, LFARM:6, RUARM:7, RFARM:8 };

// ── 色 (添付の姿勢推定オーバーレイに寄せた) ────────────────────────────────
const COL = {
  head:  0xdd3fb0,   // 頭 … マゼンタ
  spine: 0x22d3e0,   // 背骨・首・肩 … シアン
  uarm:  0x22d3e0,
  farm:  0x46e8d4,
  hand:  0xdd3fb0,
  hips:  0xe8d022,   // 骨盤・腿 … 黄
  thigh: 0xe8d022,
  shin:  0xf0a020,   // 脛 … 橙
  foot:  0xdd3fb0,
  joint: 0xf2f2f2,   // 関節の玉
};

// ── 骨の一覧 ────────────────────────────────────────────────────────────────
// side: +1 = 左 (x をそのまま) / -1 = 右 (x を反転) / 0 = 中央
// 左右のある骨は side ごとに 2 本作る。
const BONES = [
  { a:'pelvis',   b:'chest',    r:BONE_R*1.15, col:'spine', bone:BONE.TORSO, side:0 },
  { a:'chest',    b:'neck',     r:BONE_R*1.05, col:'spine', bone:BONE.TORSO, side:0 },
  { a:'neck',     b:'head',     r:BONE_R*0.9,  col:'spine', bone:BONE.TORSO, side:0 },
  { a:'shoulder', b:'shoulder', r:BONE_R*0.9,  col:'spine', bone:BONE.TORSO, side:2 },  // 肩の横棒
  { a:'hip',      b:'hip',      r:BONE_R*0.95, col:'hips',  bone:BONE.TORSO, side:2 },  // 骨盤の横棒
  { a:'hip',      b:'knee',     r:BONE_R,      col:'thigh', bone:'THIGH', side:1 },
  { a:'knee',     b:'ankle',    r:BONE_R*0.9,  col:'shin',  bone:'SHIN',  side:1 },
  { a:'ankle',    b:'foot',     r:BONE_R*0.8,  col:'foot',  bone:'SHIN',  side:1 },
  { a:'shoulder', b:'elbow',    r:BONE_R*0.85, col:'uarm',  bone:'UARM',  side:1 },
  { a:'elbow',    b:'wrist',    r:BONE_R*0.75, col:'farm',  bone:'FARM',  side:1 },
];
// 関節の玉。骨の継ぎ目を隠して、姿勢推定の絵のように節が見えるようにする。
const JOINTS = [
  { j:'pelvis', r:JOINT_R*0.9, bone:BONE.TORSO, side:0 },
  { j:'chest',  r:JOINT_R*0.8, bone:BONE.TORSO, side:0 },
  { j:'shoulder', r:JOINT_R*0.85, bone:BONE.TORSO, side:1 },
  { j:'hip',    r:JOINT_R*0.85, bone:BONE.TORSO, side:1 },
  { j:'knee',   r:JOINT_R*0.8,  bone:'THIGH', side:1 },   // 腿と一緒に動く
  { j:'ankle',  r:JOINT_R*0.7,  bone:'SHIN',  side:1 },
  { j:'elbow',  r:JOINT_R*0.7,  bone:'UARM',  side:1 },
  { j:'wrist',  r:JOINT_R*0.6,  bone:'FARM',  side:1 },
];

// ── 歩行のパラメータ ────────────────────────────────────────────────────────
const WALK = {
  thigh:      0.62,   // 腿の振れ角 (rad)
  kneeSwing:  1.15,   // 遊脚期の膝の曲げ
  kneeStance: 0.10,   // 立脚期の膝の緩み (棒足に見えないように)
  arm:        0.36,   // 腕の振れ角
  // 肘は**前に振ったときだけ深く曲がる**。常時屈曲を大きくすると、腕が後ろに
  // 振れている間も前腕が前を向いたままになり、上腕と「く」の字に折れて見える。
  elbowBase:  0.12,   // 後ろに振り切ったときの屈曲 (ほぼ伸びている)
  elbowSwing: 0.42,   // 前に振ったときの追加ぶん
  bob:        0.016,  // 上下動 (H 比)。1 周期に 2 回沈む
  lean:       0.13,   // 前傾 (rad)
};

/**
 * 片側ぶんの関節角。side: +1 = 左 / -1 = 右。
 * 右は位相を π ずらす (sin の奇関数性では膝のカーブがずれないため、位相自体を回す)。
 */
function limbAngles(phase, amp, side) {
  const p = phase + (side > 0 ? 0 : Math.PI);
  const cp = Math.max(0, Math.cos(p));
  // 腕は**同じ側の脚と逆位相**。腕を前に出すのは反対側の脚が前のとき。
  const pa = p + Math.PI;
  return {
    thigh: WALK.thigh * amp * Math.sin(p),
    // 膝は遊脚期 (つま先が離れて振り出すまで) にだけ深く曲がる。
    // cos(p) が正の区間 = 蹴り出し〜振り出し。立脚期は伸びたまま。
    knee: -amp * (WALK.kneeStance + WALK.kneeSwing * Math.pow(cp, 1.5)),
    sh: WALK.arm * amp * Math.sin(pa),
    el: amp * (WALK.elbowBase + WALK.elbowSwing * Math.max(0, Math.sin(pa))),
  };
}

// X 軸まわりの回転 (矢状面)。正の角で、支点より下の点が進行方向 (+y) へ出る。
function rotX(p, pz, a) {
  const s = Math.sin(a), c = Math.cos(a);
  const y = p.y, z = p.z - pz;
  return { x: p.x, y: y * c - z * s, z: pz + y * s + z * c };
}

/**
 * rest pose の 1 点を、歩行位相 phase・振幅 amp のときの位置へ動かす。
 * **シェーダはこれとまったく同じ順序で回す。** ここを直したらシェーダも直すこと
 * (定数はどちらも WALK / J から出しているので、式の形だけが二重になっている)。
 */
function poseVertex(p, boneId, phase, amp) {
  const isLeft = boneId === BONE.LTHIGH || boneId === BONE.LSHIN
              || boneId === BONE.LUARM || boneId === BONE.LFARM;
  const A = limbAngles(phase, amp, isLeft ? 1 : -1);
  let q = { x: p.x, y: p.y, z: p.z };
  switch (boneId) {
    case BONE.LSHIN: case BONE.RSHIN:
      q = rotX(q, J.knee.z, A.knee);
      q = rotX(q, J.hip.z, A.thigh);
      break;
    case BONE.LTHIGH: case BONE.RTHIGH:
      q = rotX(q, J.hip.z, A.thigh);
      break;
    case BONE.LFARM: case BONE.RFARM:
      q = rotX(q, J.elbow.z, A.el);
      q = rotX(q, J.shoulder.z, A.sh);
      q = rotX(q, J.pelvis.z, WALK.lean * amp);      // 上体の前傾
      break;
    case BONE.LUARM: case BONE.RUARM:
      q = rotX(q, J.shoulder.z, A.sh);
      q = rotX(q, J.pelvis.z, WALK.lean * amp);
      break;
    default:                                          // 胴・頭
      q = rotX(q, J.pelvis.z, WALK.lean * amp);
  }
  // 上下動。1 歩ごとに沈むので周期は歩行位相の 2 倍。
  q.z += WALK.bob * amp * Math.cos(2 * phase);
  return q;
}

/** 骨の一覧を「左右に展開した具体的な線分」にする。server.js とプレビューが共用。 */
function boneSegments() {
  const out = [];
  const pick = (name, sx) => ({ x: J[name].x * sx, y: J[name].y, z: J[name].z });
  for (const b of BONES) {
    if (b.side === 0) { out.push({ a: pick(b.a, 1), b: pick(b.b, 1), r: b.r, col: COL[b.col], bone: b.bone }); continue; }
    if (b.side === 2) { out.push({ a: pick(b.a, -1), b: pick(b.b, 1), r: b.r, col: COL[b.col], bone: b.bone }); continue; }
    for (const s of [1, -1]) {
      const id = BONE[(s > 0 ? 'L' : 'R') + b.bone];
      out.push({ a: pick(b.a, s), b: pick(b.b, s), r: b.r, col: COL[b.col], bone: id });
    }
  }
  return out;
}

/** 関節の玉の一覧。頭も球なのでここに混ぜる。 */
function jointSpheres() {
  const out = [{ p: { x: 0, y: 0, z: J.head.z }, r: HEAD_R, col: COL.head, bone: BONE.TORSO }];
  for (const s of JOINTS) {
    if (s.side === 0) { out.push({ p: { ...J[s.j] }, r: s.r, col: COL.joint, bone: s.bone }); continue; }
    for (const sg of [1, -1]) {
      const id = typeof s.bone === 'string' ? BONE[(sg > 0 ? 'L' : 'R') + s.bone] : s.bone;
      out.push({ p: { x: J[s.j].x * sg, y: J[s.j].y, z: J[s.j].z }, r: s.r, col: COL.joint, bone: id });
    }
  }
  return out;
}

module.exports = { J, BONE, COL, BONES, JOINTS, WALK, HEAD_R, BONE_R, JOINT_R,
                   limbAngles, rotX, poseVertex, boneSegments, jointSpheres };
