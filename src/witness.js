// witness.js — 「街の誰が、何を見たか」の台帳。
//
// ── なぜ要るか ──
// 街ではすでに犯行が起きている (economy.js の万引き/スリ)。だがログに残るのは
// **神の視点の1行**だけで、「誰が見たか」も「どこまで見えたか」も残っていない。
// 全知の記録が1本あるだけの世界では、謎は成立しない。謎とは出来事そのものではなく、
// **起きたことと、街の誰かが知っていることの差**だからだ。
//
// ここは犯行の瞬間に居合わせた住民から「部分的な観測」を作って積む。
//   ・近い / 明るい / 顔見知り  → 名前まで分かる
//   ・少し離れている            → 「赤っぽい服の若い男」
//   ・遠い / 夜 / 雨            → 「誰かが近くにいた」だけ
//   ・それ以下                  → 何も残らない
//
// ── 証言は曖昧になるが、嘘はつかない ──
// 見間違いを入れると、証言から犯人を絞る手続きが**原理的に不公平**になる
// (どの証言を信じるかを外から決めるしかなくなる)。ここでは常に真実の部分集合を返し、
// 揺らぐのは「どこまで見えたか」だけにする。食い違いは矛盾ではなく粒度の差になる。
//
// ── 持たないもの ──
// 建物の名前も住民の内部状態も知らない。呼ぶ側 (server.js) が
//   look = 見た目 / cond = 見え方の条件 / act = 何をしていたか
// の3つだけ渡す。events.js や chronicle.js と同じく three にも MAP にも依存しない。

'use strict';

const DEFAULTS = Object.freeze({
  cap:        64,    // 台帳に残す事件の数 (輪バッファ)
  maxSeen:    4,     // 1件につき何人ぶんの証言を残すか (近い順)
  range:      9,     // 何セル先まで見えうるか。これを超えたら証言は立たない
  darkMul:    0.35,  // 真夜中の見え方 (昼を 1 とする)
  rainMul:    0.75,  // 雨
  indoorMul:  1.25,  // 屋内 = 至近距離。ただし 1 で頭打ち
  jitter:     0.18,  // 見え方のゆらぎ (±)。**証言が揃うと謎にならない**ので必ず要る
  // 証言の段階。q (見え方 0..1) がどこを超えたか
  qName:      0.70,  // これ以上 かつ 顔見知りなら名前が出る
  qFace:      0.70,  // 顔まで見えた (面通しできる)
  qLook:      0.45,  // 人相 (服の色・性別・年代)
  qGlimpse:   0.20,  // 気配だけ (行為は見ていない)
  knownName:  0.35,  // 名前が出るのに必要な「顔見知り度」(social.js の親しさ)
  // ── 時刻の幅 ──
  // 「何時ごろ見たか」もぼやける。よく見えていた人ほど時刻も正確。
  //   ★ これが消去法の効きを決める。時刻が一点に定まると、その一瞬だけ
  //     裏を取れない人が容疑者に残り、毎回1人まで絞れて謎にならない。
  //     幅があると「その幅ぜんぶを裏付けられた人」しか消えないので、
  //     容疑者が数人残る = 聞き込みの余地ができる。
  slackName:  0,     // 名前まで分かる証言の時刻の幅 (±スロット)
  slackLook:  1,
  slackGlimpse: 3,
});

// ── 乱数 ────────────────────────────────────────────────────────────────────
// 既定は Math.random。**シミュレーションから使うときは setRng(RNG.R) で差し替える。**
//   ★ ここを差し替え忘れていたせいで、他を全部決定的にしても再現できなかった。
//     しかも症状が厄介で、証言の「見え方のゆらぎ」だけがずれるため、
//     住民の位置も所持金も人間関係も**完全に一致したまま**、来歴の件数だけが
//     食い違う。世界は同じに見えるのに再生すると別物、という形になる。
//     (tools/determinism-check.js の部位別の指紋で chron だけが違って発覚した。)
let _rnd = Math.random;
const setRng = fn => { _rnd = fn || Math.random; };

