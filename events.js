// events.js — 住民の身に起きる「良いこと・悪いこと」。
//
// ── なぜ要るか ──
// 住民の内部状態 (お金・疲労・体調・退屈・追い詰められ度) は、これまで
// **規則的にしか動かなかった**。時間で溜まり、店で解消される。だから住民ごとの
// 差が「どの店が近いか」しか無く、見ていて物語が立ち上がらない。
// 外から不規則に揺さぶりを入れると、同じ生活の中に良い日と悪い日ができる。
//
// ── 病気との関係 ──
// 発症は元々 stepNeeds の中に**黙って**書かれていた (SICK_PROB、平均90分に1回、
// 疲労で2倍まで加速)。何の説明もなく体調が悪くなるので、視聴者からは「急に
// 病院へ歩き出した人」にしか見えない。ここに一本化して、
//   ・風邪をひいた / お腹を壊した / 転んで怪我をした
// という**原因のある出来事**として出す。発症率は元の実装に合わせてあるので、
// 病院の需要も街の育ち方も変わらない (tools/event-report.js で確認できる)。
//
// ── server.js から切り出す理由 ──
// pastime.js と同じ。一覧は「データ」なので、three も headless-gl も要らない
// ところに置いて、発生率と条件の偏りを単体で数えられるようにする。

'use strict';

