// economy.js — お金・仕事・追い詰められ度・犯罪。
//
// world.js (物理) / social.js (人間関係) と同じく、server.js のグローバルを
// 一切参照しない純粋なモジュール。呼ぶ側が ctx (コールバックの束) を渡す。
//
// ── なぜこの4つを1つにまとめるか ──
// 「悪い人」を出したいとき、犯罪だけを足すと**ただの飾り**になる。
// 犯罪が物語になるのは、それが何かの結果であり、同時に次の原因にもなるときだけ。
// そこで最小の因果の環を作る:
//
//     店に通う → 金を払う → 店の売上 → 給料 → 生活できる
//       ↑                                            ↓
//     店が潰れる ← 売上が減る ← 万引き ← 追い詰められる ← 失業・無一文
//
// 万引きされた店は売上が落ちて人を切る。切られた人がまた追い詰められる。
// **犯罪が失業を生み、失業が犯罪を生む**という環になっているので、
// 1件の閉店が街に波及していく。これがドラマの燃料になる。
//
// 逆に、環が閉じたままだと街が死ぬので、抜け道も用意する:
//   ・新しい店ができれば雇用が戻る (server.js の maybeFound)
//   ・視聴者の応援 (!cheer) や差し入れで追い詰められ度が下がる
//   ・疑い (wanted) は日が経てば薄れる

'use strict';

const DEFAULTS = Object.freeze({
  startCash:   40,     // 初期の手持ち
  wage:        12,     // 1日の給料 (職に就いている人)
  // 1日の固定支出 (家賃・光熱・日々の食費)。**これが無いと経済が成立しない**。
  //   最初に入れ忘れて回したところ、収入だけが積み上がって誰も困らず、
  //   失業しても生活が傾かないので犯罪が一度も起きなかった。
  //   出ていくものがあって初めて「職を失う」が意味を持つ。
  livingCost:  8,
  allowance:   10,     // 学生の仕送り (livingCost を少し上回る = 困窮しない)
  ownerShare:  0.35,   // 店主が売上から取るぶん
  // 欲求を満たすときの支払い。医療が一番高い = 病気は貧しい人ほど治せない
  price:       {eat:6, shop:8, fun:10, care:15},
  jobSearchDays: 3,    // 失業してから次の職に就けるまでの日数
  // 追い詰められ度。無職 + 無一文 + 欲求が高い、が重なるほど速く上がる
  desperGain:  0.30,
  desperEase:  0.40,   // 職か金が戻ったときに戻る速さ
  crimeMin:    0.45,   // これ未満なら誰も手を出さない
  stealShare:  0.6,    // スリで奪う割合
  wantedGain:  0.40,   // 犯行で上がる疑い
  wantedDecay: 0.82,   // 日次で薄れる
  caughtBase:  0.25,   // 見咎められる確率の下地 (wanted が高いほど上がる)
  jailDays:    1,      // 捕まってから戻るまで

  // ── 建物の収支 ──
  // これまで潰れるのは飲食/買い物/遊び/医療だけで、職場・住宅・公共施設は
  // **構造的に絶対潰れなかった**。本番でランドマークタワーが3本並んだのはこれが原因。
  // 大きい建物ほど維持費が高い、という一本の規則で全種類を扱う。
  // 収容力も維持費も「大きさ (footprint^2 x height)」に比例させる。
  //   こうしないとタワーは「ただの背の高いオフィス」で、定員も収支もオフィスと同じになり、
  //   人口500人の街にランドマークが3本建っていても誰も困らない (本番で起きた)。
  //   維持費は **定員の半分が埋まってようやく収支ゼロ** になるように決める:
  //     upkeepUnit = breakEven x capUnit x workerOutput
  capUnit:      2.5,   // 定員 = これ x footprint^2 x height
  breakEven:    0.5,   // 定員のこの割合が埋まって収支ゼロ
  upkeepUnit:   8.75,  // = breakEven x capUnit x workerOutput (下で使う値と合わせること)
  workerOutput: 7,     // 職場: 従業員1人が1日に生む価値
  rentPerHead:  5,     // 住宅: 住人1人あたりの家賃
  civicPerHead: 0.22,  // 公共施設: 人口1人あたりの税収 (街が支える)
  // 職場の詰まり具合。**1棟のオフィスビルには会社がいくつも入っている**という見立てで、
  //   大きさから出る定員をこの倍率で伸ばす (アルバイトを含めた頭数)。
  //   ★ 維持費も同じ倍率で伸ばすので、「定員の breakEven が埋まって収支ゼロ」という
  //     関係は変わらない。来客で稼ぐ店 (visit) と住宅には掛からない。
  workDensity:  5,
  balanceEma:   0.25,  // 収支の均し方
  bankruptDays: 5,     // 赤字が続いてこの日数で閉鎖
  oversizePenalty: 3.0,// 発展段階に対して大きすぎる建物の維持費の倍率
});

