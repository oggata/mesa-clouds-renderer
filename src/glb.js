// glb.js — GLB (glTF 2.0 バイナリ) から**静的なジオメトリだけ**を取り出す最小の読み取り。
//
// ── なぜ自前で書くか ──
// three.js の GLTFLoader は examples/jsm 配下の **ESM** で、server.js (CommonJS) から
// require できない (ERR_REQUIRE_ESM)。パッケージを足す手もあるが、この repo は
// .env ローダも proto もジオメトリのマージも自前で持つ方針なので、それに合わせる。
//
// ── 対応している範囲 ──
//   ・POSITION / NORMAL / TEXCOORD_0 / インデックス
//   ・ノードの translation / rotation / scale / matrix (階層もたどる)
//   ・マテリアルは **名前と baseColorFactor だけ**。テクスチャは読まない
//   ・mode=4 (三角形) のみ
// アニメーション・スキン・モーフ・Draco 圧縮には対応しない。
// 街に置く小物 (木・ベンチ等) を読むためのものなので、これで足りる。
//
// 返すもの: { parts: [{name, material, position, normal, uv, index}], materials: [...] }
//   position/normal/uv/index は TypedArray。呼ぶ側で BufferGeometry に詰める。

'use strict';

const fs = require('fs');

// glTF の componentType -> TypedArray
const COMP = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NUM = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 };

function parseGlb(buf){
  if(buf.length < 12 || buf.toString('ascii',0,4) !== 'glTF')
    throw new Error('GLB ではない (先頭が glTF でない)');
  const ver = buf.readUInt32LE(4);
  if(ver !== 2) throw new Error(`GLB のバージョンが ${ver} (2 のみ対応)`);
  let o = 12, json = null, bin = null;
  while(o + 8 <= buf.length){
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o+4, o+8);
    const data = buf.subarray(o+8, o+8+len);
    if(type === 'JSON') json = JSON.parse(data.toString('utf8'));
    else if(type[0] === 'B') bin = data;          // 'BIN\0'
    o += 8 + len;
    if(len % 4) o += 4 - (len % 4);               // チャンクは4バイト境界
  }
  if(!json) throw new Error('JSON チャンクが無い');
  return { json, bin };
}

// accessor を TypedArray として取り出す。bufferView の byteStride (飛び飛びの配置) にも対応。
function readAccessor(json, bin, idx){
  if(idx == null) return null;
  const acc = json.accessors[idx];
  const n = NUM[acc.type];
  if(!n) throw new Error(`未対応の accessor type: ${acc.type}`);
  const Ctor = COMP[acc.componentType];
  if(!Ctor) throw new Error(`未対応の componentType: ${acc.componentType}`);
  const out = new Ctor(acc.count * n);
  if(acc.bufferView == null) return out;          // 全部0 (スパース非対応)
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 0;
  if(!stride){
    // 詰まって並んでいる場合はそのまま読む
    const src = new Ctor(bin.buffer, bin.byteOffset + base, acc.count * n);
    out.set(src);
  }else{
    // 飛び飛び。1要素ずつ拾う
    const bpe = Ctor.BYTES_PER_ELEMENT;
    for(let i=0;i<acc.count;i++){
      const off = bin.byteOffset + base + i*stride;
      const src = new Ctor(bin.buffer, off, n);
      out.set(src, i*n);
    }
  }
  return out;
}

// ノードのローカル行列 (列優先 4x4) を返す
function nodeMatrix(nd){
  if(nd.matrix) return nd.matrix.slice();
  const t = nd.translation || [0,0,0];
  const r = nd.rotation    || [0,0,0,1];   // クォータニオン xyzw
  const s = nd.scale       || [1,1,1];
  const [x,y,z,w] = r;
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  return [
    (1-(yy+zz))*s[0], (xy+wz)*s[0],     (xz-wy)*s[0],     0,
    (xy-wz)*s[1],     (1-(xx+zz))*s[1], (yz+wx)*s[1],     0,
    (xz+wy)*s[2],     (yz-wx)*s[2],     (1-(xx+yy))*s[2], 0,
    t[0],             t[1],             t[2],             1,
  ];
}
const mulMat = (a,b) => {            // a を後、b を先に適用 (= a * b)
  const o = new Array(16).fill(0);
  for(let c=0;c<4;c++) for(let r=0;r<4;r++)
    for(let k=0;k<4;k++) o[c*4+r] += a[k*4+r]*b[c*4+k];
  return o;
};
const applyPos = (m,x,y,z) => [
  m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
// 法線は平行移動を無視する (非一様スケールは無視。小物用なので十分)
const applyNrm = (m,x,y,z) => {
  const v=[m[0]*x+m[4]*y+m[8]*z, m[1]*x+m[5]*y+m[9]*z, m[2]*x+m[6]*y+m[10]*z];
  const l=Math.hypot(v[0],v[1],v[2])||1;
  return [v[0]/l, v[1]/l, v[2]/l];
};

/**
 * GLB を読んでパーツの配列にする。ノードの階層をたどって座標を焼き込む。
 *   fp … ファイルパス
 * 返り値の position は **glTF のまま (Y が上)**。Z-up への回転は呼ぶ側でやる。
 */
function loadGlb(fp){
  const { json, bin } = parseGlb(fs.readFileSync(fp));
  const parts = [];
  const scene = json.scenes ? json.scenes[json.scene || 0] : null;
  const roots = (scene && scene.nodes) ? scene.nodes : json.nodes.map((_,i)=>i);

  const walk = (ni, parent) => {
    const nd = json.nodes[ni];
    const world = mulMat(parent, nodeMatrix(nd));
    if(nd.mesh != null){
      for(const prim of json.meshes[nd.mesh].primitives){
        if(prim.mode != null && prim.mode !== 4) continue;   // 三角形以外は捨てる
        const pos = readAccessor(json, bin, prim.attributes.POSITION);
        if(!pos) continue;
        const nrm = readAccessor(json, bin, prim.attributes.NORMAL);
        const uv  = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
        const idx = readAccessor(json, bin, prim.indices);
        // ノード変換をここで焼く (呼ぶ側が階層を意識しなくて済む)
        const P = new Float32Array(pos.length);
        for(let i=0;i<pos.length;i+=3){
          const v = applyPos(world, pos[i], pos[i+1], pos[i+2]);
          P[i]=v[0]; P[i+1]=v[1]; P[i+2]=v[2];
        }
        let N = null;
        if(nrm){
          N = new Float32Array(nrm.length);
          for(let i=0;i<nrm.length;i+=3){
            const v = applyNrm(world, nrm[i], nrm[i+1], nrm[i+2]);
            N[i]=v[0]; N[i+1]=v[1]; N[i+2]=v[2];
          }
        }
        const mat = prim.material != null ? (json.materials[prim.material] || {}) : {};
        parts.push({
          node: nd.name || '', material: prim.material,
          materialName: mat.name || '',
          baseColor: (mat.pbrMetallicRoughness || {}).baseColorFactor || null,
          position: P, normal: N, uv: uv || null,
          index: idx ? (idx instanceof Uint32Array ? idx : Uint32Array.from(idx)) : null,
        });
      }
    }
    for(const c of (nd.children || [])) walk(c, world);
  };
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  for(const r of roots) walk(r, I);
  if(!parts.length) throw new Error('三角形メッシュが見つからない');
  return { parts, materials: json.materials || [] };
}

module.exports = { loadGlb, parseGlb, readAccessor };