// ── 見た目を言葉にする ──────────────────────────────────────────────────────
// 服の色。0xRRGGBB から色相を出して名前にする。彩度が低ければ白黒灰。
//   「赤い/緑の」と活用を分けると色ごとに例外が要るので、**すべて「〜っぽい」**で
//   受ける。曖昧な目撃証言の語り口としてもこれが正しい。
const HUE_NAMES = [
  [ 16, 'red',       '赤'],
  [ 45, 'orange',    'オレンジ'],
  [ 68, 'yellow',    '黄'],
  [150, 'green',     '緑'],
  [196, 'teal',      '水色'],
  [258, 'blue',      '青'],
  [300, 'purple',    '紫'],
  [335, 'pink',      'ピンク'],
  [361, 'red',       '赤'],
];
function colorOf(hex){
  // ★ 色は数値でも "#e14747" でも受ける。persona_pool.json は文字列で持っていて、
  //   server.js が読み込み時に数値へ直している。ここで受けを広げておかないと、
  //   プールを直接読んだ道具 (tools/witness-report.js) では全員の服が「黒」になり、
  //   証言が一切絞り込まなくなる — しかもエラーは出ないので気づけない。
  if(typeof hex!=='number') hex=parseInt(String(hex||'').replace('#',''),16)||0;
  const r=((hex>>16)&255)/255, g=((hex>>8)&255)/255, b=(hex&255)/255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn, l=(mx+mn)/2;
  if(d < 0.12) return l>0.72 ? {key:'white', en:'white', ja:'白'}
             : l<0.22 ? {key:'black', en:'black', ja:'黒'}
             :          {key:'grey',  en:'grey',  ja:'灰色'};
  let h = mx===r ? ((g-b)/d)%6 : mx===g ? (b-r)/d+2 : (r-g)/d+4;
  h=(h*60+360)%360;
  for(const [lim, en, ja] of HUE_NAMES) if(h < lim) return {key:en, en, ja};
  return {key:'red', en:'red', ja:'赤'};
}

// 年代。犯人像を「若い男」まで絞れるかどうかがここで決まる。
function ageBand(age){
  if(age==null)  return null;
  if(age <= 17)  return {key:'kid',    en:'young',       ja:'子ども'};
  if(age <= 29)  return {key:'young',  en:'young',       ja:'若い'};
  if(age <= 49)  return {key:'middle', en:'middle-aged', ja:'中年の'};
  return           {key:'old',    en:'older',       ja:'年配の'};
}

// 髪の色。skeleton.js の HAIR_TONES と同じ並び (黒 / 焦茶 / 茶 / 白髪)。
//   白髪だけは遠目にも効くので、これが取れると容疑者がぐっと減る。
const HAIR_JA = ['黒髪', '焦茶の髪', '茶髪', '白髪'];
const HAIR_EN = ['dark-haired', 'brown-haired', 'light-haired', 'grey-haired'];

const GENDER_JA = {m:'男', f:'女'};
const GENDER_EN = {m:'man', f:'woman'};

/** 人相を1行にする。traits が薄いほど短くなる = そのまま曖昧さになる。 */
function describe(t, ja){
  if(!t) return ja ? '誰か' : 'someone';
  const col = t.color ? (ja ? `${t.colorJa}っぽい服の` : `in ${t.color} `) : '';
  const hair= (t.hair!=null) ? (ja ? `${HAIR_JA[t.hair]}で` : `${HAIR_EN[t.hair]} `) : '';
  if(!t.gender) return ja ? `${hair}${col}誰か` : `someone ${hair}${col}`.trim();
  const age = t.ageJa ? (ja ? t.ageJa : t.ageEn+' ') : '';
  return ja ? `${hair}${col}${age}${GENDER_JA[t.gender]||'人'}`
            : `a ${col}${age}${hair}${GENDER_EN[t.gender]||'person'}`.replace(/\s+/g,' ').trim();
}

// ── 見え方 ──────────────────────────────────────────────────────────────────
const cl01 = v => v<0 ? 0 : v>1 ? 1 : v;

/**
 * どれだけ見えたか 0..1。
 *   cond = {dist, light, rain, indoors}
 *     dist   … 目撃者との距離 (セル)
 *     light  … 明るさ 0..1 (server の daylight())
 *     rain   … 雨か
 *     indoors… 同じ建物の中か
 */
function quality(S, cond, rng){
  const c=S.cfg;
  let q = 1 - (Math.max(0, cond.dist||0) / c.range);
  if(q <= 0) return 0;
  q *= c.darkMul + (1-c.darkMul)*cl01(cond.light==null ? 1 : cond.light);
  if(cond.rain)    q *= c.rainMul;
  if(cond.indoors) q  = Math.min(1, q*c.indoorMul);
  q *= 1 + ((rng||_rnd)()*2-1)*c.jitter;
  return cl01(q);
}