function createState(opts){
  return {
    cfg: Object.assign({}, DEFAULTS, opts||{}),
    stats: {paid:0, shoplifts:0, pickpockets:0, caught:0, jobsLost:0, jobsFound:0,
            wagesPaid:0, brokeVisits:0},
  };
}

// ── 住民1人ぶんの初期化 ────────────────────────────────────────────────────
function initAgent(S, a){
  if(a.cash==null)    a.cash = S.cfg.startCash*(0.6+Math.random()*0.8);
  if(a.desper==null)  a.desper = 0;
  if(a.wanted==null)  a.wanted = 0;
  // jobless は「職を失ってから何日目か」の待ち時間カウンタ。
  //   -1 = 待ちなし。まだ一度も就いていない人をここで 0 にすると、
  //   起動直後に全員が求職待ちになって誰も職に就けない (実際に踏んだ)。
  if(a.jobless==null) a.jobless = -1;
  if(a.crimes==null)  a.crimes = 0;
  if(a.jail==null)    a.jail = 0;
}

// 正直さ。personas.json の honesty (既定 0.6)。
// 同じ苦境でも人によって選ぶ道が違うから物語になる。
const honestyOf = a => (a.def && a.def.honesty!=null) ? a.def.honesty : 0.6;

const priceOf   = (S, kind) => S.cfg.price[kind] || 0;
const isBroke   = (S, a, kind) => a.cash < priceOf(S, kind);
// 実際に無職かどうかは「働く場所を持っているか」で決まる。
// a.jobless はあくまで再就職までの待ち時間なので、判定に使ってはいけない。
//   ★ 学生 (a.school) は「無職」ではない。通学が本業で、家から仕送りが出る。
//     ここを外すと、子どもが全員「無職・無一文」になって犯罪に走る
//     (実測: 28人の村で犯罪44件。学校を入れた直後に発生した)。
const isStudent = a => !!a.school;
const isJobless = a => !(a.work || a.owns || a.school);
const inJail    = a => a.jail > 0;

// ── 支払い ──────────────────────────────────────────────────────────────────
// 払えたら true。払えなければ false (呼ぶ側が「万引きするか」を判断する)。
function pay(S, a, kind){
  const p=priceOf(S, kind);
  if(p<=0) return true;
  if(a.cash < p){ S.stats.brokeVisits++; return false; }
  a.cash -= p;
  S.stats.paid++;
  return true;
}

// ── 犯行を決める ────────────────────────────────────────────────────────────
// 追い詰められ度が正直さを上回ったときだけ。ここが人物差になる。
//   Social Marco (honesty 0.8) は相当追い詰められないと手を出さない。
//   Night-shift Mika (0.35) は早い。
function willOffend(S, a){
  if(inJail(a)) return false;
  const d=a.desper||0;
  if(d < S.cfg.crimeMin) return false;
  return d > honestyOf(a);
}

// 見咎められたか。疑われている人ほど見られている。
function caught(S, a, rng){
  const p=Math.min(0.9, S.cfg.caughtBase + (a.wanted||0)*0.5);
  return (rng||Math.random)() < p;
}

// 犯行後の共通処理
function afterCrime(S, a){
  a.crimes=(a.crimes||0)+1;
  a.wanted=Math.min(1, (a.wanted||0)+S.cfg.wantedGain);
  // 手に入れたぶん、少しだけ楽になる (完全には晴れない)
  a.desper=Math.max(0, (a.desper||0)-0.18);
}

// 万引き: 払えないまま欲求を満たす。店の売上が減る。
function shoplift(S, a){
  S.stats.shoplifts++;
  afterCrime(S, a);
}

// スリ: 立ち話の相手から奪う。social.js の出会いに相乗りする。
function pickpocket(S, a, b){
  const take=Math.floor((b.cash||0)*S.cfg.stealShare);
  if(take<=0) return 0;
  b.cash-=take; a.cash+=take;
  S.stats.pickpockets++;
  afterCrime(S, a);
  return take;
}

