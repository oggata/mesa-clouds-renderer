// walk.js — 住民の「歩き方」。経路をどうたどるかではなく、**たどりながらどう振る舞うか**。
//
// world.js / social.js / economy.js と同じく、server.js のグローバルを一切参照しない
// 純粋なモジュール。呼ぶ側が ctx (状態とコールバックの束) を渡す。
//
// ── なぜ要るか ──
// これまでの pursueAction は「ゴール方位に一番近い通れる向きを13方向から選ぶ」だけで、
//   ・その場で回ってから歩き出す (人は曲がりながら歩く)
//   ・速度が前進かゼロの2値 (人は詰まったら緩める)
//   ・他の住民を一切見ていない (すり抜ける)
//   ・車を一切見ていない
// という4点で、見ていて「人」に見えなかった。
//
// ── 設計の約束 ──
// **ここで使ってよい情報は、方策が観測できるものに限る。** 将来この挙動を模倣学習の
// お手本にするので、ロジックだけが全知だと「原理的に真似できないデモ」になる。
//   使ってよい: 自分の位置と向き / 経路の先読み点 / 近傍の住民 (視界内) /
//               前方の通行可否 / 近くの車
//   使わない  : 全住民の正確な座標を無制限に / マップ全体の大域情報
// aux 側にも同じ信号 (crowd_left/right, car_ttc, curb_ahead) を出してあるので、
// 方策は同じものを見て同じ判断を学べる。

'use strict';

const DEFAULTS = Object.freeze({
  // ── 分離 (人をよける) ──
  // ★ 広く取りすぎると街全体が常時減速する。最初 1.6 で回したら平均速度が 0.43 まで
  //   落ち、300人中274人が減速中という「みんなが徐行している街」になった。
  //   人が密な街なので、**本当に近い相手だけ**に反応させる。
  sepRange:    0.9,   // この距離までの相手を気にする (セル)
  sepFov:      2.2,   // 前方この角度(rad)の中だけ強く気にする。人は背後を気にしない
  sepGain:     2.20,  // よける強さ。**重なりを減らすのはここ**であって減速ではない
  keepSide:   -1,     // 全員がどちらに寄るか (-1=左 / +1=右)。揃えると流れができる
  keepGain:    0.35,  // 寄り癖の強さ
  // ── 速度 ──
  // ★ 減速は**ほとんど掛けない**。
  //   人が密な街で減速させると、その場に留まる時間が伸びて**かえって重なりが増える**。
  //   実測: 減速を強くした版は すり抜け 3.9%→6.6% と悪化し、平均速度 0.36、
  //   来店数も 253→159件 に落ちた。よけるのは「速度」ではなく「向き」の仕事。
  slowRange:   0.45,  // 前方この距離に人が居ると緩める
  slowMin:     0.80,  // いちばん詰まったときでもこれくらいは出す
  turnSlow:    0.15,  // 大きく曲がるときの減速
  turnFree:    1.0,   // これ(rad)までの曲がりでは減速しない。約57度
  slowAhead:   4,     // 前方の錐にこの人数が入ったら緩める
  // ── 車 ──
  carLook:     4.5,   // 何セル先の車まで見るか
  carTtc:      2.2,   // 到達まで何秒を切ったら渡らない
  carClear:    1.2,   // 車のこの距離内には踏み込まない
  // ── 向きの寄せ方 ──
  maxDev:      1.05,  // 経路方向からどれだけ横にずれてよいか (rad)。約60度
  searchSteps: 14,    // 通れる向きを探す段数 (rot の何倍まで振るか)
  turnRate:    1.0,   // 1tick に向きを寄せる割合 (rot に対する倍率)
  goalGain:    1.0,   // 経路方向の重み
});

const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));

// ── 近傍からの「よけたい向き」 ─────────────────────────────────────────────
// 戻り値: {vx, vy, near, ahead}
//   vx,vy … よけたい方向 (ワールド座標)
//   near  … いちばん近い相手までの距離
//   ahead … 前方の錐に入っている相手の数 (減速に使う)
function separation(cfg, a, near){
  let vx=0, vy=0, closest=Infinity, ahead=0;
  for(const o of near){
    const dx=a.x-o.x, dy=a.y-o.y;
    const d=Math.hypot(dx,dy);
    if(d<1e-4 || d>cfg.sepRange) continue;
    if(d<closest) closest=d;
    // 相手が自分の前方にいるか
    let b=Math.atan2(o.y-a.y, o.x-a.x)-a.th; b=wrap(b);
    const front=Math.abs(b) < cfg.sepFov*0.5;
    if(front) ahead++;
    // 近いほど強く、前方ほど強く。背後は軽く見る
    const w=(1 - d/cfg.sepRange) * (front ? 1 : 0.35);
    vx += (dx/d)*w; vy += (dy/d)*w;
  }
  return {vx, vy, near:closest, ahead};
}