/**
 * 目撃を1件つくる。見えなかったら null。
 *   look = {aid, name, color, hair, gender, age}   犯人の見た目 (真実)
 *   cond = 上記 + {known: 目撃者が犯人をどれだけ知っているか 0..1}
 * 返るのは **真実の部分集合**。level が下がるほど項目が落ちるだけで、嘘は混ざらない。
 */
function sight(S, look, cond, rng){
  const c=S.cfg;
  const q=quality(S, cond, rng);
  if(q < c.qGlimpse) return null;

  const col=colorOf(look.color||0), band=ageBand(look.age);
  const t={color:col.en, colorJa:col.ja};
  let level='glimpse';

  if(q >= c.qLook){
    level='look';
    if(look.gender) t.gender=look.gender;
    if(band){ t.age=band.key; t.ageJa=band.ja; t.ageEn=band.en; }
  }
  if(q >= c.qFace){
    level='face';                       // 顔まで見た = 面通しできる
    if(look.hair!=null) t.hair=look.hair;
  }
  if(q >= c.qName && (cond.known||0) >= c.knownName) level='name';

  // 時刻の確かさ。±slack スロットの幅で「何時ごろ」を証言する。
  const slack = (level==='name'||level==='face') ? c.slackName
              : level==='look' ? c.slackLook : c.slackGlimpse;

  return {
    aid: null,                          // 目撃者。record() で server が入れる
    q: +q.toFixed(2), level, slack,
    // 名前が出る証言だけ、犯人の名が証言そのものに載る。
    // それ以外は **台帳の真相 (inc.culprit) を見ないと誰か分からない**。
    named: level==='name' ? look.name : null,
    traits: t,
    // glimpse は「行為」を見ていない。居合わせただけ。
    // ここが効く: 気配の証言は犯人を指さないが、**その場に誰が居たか**は絞れる。
    sawAct: level!=='glimpse',
  };
}

/**
 * 疑いようのない目撃。被害者本人のように、向き合っていて相手も知っている場合に使う。
 * 見え方の抽選を通さず q=1 / 名前まで分かる証言をそのまま作る。
 */
function eyewitness(look){
  const col=colorOf(look.color||0), band=ageBand(look.age);
  const t={color:col.en, colorJa:col.ja, hair:look.hair};
  if(look.gender) t.gender=look.gender;
  if(band){ t.age=band.key; t.ageJa=band.ja; t.ageEn=band.en; }
  return {aid:null, q:1, level:'name', slack:0, named:look.name, traits:t, sawAct:true};
}

/**
 * 証言を突き合わせて「事件はいつだったか」の幅を出す。
 * 全員が真実のスロットを中心に幅を持って証言するので、**一番よく見た人の幅**が残る。
 * 目撃者が居なければ null (時刻が分からない = アリバイで消せない)。
 */
function timeWindow(inc){
  // ★ 事件が自前の幅を持っているならそちらが優先。殺人の「死亡推定時刻」が
  //   これで、証言からではなく **死体から** 出てくる。目撃者が一人も居ない
  //   事件でも、時刻の幅さえあればアリバイで消去できる。
  if(inc.window) return inc.window;
  if(inc.slot==null || inc.slot<0) return null;
  let slack=null;
  for(const s of (inc.seen||[])){
    const k=(s.slack==null) ? DEFAULTS.slackGlimpse : s.slack;
    if(slack==null || k<slack) slack=k;
  }
  if(slack==null) return null;
  return {from:inc.slot-slack, to:inc.slot+slack, slack};
}

// ── 台帳 ────────────────────────────────────────────────────────────────────
function createState(opts){
  return {
    cfg: Object.assign({}, DEFAULTS, opts||{}),
    log: [], seq: 0,
    stats: {incidents:0, sightings:0, unseen:0,
            byLevel:{name:0, face:0, look:0, glimpse:0}},
  };
}

/**
 * 事件を1件積む。
 *   inc = {day, hour, kind, at:[r,c], place, indoors, night, rain,
 *          culprit:{aid,name}, victim:{aid,name}|null, amount,
 *          act:{ja,en}, seen:[...]}
 * seen は sight() の戻りに目撃者の {aid,name} を足したもの。近い順に maxSeen 件。
 */