function arrest(S, a){
  S.stats.caught++;
  a.jail=S.cfg.jailDays;
  a.cash=Math.floor((a.cash||0)*0.3);   // 手にしたものは取り上げられる
  a.wanted=Math.min(1, (a.wanted||0)+0.2);
}

// ── 日次 ────────────────────────────────────────────────────────────────────
// ctx:
//   agents
//   revenueOf(a)     その人の職場の売上 (店主なら自分の店)。null なら職場なし
//   drawWage(a, amt) 職場から給料を引く。実際に払えた額を返す
//   needLevel(a)     いま満たせていない欲求の強さ 0..1
//   onJobFound(a)    職に就いた
//   onDespair(a)     追い詰められ度が閾値を越えた瞬間 (1人1回)
function stepDay(S, ctx){
  const cfg=S.cfg;
  for(const a of ctx.agents){
    initAgent(S, a);
    if(a.jail>0){ a.jail--; continue; }

    // 家賃と日々の食費。職があってもぎりぎり、無ければ確実に減っていく。
    a.cash = Math.max(0, (a.cash||0) - cfg.livingCost);

    // 学生は仕送り。働いていないが困窮もしない。
    if(isStudent(a)){
      a.cash += cfg.allowance;
      a.desper = Math.max(0, (a.desper||0) - cfg.desperEase);
      a.wanted=(a.wanted||0)*cfg.wantedDecay;
      if(a.wanted<0.02) a.wanted=0;
      continue;
    }
    // 給料。職場の売上から出るので、売上が細いと満額もらえない。
    if(!isJobless(a)){
      const got=ctx.drawWage(a, cfg.wage);
      a.cash += got;
      S.stats.wagesPaid += got;
      // 満額もらえない職場が続くと、そこも危ない
      if(got < cfg.wage*0.5) a.desper=Math.min(1, (a.desper||0)+0.08);
    }else{
      a.jobless++;
    }

    // 追い詰められ度。**無職 + 無一文 + 欲求が高い** が重なったときだけ上がる。
    // どれか1つ欠けていれば下がる (一時的に金が無いだけでは犯罪に向かわない)。
    const broke = (a.cash||0) < cfg.price.eat;
    const need  = ctx.needLevel(a);
    const bad   = (isJobless(a)?1:0) + (broke?1:0) + (need>0.6?1:0);
    const was   = a.desper||0;
    if(bad>=2) a.desper=Math.min(1, was + cfg.desperGain*(bad/3));
    else       a.desper=Math.max(0, was - cfg.desperEase);
    if(was < cfg.crimeMin && a.desper >= cfg.crimeMin) ctx.onDespair(a);

    a.wanted=(a.wanted||0)*cfg.wantedDecay;
    if(a.wanted<0.02) a.wanted=0;
  }
}

// ── 建物の収支 ────────────────────────────────────────────────────────────
// 「大きい建物ほど維持費が高い / 使われているほど稼ぐ」という一本の規則。
// これがあると、人口に対して大きすぎる建物 (人口500人にランドマーク3本) は
// 自然に赤字になって潰れる。個別に上限を決めなくてよい。
//
// kind:
//   'visit' … 来客が払う (飲食/買い物/遊び/医療/観光/学び)。revenue は server 側が積む
//   'work'  … 職場。従業員が価値を生む
//   'home'  … 住宅。住人が家賃を払う
//   'civic' … 公共施設。人口に応じた税収で支えられる (人口が少ないと維持できない)
//   kind='work' だけは workDensity ぶん維持費も重くする (定員を伸ばしたぶん)。
//   これを掛けないとオフィスは頭数だけ5倍になって無条件に黒字になる。
function upkeepOf(S, size, kind){
  const u = S.cfg.upkeepUnit * size;
  return kind==='work' ? u * S.cfg.workDensity : u;
}
// 建物の収容力 (職場なら定員、住宅なら世帯数)。大きいほど多く入るが、
// 埋まらなければそのぶん維持費が重くのしかかる。
const capacityOf = (S, size) => Math.max(1, Math.round(S.cfg.capUnit * size));
// 職場の定員。大きさぶんの定員 x workDensity。
const workCapacityOf = (S, size) =>
  Math.max(1, Math.round(S.cfg.capUnit * S.cfg.workDensity * size));