// ── 譲る側を決める ─────────────────────────────────────────────────────────
// 両者が同じ側へよけると正面で固まる。**決定論で片方だけが大きく譲る**。
//   aid の辞書順で決める (毎tick同じ答えになるので、譲り合いが揺れない)。
// さらに全員へ keepSide の寄り癖を掛けると、廊下で自然にレーンができる。
function yieldBias(cfg, a, near){
  let bias=cfg.keepSide*cfg.keepGain;      // 全員が同じ側に寄る癖
  for(const o of near){
    const dx=o.x-a.x, dy=o.y-a.y;
    const d=Math.hypot(dx,dy);
    if(d<1e-4 || d>cfg.sepRange) continue;
    let b=wrap(Math.atan2(dy,dx)-a.th);
    if(Math.abs(b) > 0.7) continue;        // ほぼ正面のときだけ「譲る/譲られる」が要る
    // 正面衝突しそうな相手。aid が小さいほうが大きく譲る
    const give = (a.aid < o.aid) ? 1 : 0.25;
    bias += cfg.keepSide * give * (1 - d/cfg.sepRange) * 0.9;
  }
  return bias;
}

// ── 車 ─────────────────────────────────────────────────────────────────────
// 前方の車を見て「渡ってよいか」を返す。
//   戻り値: {wait, ttc}  wait=true なら踏み出さない。ttc は最短の到達秒 (aux にも出す)
// 車の位置と速度しか使わない (方策も同じものを aux で受け取れる)。
function carCheck(cfg, a, cars, stepAhead){
  if(!cars || !cars.length) return {wait:false, ttc:1};
  // 自分がこれから踏む点
  const fx=a.x+Math.cos(a.th)*stepAhead, fy=a.y+Math.sin(a.th)*stepAhead;
  let best=Infinity, block=false;
  for(const c of cars){
    const dx=c.x-a.x, dy=c.y-a.y;
    const d=Math.hypot(dx,dy);
    if(d>cfg.carLook) continue;
    // すぐ横に居る車には踏み込まない (速度に関係なく)
    if(Math.hypot(c.x-fx, c.y-fy) < cfg.carClear) block=true;
    // 車が自分のほうへ向かっているか。向かっていなければ気にしない
    const cv=c.v!=null ? c.v : (c.speed||0);
    if(cv<=0.01) continue;
    const cvx=Math.cos(c.th)*cv, cvy=Math.sin(c.th)*cv;
    // 相対速度が近づく向きでなければ無視
    const closing = -((dx*cvx + dy*cvy)/Math.max(d,1e-4));
    if(closing<=0.01) continue;
    const ttc=d/closing;
    if(ttc<best) best=ttc;
  }
  const ttc = best===Infinity ? cfg.carTtc*2 : best;
  return {wait: block || ttc < cfg.carTtc, ttc};
}

/**
 * 1tick ぶんの歩き方を決める。
 * ctx:
 *   near         … 近くの住民の配列 (視界内。呼ぶ側が空間ハッシュで絞る)
 *   cars         … 近くの車の配列 (無ければ空)
 *   onRoadway(x,y)… その点が車道か (縁石で待つ判定に使う)
 *   passable(x,y,th,dist) … その向きへ dist 進んだ先が通れるか
 *   move, rot    … 1tick の前進量と旋回量
 * 戻り値:
 *   {th, speed, wait, ttc, crowdL, crowdR}
 *     th     … 次の向き (呼ぶ側がそのまま a.th に入れる)
 *     speed  … move に掛ける倍率 (0 なら足を止める)
 *     wait   … 縁石で待っている
 */
