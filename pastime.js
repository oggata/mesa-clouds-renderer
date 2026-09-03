// pastime.js — 住民の「暇な時間」の過ごし方。
//
// ── なぜ要るか ──
// needOf() が null を返す時間 (病気でも眠くも空腹でもなく、勤務時間でもなく、
// 買い物も要らず、退屈も閾値未満) の住民は、ただ徘徊するだけだった。街の中で
// 一番よく起きている状態なのに、画としては**全員がひたすら歩いているだけ**になる。
//
// ここでは**建物も小物も一切増やさずに**娯楽を足す。表現の材料は既にあるものだけ:
//   ・その場に留まる    … 立ち話 (a.talk) と同じ仕組み。歩き続けないだけで画が変わる
//   ・会話ログの一言    … pushTalkLine
//   ・ニュースの見出し  … news()
//   ・住民一覧の説明文  … describeActivity
// 新しいメッシュもテクスチャも要らない。
//
// ── server.js から切り出す理由 ──
// world.js / traffic.js / skeleton.js と同じ。娯楽の一覧は「データ」なので、
// three も headless-gl も要らないところに置いて、単体で数えられるようにする
// (tools/pastime-report.js が種類・場所・人数の偏りを出す)。

'use strict';

// ja    … 一覧に出す短い名前 / jaIng … 「〜している」の自然な言い方
//         (「ラジオを聴く をしている」のような不自然な連結を避けるため両方持つ)
// where … 'home'=自宅の中 / 'out'=屋外 / 'any'=どちらでも
// group … 必要な人数 (1 = ひとりでできる)
// secs  … 続く長さの範囲 (実時間の秒)
// bored … 終えたときに退屈がどれだけ晴れるか (0-1)
// when  … 'day' / 'night' / null(いつでも)
// wx    … 'rain' なら雨の日だけ / 'fair' なら雨でない日だけ
const ACTS = [
  // ── ひとりで、どこでも ──────────────────────────────────────────────────
  { id:'reading',   ja:'読書', jaIng:'読書している',           en:'reading',            icon:'📖', where:'any',  group:1, secs:[25,70], bored:0.40,
    ja_l:['この本、面白いところまで来た','あと少しで読み終わる','栞をどこに挟んだっけ'],
    en_l:['Just got to the good part.','Almost finished this one.','Where did I leave my bookmark?'] },
  { id:'humming',   ja:'鼻歌', jaIng:'鼻歌を歌っている',           en:'humming',            icon:'🎵', where:'any',  group:1, secs:[15,35], bored:0.18,
    ja_l:['あの曲、なんだっけ','つい口ずさんじゃう'],
    en_l:['What was that song again?','It just gets stuck in my head.'] },
  { id:'stretch',   ja:'ストレッチ', jaIng:'ストレッチしている',      en:'stretching',         icon:'🤸', where:'any',  group:1, secs:[15,30], bored:0.15,
    ja_l:['肩が凝ったなあ','うーん、伸びる'],
    en_l:['My shoulders are stiff.','That feels better.'] },
  { id:'origami',   ja:'折り紙', jaIng:'折り紙を折っている',         en:'folding origami',    icon:'🦢', where:'any',  group:1, secs:[25,55], bored:0.32,
    ja_l:['鶴はやっぱり難しい','角がうまく合わない'],
    en_l:['Cranes are still hard.','The corners never line up.'] },
  { id:'doodle',    ja:'落書き', jaIng:'落書きしている',         en:'doodling',           icon:'✏️', where:'any',  group:1, secs:[20,50], bored:0.30,
    ja_l:['我ながらひどい絵だ','手が勝手に動く'],
    en_l:['This drawing is terrible.','My hand just wanders.'] },
  { id:'daydream',  ja:'ぼんやりする', jaIng:'ぼんやりしている',    en:'daydreaming',        icon:'💭', where:'any',  group:1, secs:[20,50], bored:0.20,
    ja_l:['……何を考えてたんだっけ','たまにはこういう時間もいい'],
    en_l:['...what was I thinking about?','Sometimes doing nothing is fine.'] },
  { id:'rainsound', ja:'雨音を聴く', jaIng:'雨音を聴いている',      en:'listening to the rain', icon:'🌧', where:'any', group:1, secs:[25,60], bored:0.30, wx:'rain',
    ja_l:['雨の音、嫌いじゃない','しばらく止みそうにないね'],
    en_l:["I don't mind the sound of rain.","Doesn't look like it'll stop soon."] },

  // ── ひとりで、自宅で ────────────────────────────────────────────────────
  { id:'homegame',  ja:'家でゲーム', jaIng:'家でゲームをしている',      en:'gaming at home',     icon:'🎮', where:'home', group:1, secs:[35,90], bored:0.55,
    ja_l:['あと1回だけ','ここのボスが倒せない','やめどきが分からない'],
    en_l:['Just one more round.','I cannot beat this boss.',"I can't find a stopping point."] },
  { id:'nap',       ja:'昼寝', jaIng:'昼寝している',           en:'napping',            icon:'😴', where:'home', group:1, secs:[30,70], bored:0.25,
    ja_l:['ちょっとだけ横になろう','うとうとしてた'],
    en_l:['Just lying down for a bit.','I must have dozed off.'] },
  { id:'cooking',   ja:'料理', jaIng:'料理している',           en:'cooking',            icon:'🍳', where:'home', group:1, secs:[30,70], bored:0.35,
    ja_l:['今日は多めに作ろう','味見しすぎた'],
    en_l:["I'll make extra today.",'I tasted it too many times.'] },
  { id:'tea',       ja:'お茶を淹れる', jaIng:'お茶を淹れている',    en:'making tea',         icon:'🍵', where:'home', group:1, secs:[15,35], bored:0.20,
    ja_l:['一杯目がいちばんうまい','蒸らしすぎたかな'],
    en_l:['The first cup is the best.','I think I steeped it too long.'] },
  { id:'tidy',      ja:'片づけ', jaIng:'片づけをしている',         en:'tidying up',         icon:'🧹', where:'home', group:1, secs:[25,60], bored:0.22,
    ja_l:['どこから手をつけようか','こんなの持ってたっけ'],
    en_l:['Where do I even start?','I forgot I owned this.'] },
  { id:'plants',    ja:'植木の世話', jaIng:'植木の世話をしている',      en:'tending the plants', icon:'🪴', where:'home', group:1, secs:[20,45], bored:0.28,
    ja_l:['ちょっと元気がないな','新しい芽が出てる'],
    en_l:['It looks a bit droopy.','There is a new shoot.'] },
  { id:'radio',     ja:'ラジオを聴く', jaIng:'ラジオを聴いている',    en:'listening to radio', icon:'📻', where:'home', group:1, secs:[30,70], bored:0.30,
    ja_l:['この時間の放送が好きなんだ','また同じ曲だ'],
    en_l:['I like this time slot.','They played this one already.'] },
  { id:'letter',    ja:'手紙を書く', jaIng:'手紙を書いている',      en:'writing a letter',   icon:'✉️', where:'home', group:1, secs:[30,65], bored:0.30,
    ja_l:['書き出しが決まらない','だいぶ長くなってしまった'],
    en_l:["I can't decide how to start.",'This got rather long.'] },
  { id:'diary',     ja:'日記をつける', jaIng:'日記をつけている',    en:'writing in a diary', icon:'📔', where:'home', group:1, secs:[20,45], bored:0.25,
    ja_l:['今日は何があったっけ','三日ぶりに書いた'],
    en_l:['What happened today again?','First entry in three days.'] },
  { id:'mending',   ja:'繕いもの', jaIng:'繕いものをしている',       en:'mending clothes',    icon:'🧵', where:'home', group:1, secs:[30,60], bored:0.26,
    ja_l:['ここがほつれてる','針に糸が通らない'],
    en_l:['This seam came apart.',"I can't thread the needle."] },
  { id:'bath',      ja:'長風呂', jaIng:'長風呂に浸かっている',         en:'a long bath',        icon:'🛁', where:'home', group:1, secs:[30,60], bored:0.32, when:'night',
    ja_l:['のぼせそう','今日はゆっくり浸かろう'],
    en_l:['I might be overheating.',"I'll soak for a while today."] },

  // ── ひとりで、屋外で ────────────────────────────────────────────────────
  { id:'watching',  ja:'人間観察', jaIng:'人間観察をしている',        en:'people watching',    icon:'👀', where:'out',  group:1, secs:[25,60], bored:0.30,
    ja_l:['みんな急いでるなあ','今の人、見たことある'],
    en_l:['Everyone is in a hurry.','I think I know that person.'] },
  { id:'sunbath',   ja:'日向ぼっこ', jaIng:'日向ぼっこをしている',      en:'sunbathing',         icon:'☀️', where:'out',  group:1, secs:[25,60], bored:0.28, when:'day', wx:'fair',
    ja_l:['いい日差しだ','ここが一番あたたかい'],
    en_l:['The sun feels good.','This is the warmest spot.'] },
  { id:'stars',     ja:'星を見る', jaIng:'星を眺めている',        en:'stargazing',         icon:'✨', where:'out',  group:1, secs:[25,60], bored:0.35, when:'night', wx:'fair',
    ja_l:['今日はよく見える','あれは何ていう星だろう'],
    en_l:['Good visibility tonight.','I wonder what that star is called.'] },
  { id:'clouds',    ja:'雲を数える', jaIng:'雲を数えている',      en:'counting clouds',    icon:'☁️', where:'out',  group:1, secs:[20,45], bored:0.22, when:'day',
    ja_l:['あれ、魚に見えない?','ぜんぶで七つ'],
    en_l:["Doesn't that one look like a fish?",'Seven of them, I think.'] },
  { id:'stroll',    ja:'散歩', jaIng:'散歩している',           en:'strolling',          icon:'🚶', where:'out',  group:1, secs:[30,80], bored:0.30, walk:true,
    ja_l:['どこへ行くでもなく歩く','この道、久しぶりだ'],
    en_l:['Walking with no destination.',"I haven't taken this street in a while."] },
  { id:'cat',       ja:'猫を探す', jaIng:'猫を探している',        en:'looking for the cat',icon:'🐈', where:'out',  group:1, secs:[25,60], bored:0.30, walk:true,
    ja_l:['この辺にいるはずなんだけど','昨日はここに座ってた'],
    en_l:['It should be around here.','It was sitting here yesterday.'] },
  { id:'whistle',   ja:'口笛の練習', jaIng:'口笛を練習している',      en:'practising whistling',icon:'🎶', where:'out',  group:1, secs:[15,35], bored:0.18,
    ja_l:['高い音が出ない','だいぶ様になってきた'],
    en_l:["I can't hit the high note.",'Getting better at this.'] },
  { id:'window',    ja:'ウィンドウショッピング', jaIng:'ウィンドウショッピングをしている', en:'window shopping', icon:'🛍', where:'out', group:1, secs:[25,55], bored:0.28, walk:true,
    ja_l:['見るだけ、見るだけ','これ、いくらするんだろう'],
    en_l:['Just looking, just looking.','I wonder how much this is.'] },

  // ── 誰かと ──────────────────────────────────────────────────────────────
  { id:'chatting',  ja:'おしゃべり', jaIng:'おしゃべりしている',      en:'chatting',           icon:'💬', where:'any',  group:2, secs:[25,60], bored:0.40, social:0.5,
    ja_l:['そういえば聞いた?','それでね、その後どうなったと思う?','話し込んじゃったね'],
    en_l:['Did you hear about it?','So then, guess what happened.','We really got talking.'] },
  { id:'cards',     ja:'トランプ', jaIng:'トランプをしている',        en:'playing cards',      icon:'🃏', where:'any',  group:2, secs:[35,80], bored:0.50, social:0.4,
    ja_l:['今の、無しね','よし、勝った','配り直そう'],
    en_l:["That one doesn't count.",'Ha, I win.',"Let's deal again."] },
  { id:'fortune',   ja:'占い', jaIng:'占いをしている',           en:'telling fortunes',   icon:'🔮', where:'any',  group:2, secs:[25,55], bored:0.38, social:0.4,
    ja_l:['今日の運勢、見てあげる','あんまり良くないかも','いいことありそうだよ'],
    en_l:["Let me read your fortune.","It's not looking great.",'Something good is coming.'] },
  { id:'shogi',     ja:'将棋', jaIng:'将棋を指している',           en:'playing shogi',      icon:'♟', where:'any',  group:2, secs:[40,90], bored:0.48, social:0.35,
    ja_l:['長考します','待った、今のは無し','参りました'],
    en_l:["I need to think.",'Wait, let me take that back.','I resign.'] },
  { id:'shiritori', ja:'しりとり', jaIng:'しりとりをしている',        en:'a word game',        icon:'🔤', where:'any',  group:2, secs:[20,45], bored:0.32, social:0.35,
    ja_l:['それ「ん」で終わってる','じゃあ……りんご','考え中'],
    en_l:['That ends with the wrong letter.','Apple, then.','Still thinking.'] },
  { id:'janken',    ja:'じゃんけん', jaIng:'じゃんけんをしている',      en:'rock paper scissors',icon:'✊', where:'any',  group:2, secs:[10,25], bored:0.15, social:0.3,
    ja_l:['三本勝負ね','あいこばっかりだ'],
    en_l:['Best of three.','We keep tying.'] },
  { id:'reminisce', ja:'思い出話', jaIng:'思い出話をしている',        en:'reminiscing',        icon:'🕰', where:'any',  group:2, secs:[30,65], bored:0.36, social:0.5,
    ja_l:['昔はこの辺、何も無かったね','よく覚えてるなあ'],
    en_l:['There was nothing here back then.','You remember that well.'] },
  { id:'advice',    ja:'相談ごと', jaIng:'相談にのっている',        en:'giving advice',      icon:'🫱', where:'any',  group:2, secs:[30,60], bored:0.30, social:0.55,
    ja_l:['ちょっと聞いてほしいんだけど','それは大変だったね'],
    en_l:['Can I run something by you?','That sounds rough.'] },
  { id:'gossip2',   ja:'噂話', jaIng:'噂話をしている',           en:'trading gossip',     icon:'🤫', where:'any',  group:2, secs:[20,45], bored:0.30, social:0.45,
    ja_l:['ここだけの話なんだけど','誰にも言わないでね'],
    en_l:['Just between us.',"Don't tell anyone."] },
];