// req … 起きるための条件
//   'job'    仕事を持っている      'nojob'  無職
//   'home'   自宅がある            'out'    屋外    'in' 屋内
//   'sick'   体調が悪い            'well'   体調は悪くない
//   'mate'   近くに誰か居る        'cash'   ある程度お金がある
//   'rain'   雨                    'fair'   雨でない
//   'morning' 朝(5-10時)           'night'  夜(20-5時)
// fx  … 効果。cash は所持金に対する割合 / cashFlat は絶対額
//   sick は [下限,上限] からの抽選。他は加算 (0-1 に丸められる)
// news… true なら見出しに出す (大きな出来事だけ)。false は会話ログのみ
// w   … 重み。**病気の 3 つは元の発症率に合わせて調整してある** (下の注記を参照)
const EVENTS = [
  // ── 悪いこと ────────────────────────────────────────────────────────────
  { id:'wallet_lost', good:false, icon:'👛', w:2, req:['cash'], news:true,
    ja:'財布を落とした', en:'lost their wallet',
    fx:{cash:-0.45, desper:+0.18} },
  { id:'phone_drop',  good:false, icon:'📱', w:2, req:[], news:false,
    ja:'携帯を落として画面を割った', en:'cracked their phone screen',
    fx:{cashFlat:-8, bored:+0.10} },
  { id:'scam',        good:false, icon:'🎣', w:1, req:['cash'], news:true,
    ja:'うまい話に引っかかった', en:'fell for a scam',
    fx:{cash:-0.55, desper:+0.25} },
  { id:'work_fail',   good:false, icon:'📉', w:3, req:['job'], news:false,
    ja:'仕事でしくじった', en:'messed up at work',
    fx:{desper:+0.20, bored:+0.12} },
  { id:'overslept',   good:false, icon:'⏰', w:2, req:['job','morning'], news:false,
    ja:'寝坊した', en:'overslept',
    fx:{desper:+0.12, fatigue:-0.10} },
  { id:'argument',    good:false, icon:'💢', w:2, req:['mate'], news:false,
    ja:'言い合いになった', en:'got into an argument',
    fx:{bored:+0.25, desper:+0.10} },
  { id:'lost_key',    good:false, icon:'🔑', w:2, req:['home'], news:false,
    ja:'家の鍵をなくした', en:'lost their house key',
    fx:{fatigue:+0.15, desper:+0.12} },
  { id:'bad_meal',    good:false, icon:'🥡', w:2, req:[], news:false,
    ja:'買った弁当が傷んでいた', en:'got a bad lunch',
    fx:{hunger:+0.30, cashFlat:-4} },
  { id:'closed_shop', good:false, icon:'🚫', w:2, req:['out'], news:false,
    ja:'行った店が閉まっていた', en:'found the shop closed',
    fx:{bored:+0.20, fatigue:+0.08} },
  { id:'soaked',      good:false, icon:'☔', w:3, req:['out','rain'], news:false,
    ja:'ずぶ濡れになった', en:'got soaked in the rain',
    fx:{fatigue:+0.20} },
  { id:'umbrella',    good:false, icon:'🌂', w:2, req:['rain'], news:false,
    ja:'傘が壊れた', en:'broke their umbrella',
    fx:{cashFlat:-5, bored:+0.10} },
  { id:'bike_flat',   good:false, icon:'🚲', w:2, req:['out'], news:false,
    ja:'自転車がパンクした', en:'got a flat tyre',
    fx:{fatigue:+0.18, cashFlat:-6} },
  { id:'stain',       good:false, icon:'🫗', w:2, req:[], news:false,
    ja:'服にコーヒーをこぼした', en:'spilled coffee on their clothes',
    fx:{bored:+0.12} },
  { id:'forgot',      good:false, icon:'🫥', w:2, req:[], news:false,
    ja:'約束を忘れていた', en:'forgot an appointment',
    fx:{desper:+0.10, bored:+0.15} },
  // ── 病気と怪我 ──────────────────────────────────────────────────────────
  //   ★ 重みは「イベント全体の 25%」になるよう決めてある。イベントが平均 25 分に
  //     1 回なら、病気は平均 100 分に 1 回 = 元の SICK_PROB (90分) とほぼ同じ。
  //     疲労が高いほど起きやすいのも元の実装と同じ (下の weightOf を参照)。
  { id:'cold',        good:false, icon:'🤧', w:5, req:['well'], news:false, sickly:true,
    ja:'風邪をひいた', en:'caught a cold',
    fx:{sick:[0.55,0.85]} },
  { id:'stomach',     good:false, icon:'🤢', w:4, req:['well'], news:false, sickly:true,
    ja:'お腹を壊した', en:'has an upset stomach',
    fx:{sick:[0.50,0.75], hunger:+0.15} },
  { id:'injury',      good:false, icon:'🩹', w:4, req:['well','out'], news:true, sickly:true,
    ja:'転んで怪我をした', en:'took a fall and got hurt',
    fx:{sick:[0.45,0.70], fatigue:+0.15} },

  // ── 良いこと ────────────────────────────────────────────────────────────
  { id:'found_coin',  good:true,  icon:'🪙', w:3, req:['out'], news:false,
    ja:'道で小銭を拾った', en:'found some coins on the street',
    fx:{cashFlat:+5} },
  { id:'work_win',    good:true,  icon:'📈', w:3, req:['job'], news:false,
    ja:'仕事がうまくいった', en:'had a good day at work',
    fx:{cashFlat:+8, desper:-0.25, bored:-0.15} },
  { id:'raise',       good:true,  icon:'💴', w:1, req:['job'], news:true,
    ja:'昇給した', en:'got a raise',
    fx:{cashFlat:+25, desper:-0.35} },
  { id:'bonus',       good:true,  icon:'🎁', w:1, req:[], news:true,
    ja:'臨時収入があった', en:'came into some extra money',
    fx:{cashFlat:+20, desper:-0.30} },
  { id:'praised',     good:true,  icon:'🌟', w:3, req:['job'], news:false,
    ja:'褒められた', en:'was praised',
    fx:{bored:-0.25, desper:-0.15} },
  { id:'found_thing', good:true,  icon:'🔎', w:2, req:[], news:false,
    ja:'探し物が出てきた', en:'found something they had lost',
    fx:{bored:-0.20, desper:-0.10} },
  { id:'good_sleep',  good:true,  icon:'🛌', w:3, req:['home'], news:false,
    ja:'ぐっすり眠れた', en:'slept really well',
    fx:{fatigue:-0.35} },
  { id:'recovered',   good:true,  icon:'💪', w:4, req:['sick'], news:false,
    ja:'体調が戻ってきた', en:'is feeling better',
    fx:{sickAdd:-0.35} },
  { id:'free_sample', good:true,  icon:'🍡', w:2, req:['out'], news:false,
    ja:'試食をもらった', en:'got a free sample',
    fx:{hunger:-0.25} },
  { id:'bargain',     good:true,  icon:'🏷', w:2, req:['out'], news:false,
    ja:'掘り出し物を見つけた', en:'found a bargain',
    fx:{supply:-0.30, bored:-0.12} },
  { id:'nice_walk',   good:true,  icon:'🌤', w:3, req:['out','fair'], news:false,
    ja:'気持ちよく歩けた', en:'had a pleasant walk',
    fx:{fatigue:-0.15, bored:-0.18} },
  { id:'helped',      good:true,  icon:'🤝', w:2, req:['mate'], news:false,
    ja:'人助けをした', en:'helped someone out',
    fx:{bored:-0.25, desper:-0.10} },
  { id:'reunion',     good:true,  icon:'👋', w:2, req:['mate'], news:false,
    ja:'久しぶりの人に会った', en:'ran into an old friend',
    fx:{bored:-0.30} },
  { id:'good_news',   good:true,  icon:'📬', w:2, req:[], news:false,
    ja:'いい知らせが届いた', en:'got some good news',
    fx:{bored:-0.22, desper:-0.15} },
  { id:'stars_night', good:true,  icon:'🌙', w:2, req:['out','night','fair'], news:false,
    ja:'きれいな月を見た', en:'saw a beautiful moon',
    fx:{bored:-0.20, fatigue:-0.08} },
  { id:'cat_met',     good:true,  icon:'🐈', w:2, req:['out'], news:false,
    ja:'猫になつかれた', en:'was befriended by a cat',
    fx:{bored:-0.28} },
  { id:'treated',     good:true,  icon:'🍮', w:2, req:['mate'], news:false,
    ja:'おごってもらった', en:'was treated to something',
    fx:{hunger:-0.20, cashFlat:+3, bored:-0.12} },
];