function record(S, inc){
  const c=S.cfg;
  inc.id = 'inc'+(++S.seq);
  inc.seen = (inc.seen||[]).slice(0, c.maxSeen);
  S.stats.incidents++;
  if(!inc.seen.length) S.stats.unseen++;
  for(const s of inc.seen){
    S.stats.sightings++;
    S.stats.byLevel[s.level] = (S.stats.byLevel[s.level]||0)+1;
  }
  S.log.push(inc);
  while(S.log.length > c.cap) S.log.shift();
  return inc;
}

/** 一番よく見えていた証言。無ければ null。 */
const bestSight = inc => (inc.seen||[]).reduce((b,s)=>(!b||s.q>b.q)?s:b, null);

/** 犯人の名前が街に出ているか (= 誰の仕業か知られているか)。 */
const isSolved = inc => (inc.seen||[]).some(s=>s.level==='name');

/**
 * 街から見える形。**真相 (culprit) を落とす。**
 * これが台帳の要で、事件そのものと「街が知っていること」を分けている。
 * 推理する側にはこちらだけを渡す。
 */
function publicView(inc){
  const {culprit, ...rest} = inc;
  return {...rest, seen:(inc.seen||[]).map(s=>({...s}))};
}

/** 証言を1行にする。 */
function line(inc, s, ja){
  const who = s.level==='name' ? s.named : describe(s.traits, ja);
  const act = (inc.act && (ja ? inc.act.ja : inc.act.en)) || (ja?'何かしていた':'was up to something');
  if(!s.sawAct)
    return ja ? `そのとき ${who} が近くにいた` : `${who} was nearby at the time`;
  return ja ? `${who} が ${act}` : `${who} ${act}`;
}

// ── 推理の原始 ──────────────────────────────────────────────────────────────
// ここから先 (探偵) はまだ無い。ただし台帳が「読めるだけ」で終わらないよう、
// **証言と人物を突き合わせる手続き**だけは置いておく。これが無いと台詞の山になる。

/** 人相 traits にこの人物が当てはまるか。証言は真実の部分集合なので、無い項目は不問。 */
function fits(t, look){
  if(!t) return true;
  if(t.color  && colorOf(look.color||0).en !== t.color) return false;
  if(t.gender && look.gender !== t.gender) return false;
  if(t.age){ const b=ageBand(look.age); if(!b || b.key !== t.age) return false; }
  if(t.hair!=null && look.hair !== t.hair) return false;
  return true;
}

/**
 * 証言だけで容疑者を絞る。looks = 街の全員の見た目。
 * 戻り値 = すべての証言に当てはまる人物の配列。
 *   1人に絞れたら「証言だけで解ける」= 謎として易しすぎる。
 *   0人なら証言が食い違っている (いまの実装では起きない)。
 *   3〜8人くらいが、聞き込みで潰していく余地がある良い幅。
 */
function narrow(inc, looks){
  let pool=looks;
  for(const s of (inc.seen||[])){
    if(s.level==='name'){ pool=pool.filter(l=>l.name===s.named); continue; }
    pool=pool.filter(l=>fits(s.traits, l));
  }
  return pool;
}

// ── 保存 / 復元 ─────────────────────────────────────────────────────────────
// 事件は稀にしか起きない。再起動で消えると、材料が貯まる前に毎回ゼロに戻る。
const serialize = S => ({seq:S.seq, log:S.log.slice(-S.cfg.cap)});
function restore(S, sv){
  if(!sv || !Array.isArray(sv.log)) return 0;
  S.seq=+sv.seq||0;
  S.log=sv.log.slice(-S.cfg.cap);
  // ★ 集計は台帳から数え直す。ここを飛ばすと「台帳に64件あるのに incidents=6」に
  //   なって数字が読めなくなる (実際にそうなった)。起動前の累計は保存していないので、
  //   復元後の stats は **いま台帳に残っているぶん** の集計になる。
  const st={incidents:0, sightings:0, unseen:0, byLevel:{name:0, face:0, look:0, glimpse:0}};
  for(const inc of S.log){
    st.incidents++;
    if(!(inc.seen||[]).length) st.unseen++;
    for(const g of (inc.seen||[])){ st.sightings++; st.byLevel[g.level]=(st.byLevel[g.level]||0)+1; }
  }
  S.stats=st;
  return S.log.length;
}

module.exports = {
  DEFAULTS, createState, setRng,
  colorOf, ageBand, describe, quality, sight, eyewitness, timeWindow,
  record, bestSight, isSolved, publicView, line,
  fits, narrow,
  serialize, restore,
  HAIR_JA, HAIR_EN,
};