const byId = {};
for (const a of ACTS) byId[a.id] = a;

/**
 * いま a が始められる娯楽の一覧。
 *   ctx = { hour, raining, indoors, atHome, mates }
 *     mates … 近くに居て、同じく暇な住民の数 (自分を含まない)
 */
function candidates(ctx) {
  const night = ctx.hour < 6 || ctx.hour >= 20;
  const out = [];
  for (const A of ACTS) {
    if (A.where === 'home' && !ctx.atHome) continue;
    if (A.where === 'out'  && ctx.indoors) continue;
    if (A.when === 'night' && !night) continue;
    if (A.when === 'day'   && night) continue;
    if (A.wx === 'rain' && !ctx.raining) continue;
    if (A.wx === 'fair' && ctx.raining) continue;
    if (A.group > 1 && ctx.mates < A.group - 1) continue;
    // 屋内では屋外向けの遊びをしない (雨音は屋内でも成立するので where:'any')
    out.push(A);
  }
  return out;
}

/** 候補から 1 つ選ぶ。ペルソナごとの偏りは持たせない (誰が何をしても良い街にする)。 */
function pick(ctx, rnd) {
  const c = candidates(ctx);
  if (!c.length) return null;
  return c[Math.floor((rnd || Math.random)() * c.length)];
}

/** 続く長さ (秒)。 */
function duration(A, rnd) {
  const r = (rnd || Math.random)();
  return A.secs[0] + r * (A.secs[1] - A.secs[0]);
}

/** 会話ログに流す一言 (表示言語ごと)。 */
function line(A, ja) {
  const arr = (ja ? A.ja_l : A.en_l) || [];
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

const label  = (A, ja) => (ja ? A.ja : A.en);
// 「〜している」の形。日本語は名詞と動詞句が混ざるので専用の言い方を持たせる。
const doing  = (A, ja) => (ja ? (A.jaIng || (A.ja + 'をしている')) : ('is ' + A.en));
const doingN = (A, ja, n) => ja ? doing(A, true) : ((n>1?'are ':'is ') + A.en);

module.exports = { ACTS, byId, candidates, pick, duration, line, label, doing, doingN };