function step(cfg, a, ctx){
  const near=ctx.near||[], move=ctx.move, rot=ctx.rot;
  // 1) 経路の向き (これまでどおりの「にんじん」)
  const gb=Math.atan2(a.gy-a.y, a.gx-a.x);
  let wx=Math.cos(gb)*cfg.goalGain, wy=Math.sin(gb)*cfg.goalGain;

  // 2) 人をよける
  const sep=separation(cfg, a, near);
  wx += sep.vx*cfg.sepGain; wy += sep.vy*cfg.sepGain;

  // 3) 寄り癖と譲り合い (向きを横にずらす)
  //    ★ よけ量は**経路方向から maxDev 以内**に抑える。抑えないと、混んだ場所で
  //      want が真横〜後ろを向き、そちらが壁だと「通れる向きが無い」になって
  //      足が止まる (実測: 286人中124人が速度0。全体の平均速度が 0.41 まで落ちた)。
  const bias=yieldBias(cfg, a, near);
  let want=Math.atan2(wy, wx) + bias*0.5;
  const dev=wrap(want-gb);
  if(Math.abs(dev)>cfg.maxDev) want=gb+Math.sign(dev)*cfg.maxDev;

  // 4) 前方が塞がっていたら、通れる向きの中でいちばん want に近いものへ
  if(!ctx.passable(a.x, a.y, want, move)){
    let bestTh=null, bestErr=Infinity;
    // 探索は広く取る。狭いと壁際で「どこにも行けない」が頻発する
    for(let k=1;k<=cfg.searchSteps;k++) for(const sgn of [-1,1]){
      const th2=want+sgn*k*rot;
      if(!ctx.passable(a.x, a.y, th2, move)) continue;
      const err=Math.abs(wrap(want-th2));
      if(err<bestErr){ bestErr=err; bestTh=th2; }
    }
    if(bestTh===null){
      // よけを諦めて**経路方向そのもの**で通れるなら、そちらを使う。
      //   よけは「余裕があるときの上乗せ」であって、通行を妨げてはいけない。
      if(ctx.passable(a.x, a.y, gb, move)) bestTh=gb;
      else {
        // 本当に全方位ふさがり。決定論で回頭 (毎tick揺れないように)
        return {th:a.th + ((a.aid.charCodeAt(0)&1)?-rot:rot), speed:0, why:'blocked',
                wait:false, ttc:1, crowdL:0, crowdR:0};
      }
    }
    want=bestTh;
  }

  // 5) 車。車道へ踏み出す一歩の前でだけ見る
  let wait=false, ttc=1;
  const stepAhead=move*1.5;
  const fx=a.x+Math.cos(want)*stepAhead, fy=a.y+Math.sin(want)*stepAhead;
  if(ctx.cars && ctx.cars.length && ctx.onRoadway && ctx.onRoadway(fx, fy)){
    const cc=carCheck(cfg, a, ctx.cars, stepAhead);
    ttc=Math.min(1, cc.ttc/(cfg.carTtc*2));
    wait=cc.wait;
  }

  // 6) 向きを want へ**少しずつ**寄せる。ここが「曲がりながら歩く」の正体。
  //    一気に向けると、その場で回ってから歩く従来の動きに戻ってしまう。
  const dth=wrap(want-a.th);
  const step=Math.min(Math.abs(dth), rot*cfg.turnRate)*Math.sign(dth);
  const th=a.th+step;

  // 7) 速度。前が詰まっているほど、大きく曲がるほど緩める。
  //    ★ ここは**街の速さそのもの**を決める。常時わずかに減速するだけでも、
  //      平均速度が 0.6 倍になって来店数が落ち、店の売上まで変わる。
  //      「たまに緩める」であって「いつも徐行」にはしないこと。
  let speed=1;
  if(sep.near<cfg.slowRange) speed=Math.min(speed, cfg.slowMin+(1-cfg.slowMin)*(sep.near/cfg.slowRange));
  if(sep.ahead>=cfg.slowAhead) speed=Math.min(speed, 0.85);
  // 曲がりの減速は「大きく曲がるとき」だけ。毎tickの微小な向き調整では緩めない
  const sharp=Math.max(0, Math.abs(dth)-cfg.turnFree)/Math.max(1e-6, Math.PI-cfg.turnFree);
  speed *= 1 - cfg.turnSlow*Math.min(1, sharp);
  if(wait) speed=0;

  // 左右の混み具合 (aux にも同じものを出す)
  let crowdL=0, crowdR=0;
  for(const o of near){
    const dx=o.x-a.x, dy=o.y-a.y, d=Math.hypot(dx,dy);
    if(d<1e-4||d>cfg.sepRange) continue;
    const b=wrap(Math.atan2(dy,dx)-a.th);
    if(Math.abs(b)>cfg.sepFov*0.5) continue;
    const w=1-d/cfg.sepRange;
    if(b<0) crowdL+=w; else crowdR+=w;
  }
  return {th, speed:Math.max(0,Math.min(1,speed)), wait, ttc,
          why: wait?'car':(speed<0.95?'slow':'go'),
          crowdL:Math.min(1,crowdL), crowdR:Math.min(1,crowdR)};
}

module.exports = { DEFAULTS, step, separation, yieldBias, carCheck };