const byId = {};
for (const e of EVENTS) byId[e.id] = e;

/** 条件を満たすか。ctx は server.js が組む。 */
function ok(E, ctx) {
  for (const r of E.req) {
    if (r === 'job'     && !ctx.job) return false;
    if (r === 'nojob'   && ctx.job) return false;
    if (r === 'home'    && !ctx.home) return false;
    if (r === 'out'     && ctx.indoors) return false;
    if (r === 'in'      && !ctx.indoors) return false;
    if (r === 'sick'    && !ctx.sick) return false;
    if (r === 'well'    && ctx.sick) return false;
    if (r === 'mate'    && !ctx.mate) return false;
    if (r === 'cash'    && !ctx.cash) return false;
    if (r === 'rain'    && !ctx.raining) return false;
    if (r === 'fair'    && ctx.raining) return false;
    if (r === 'morning' && !(ctx.hour >= 5 && ctx.hour < 10)) return false;
    if (r === 'night'   && !(ctx.hour >= 20 || ctx.hour < 5)) return false;
  }
  return true;
}

/**
 * 重み。病気だけは**疲労が高いほど起きやすい**。
 * 元の実装 (SICK_PROB * (1+fatigue)) をそのまま引き継ぐ。
 */
function weightOf(E, ctx) {
  return E.sickly ? E.w * (1 + (ctx.fatigue || 0)) : E.w;
}

/** 条件を満たすものから重み付きで 1 つ選ぶ。 */
function pick(ctx, rnd) {
  const R = rnd || Math.random;
  let total = 0;
  const pool = [];
  for (const E of EVENTS) {
    if (!ok(E, ctx)) continue;
    const w = weightOf(E, ctx);
    total += w;
    pool.push([E, total]);
  }
  if (!total) return null;
  const t = R() * total;
  for (const [E, acc] of pool) if (t <= acc) return E;
  return pool[pool.length - 1][0];
}

const label = (E, ja) => (ja ? E.ja : E.en);

module.exports = { EVENTS, byId, ok, weightOf, pick, label };