function buildingIncome(S, kind, st, ctx){
  // **収入は定員で頭打ち**にする。定員を超えて詰め込まれた人数まで数えると、
  // 人口が多い街ではどんな大きさの建物も黒字になり、大きすぎる建物が
  // いつまでも潰れない (実測: 1000人の街にタワーが10本残った)。
  // ★ 定員は **server 側が持っているものを使う**。以前ここで独自に capacityOf を
  //   呼んでいたので、server が「住宅1棟12人」に変えたあとも収入は4人ぶんで
  //   頭打ちになっていた。二重管理をやめ、ctx 経由で受け取る。
  const cap = kind==='work' ? (ctx.workCapAt ? ctx.workCapAt(st) : workCapacityOf(S, ctx.sizeOf(st)))
            : kind==='home' ? (ctx.homeCapAt ? ctx.homeCapAt(st) : capacityOf(S, ctx.sizeOf(st)))
            : capacityOf(S, ctx.sizeOf(st));
  switch(kind){
    case 'work':  return Math.min(ctx.workersAt(st)||0, cap) * S.cfg.workerOutput;
    case 'home':  return Math.min(ctx.residentsAt(st)||0, cap) * S.cfg.rentPerHead;
    // 公共施設は街の税収で支えられる。**軒数で分け合う**ので、
    // 人口に対して多すぎれば全部が赤字に寄っていく。
    case 'civic': return (ctx.population||0) * S.cfg.civicPerHead / (ctx.civicShare||1);
    default:      return st.revenue||0;      // visit: 支払いの積み上がり
  }
}

// 1棟ぶんの日次決算。閉鎖すべきなら true を返す (実際に閉じるのは server 側)。
function settleBuilding(S, st, ctx){
  const cfg=S.cfg;
  const kind=ctx.kindOf(st);
  const income=buildingIncome(S, kind, st, ctx);
  // 街の発展段階に対して**大きすぎる**建物は、維持費が重くのしかかる。
  //   集落にランドマークタワーが建っていても採算が合わないのは当たり前で、
  //   これを入れないと「昔の生成で建った巨大な建物」が永久に残る。
  let upkeep=upkeepOf(S, ctx.sizeOf(st), kind);
  if(ctx.oversized && ctx.oversized(st)) upkeep *= S.cfg.oversizePenalty;
  const net=income-upkeep;
  st.balance = (st.balance==null) ? net : st.balance*(1-cfg.balanceEma) + net*cfg.balanceEma;
  if(kind!=='work' && kind!=='home' && kind!=='civic') st.revenue=0;   // 来客ぶんは締める
  if(st.balance < 0) st.redDays=(st.redDays||0)+1;
  else st.redDays=0;
  return st.redDays >= cfg.bankruptDays;
}

// 街の不穏さ 0..1。追い詰められている住民の割合。
function unrest(S, agents){
  if(!agents.length) return 0;
  let n=0;
  for(const a of agents) if((a.desper||0)>=S.cfg.crimeMin) n++;
  return n/agents.length;
}

// 「いま一番危ない住民」。配信で追いかける対象を選ぶのに使う。
function mostDesperate(agents, n){
  return agents.filter(a=>(a.desper||0)>0.3)
    .sort((x,y)=>(y.desper||0)-(x.desper||0)).slice(0, n||1);
}

// ── 保存 / 復元 ─────────────────────────────────────────────────────────────
function serializeAgent(a){
  if(a.cash==null) return undefined;
  const o={c:Math.round(a.cash)};
  if(a.desper>0.02) o.d=+a.desper.toFixed(2);
  if(a.wanted>0.02) o.w=+a.wanted.toFixed(2);
  if(a.crimes)      o.n=a.crimes;
  if(a.jobless>=0)  o.j=a.jobless;
  if(a.jail>0)      o.p=a.jail;
  return o;
}
function restoreAgent(a, sv){
  if(!sv) return;
  a.cash=+sv.c||0; a.desper=+sv.d||0; a.wanted=+sv.w||0;
  a.crimes=+sv.n||0; a.jobless=(sv.j==null?-1:+sv.j); a.jail=+sv.p||0;
}

module.exports = {
  DEFAULTS, createState, initAgent,
  honestyOf, priceOf, isBroke, isJobless, isStudent, inJail, pay,
  willOffend, caught, shoplift, pickpocket, arrest,
  stepDay, unrest, mostDesperate,
  upkeepOf, capacityOf, workCapacityOf, buildingIncome, settleBuilding,
  serializeAgent, restoreAgent,
};
