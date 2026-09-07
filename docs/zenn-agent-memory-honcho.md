---
title: "街のNPC20人に「記憶」を持たせたい — エージェントメモリの選定と、HonchoがRAGと何が違うのか"
emoji: "🧠"
type: "tech"
topics: ["ai", "llm", "rag", "シミュレーション", "個人開発"]
published: false
---

24時間配信している街のシミュレーション（[MESA](https://github.com/oggata/mesa-clouds-renderer)）には、住民が100人います。それぞれが店に通い、友達になり、金を貸し、険悪になる。その出来事は `chronicle.js` に「来歴」として溜まっていきます。

ただし、**溜まった端から捨てています**。

```js
const CAP      = 24;   // ふつうの出来事をいくつ覚えるか
const MARK_CAP = 8;    // 節目 (誕生・起業・就職など) をいくつ覚えるか
```

住民1人あたり24件の輪バッファ。古いものから押し出されて消えます。節目だけ別枠で8件残しますが、それだけです。

この「捨てている分」を、消すのではなく**人物像に畳み込めないか**というのが今回のテーマです。エージェントメモリという領域を調べて、[Honcho](https://honcho.dev) というサービスに行き着き、MESAへの実装方法まで設計しました。

先に断っておくと、**この記事は設計と選定までです**。実際に20人ぶん流して計測したところまでは行っていません。前回の記事（[ホテリングの法則の実装](https://zenn.dev/oggata)）で「最初に出した数字は誤読でした」と書いた身としては、動かす前の話と動かした後の話は分けておきたいので、そこは明示します。

---

## 1. なぜ捨てているのか

まず現状の確認です。MESAの住民は2種類の記憶を持っています。

**数値の記憶**は残ります。`social.js` が関係値を持っていて、これは減衰こそすれ消えません。

```js
function relOf(a, bid)    { return (a.rel && a.rel[bid]) ? a.rel[bid].s : 0; }
function grudgeOf(a, bid) { return (a.rel && a.rel[bid]) ? (a.rel[bid].g||0) : 0; }
```

**言葉の記憶**が消えます。`chronicle.js` の `push()` に流れ込むのがそれです。

```js
function push(a, e) {
  if (e.mark) {
    (a.marks || (a.marks = [])).push(e);
    while (a.marks.length > MARK_CAP) a.marks.shift();
    return;
  }
  (a.log || (a.log = [])).push(e);
  while (a.log.length > CAP) a.log.shift();   // ← ここで落ちる
}
```

なぜ上限があるかは、ファイル冒頭のコメントに自分で書いていました。

> 住民は最大 1000 人。全員の全履歴を持つと保存ファイルが際限なく膨らむので、1人 CAP 件の輪バッファにする。

妥当な判断ではあります。ただ結果として、視聴者が `!story ミカ` と打ったときに返るのは**直近6件の箇条書き**だけになります。

```
Day41 🍻 タロウと居酒屋へ飲みに行った
Day43 💸 ハナに 120 貸した
Day44 🤝 ケンと友達になった
```

事実の羅列であって、**その人がどういう人かは分かりません**。300日生きた住民も、41日目の住民も、見た目は同じ6行です。

## 2. エージェントメモリの必要性

「全部コンテキストに入れればいいのでは」から始めるのが素直だと思うので、そこから潰します。

**理由1: 量が持たない。**
100人 × 数百日ぶんの出来事は、LLMのコンテキストには入りません。入ったとしても毎回全部送るのは非現実的です。

**理由2: 検索では届かない。**
ここが本質的なところです。ベクタ検索で「ミカ」の記録を引くことはできます。でも欲しいのは、

> ミカは人と食事をしたがっているが、誘い方を知らない

みたいな一文です。これは**どのログにも書かれていません**。「居酒屋に一人で入った」「タロウの近くをうろついた」「誘われたら必ず行った」という個別の記録から**導出される**ものです。検索は、書かれていないものを返せません。

**理由3: 関係が非対称である。**
`a.rel[bid]` は数値ひとつなので、「ミカが見たタロウ」と「ハナが見たタロウ」が同じ構造しか持てません。人間の記憶はそうではなくて、同じ人物について全く違う像を持ちます。

この3つを引き受けるのが「エージェントメモリ」と呼ばれるレイヤーです。

## 3. Honchoとは何か

[Honcho](https://honcho.dev) は Plastic Labs が作っているエージェント向けメモリ基盤です。OSS（[plastic-labs/honcho](https://github.com/plastic-labs/honcho)）とマネージドサービスの両方があります。

面白いのは出自で、彼らはもともと **Bloom というAI家庭教師**を作っていました。「生徒ごとに違うつまずき方を、週をまたいで覚えていられない」という具体的な困りごとが起点になっています。汎用の記憶DBを作ろうとして生まれたのではない、というのは設計を読むときに効いてきます。

### 4つのプリミティブ

| | 何か |
|---|---|
| **Workspace** | アプリや環境を分離する最上位コンテナ |
| **Peer** | 時間とともに変化しながら存続する主体（ユーザー、エージェント、モノ） |
| **Session** | peer 同士のやりとりのスレッド。時間的な境界を持つ |
| **Message** | 推論のトリガーとなるデータ単位（会話、イベント、文書） |

**peer と session が多対多**なのがポイントです。多くのメモリ層は「ユーザー1人 vs アシスタント1体」を前提に作られていますが、Honcho はそこを制約にしていません。

そして peer ごとに**自分の観測に由来する結論しか見えません**。「ミカが知っているタロウ」と「ハナが知っているタロウ」がデータモデルのレベルで別物になる、というのは理由3への直接の答えです。

### 内部の構造

プロセスは2つ、Postgres と Redis を共有します。

```
[API server]      HTTP を受ける + Dialectic エージェントをインラインで実行
[Deriver worker]  キューから Deriver / Summarizer / Dreamer を回す
```

メッセージを書くと、3つのパイプラインが**非同期で**走ります。

- **Deriver** — メッセージから conclusion（結論）を抽出する。明示的な発言と、そこからの直接的な演繹
- **Summarizer** — セッションのローリング要約を維持する
- **Dreamer** — スケジュール実行。冗長・陳腐化した結論を削除し、メッセージ横断のパターンを引いて peer の要約を更新する

読み出しは **Dialectic エンドポイント**です。単なる検索ではなく、エージェントが結論を意味検索し、根拠になったメッセージを引き、結論を前提まで遡ってから合成します。当然遅い。ドキュメントも「レイテンシは増えるが答えの質が正当化する」と正直に書いています。

TypeScript SDK のコードだとこうなります。

```typescript
import { Honcho } from "@honcho-ai/sdk";

const honcho = new Honcho({ apiKey: KEY, workspaceId: "mesa-city" });

const mika = await honcho.peer("resident_12");
const session = await honcho.session("day_41");
await session.addMessages([ mika.message("Day41 タロウと居酒屋へ飲みに行った") ]);

// 書かれていないことを聞く
const s = await mika.chat("この住民はどういう人か、2文以内で");
```

## 4. HonchoとRAGの違い

一番聞かれそうなところなので、はっきり書きます。

**機構としては RAG です。** 公式ドキュメント自身が "reasoning-driven RAG pattern" と書いていますし、conclusion のベクタ埋め込みを保存して意味検索しています。ベクタ検索を使っているのに「RAGではない」と言うのは嘘になります。

違うのは、**何をインデックスするか**です。

| | 素のRAG | Honcho |
|---|---|---|
| インデックス対象 | 生テキストの**チャンク** | **conclusion（導出された結論）** |
| 書き込み時 | 分割して埋め込むだけ | LLM が推論して結論を書き出す |
| 返るもの | 元の文章の断片 | 「この人はこういう人だ」という命題 |
| コスト | 書き込みが安い | **書き込みが高い**、読み出しはさらに高い |

つまり **RAG のインデックス層に LLM 推論を1段挟んだもの**です。新しいパラダイムというより、「RAG の前処理を重くした変種」と理解するのが正確だと思います。

### 技術的に何を担保しているか

形式的な保証はほとんどありません。構造として提供しているのは4つです。

**① 書き込みレイテンシの上限。** メッセージは即座に永続化し、推論はキューへ回す。これは非同期ワーカーという構造そのものが担保しています。後述しますが、MESAから fire-and-forget で投げられるのはこの性質のおかげです。

**② 出典への追跡可能性。** conclusion から前提メッセージへ遡れる。「なぜそう判断したか」を検証できます。

**③ peer 単位のコンテキスト分離。** 前述の通り、データモデルのレベルで保証されています。

**④ 記憶が単調増加しない。** Dreamer が古い結論を削除する。素のRAGの「インデックスが増え続けて検索精度が下がる」問題に構造的に手を打っている。ドキュメントの表現だと「拡張するのではなく深化させる」。

### 逆に担保していないもの

同じくらい重要です。

**事実の正確性は担保されません。** しかも構造上、悪化する経路があります。

```
誤った推論 → conclusion として書き込まれる
           → 埋め込まれてインデックスされる
           → 検索でヒットする
           → 次の推論の前提として使われる
```

素のRAGなら誤りは「元の文章にそう書いてある」で止まりますが、Honcho は**推論の誤りが固定化して再利用されます**。②の追跡可能性は、この危険への対抗策としてある機能だと読むべきでしょう。

**時間的整合性も担保されません。** 後述する Zep の `valid_at` / `invalid_at` のような明示的な時間モデルは持っていません。Dreamer が「陳腐化したものを消す」という緩い仕組みだけです。

**決定性もありません。** 同じ会話を流しても、LLM 次第で違う結論が出ます。

### シミュレーションでは、弱点が弱点にならない

ここが今回いちばん腑に落ちたところです。

**MESAには「正しさ」の外部基準がありません。** カスタマーサポートで顧客の属性を誤って固定化したら事故ですが、街の住民が「ミカは寂しがりだ」と誤解されても、それはそれで物語になる。むしろ誤解が蓄積して人格になっていく方が、シミュレーションとしては自然かもしれません。

Honcho の最大の弱点が、この用途では問題にならない。これは採用を後押しする理由になりました。

## 5. 類似サービス

エージェントメモリは2025〜2026に一気に増えた領域で、同じ棚に見えて設計思想がバラバラです。実際に調べた範囲をまとめます（各公式ドキュメント/READMEの記述ベース。私が全部動かしたわけではありません）。

| | 何に賭けているか | ローカル起動 | 依存サービス | モデル自由度 | 言語 |
|---|---|---|---|---|---|
| **Mem0** | 事実の抽出と検索、矛盾の自己解決 | ★★★★☆ | なしにもできる | ★★★★★ | Py + **TS** |
| **Zep / Graphiti** | **時間つき知識グラフ** | ★★☆☆☆ | グラフDB必須 | ★★★☆☆ | Python |
| **Letta（旧MemGPT）** | エージェントランタイム（層が違う） | ★★★☆☆ | Docker 1個 | ★★★☆☆ | Python |
| **Cognee** | 文書→知識グラフのパイプライン | ★★★★☆ | Postgres 1台〜 | ★★★★☆ | Python |
| **Supermemory** | 速度とゼロ設定 | ★★★★★ | **なし**（1バイナリ） | ★★★★☆ | Go/TS |
| **Honcho** | **暗黙の選好の推論**、peer中心 | ★★☆☆☆ | PG+Redis+worker | ★★☆☆☆ | Py + TS |

補足をいくつか。

**Mem0** は最大手で、デフォルトのベクタDBは Qdrant ですが Chroma / FAISS / in-memory に差し替えられるので、**外部サービスなしで動きます**。LLMプロバイダは OpenAI, Anthropic, Google, Ollama, LM Studio, Bedrock, LiteLLM ほか15種類ほど。

**Zep / Graphiti** は事実に有効期間を持たせる設計で、「あの店はいつ潰れて跡地に何が建ったか」という街の履歴には思想的に最も合います。ただしグラフDB（Neo4j / FalkorDB）が別途必要。さらに**Structured Output 対応のLLMが必須**と明記されていて、「Ollamaで繋がる」と「Ollamaで実用になる」が別、という制約があります。

**Supermemory** はローカル起動が圧倒的に楽です。1バイナリ、ゼロ設定、埋め込みも既定でローカル（`Xenova/bge-base-en-v1.5`）なのでAPIキーすら要らない。ただし設計が「文書・知識」寄りで、peer間の関係モデリングは弱い。

**Letta** はメモリ層ではなくランタイムです。MESAは `server.js` の simループが既にランタイムなので、入れると層が二重になります。今回は対象外。

**Honcho は、モデル自由度が最も狭い**という点は正直に書いておきます。既定だと deriver に Gemini、dialectic の中〜max に Anthropic、埋め込みに OpenAI で、**3社ぶんのAPIキーが要ります**。ローカルモデルの案内も見当たりませんでした。

### MESAにとっての判断軸

一般論より、**`server.js` が Node.js である**ことが実際には一番効きました。Python専用のライブラリはサイドカープロセスが1つ増えます。

その観点だと Mem0（TS SDKあり）と Supermemory（HTTP API）と Honcho（TS SDKあり）が残り、**peer中心のモデルが欲しいなら Honcho** になります。

## 6. MESAでの具体的な実装

### なぜ20人なのか

`POP_MAX=100` ですが、全員に peer を持たせません。理由は3つ。

1. 課金とレイテンシを予測可能にする
2. 引っ越しで人が入れ替わるので、全員ぶん作ると peer が無限に増える
3. **そもそも視聴者が見ているのは一部の住民だけ**

なので「物語が起きた人」から先着20人に絞ります。

### フックは3箇所で足りる

コードを読み直して分かったのは、**`chronicle.js` の `push()` が単一のチョークポイントになっている**ことでした。`CH.push` で grep すると15箇所ありますが、全部同じ形をしています。

```js
CH.push(a, {day, icon:'🤝', mark:true, ja:`${b.name} と友達になった`, en:`became friends with ${b.name}`});
```

しかも **すでに日本語1行のテキストを持っている**。Honcho は自然言語を食う設計なので、変換レイヤーがほぼ要りません。

| 何を | どこ | 頻度 |
|---|---|---|
| 書き込み | `CH.push` をラップ | イベント発生時、キューに積むだけ |
| 送信 | `dailyRollover()` | **1シム日に1回** |
| 読み出し | `!story` ハンドラ | 視聴者が聞いたときだけ |

`dailyRollover` は `cityTick` から「日付が変わった瞬間だけ」呼ばれます。ここが決め手でした。

```js
function cityTick(){
  const d=gameDay();
  if(_lastDay===null) _lastDay=d;
  else if(d!==_lastDay){ _lastDay=d; dailyRollover(d); }   // ← 1日1回
}
```

### honcho-bridge.js

```js
// honcho-bridge.js — 注目住民 20 人ぶんの記憶を Honcho に預ける。
//
// ── 設計の要点 ──
// 1. simLoop は TICK=150ms で回る。**ここで絶対に await しない。**
//    出来事は同期でキューに積むだけにして、送信は日次ロールオーバーへ回す。
// 2. 全員ぶんは持たない。POP_MAX=100 だが peer は先着 20 人。
// 3. Honcho が落ちてもシムは止めない。例外は握り潰してログだけ出す。
'use strict';

const ON        = process.env.HONCHO === '1';
const MAX_PEERS = parseInt(process.env.HONCHO_PEERS, 10) || 20;
const WS        = process.env.HONCHO_WORKSPACE || 'mesa-city';
const KEY       = process.env.HONCHO_API_KEY || '';
const MARK_ONLY = process.env.HONCHO_MARK_ONLY !== '0';  // 既定は節目だけ送る

let honcho = null, ready = false, sending = false;
const enrolled = new Map();   // aid -> name
const peers    = new Map();   // aid -> Peer (解決済み)
let queue = [];

const pid = aid => `resident_${aid}`;

async function init(){
  if(!ON || !KEY){ console.log('[Honcho] 無効'); return false; }
  // SDK が ESM の場合、CJS の server.js からは動的 import が要る
  const { Honcho } = await import('@honcho-ai/sdk');
  honcho = new Honcho({ apiKey: KEY, workspaceId: WS });
  ready = true;
  console.log(`[Honcho] 有効 | workspace=${WS} 上限${MAX_PEERS}人`);
  return true;
}

/** この住民を記憶対象にする。枠が埋まっていたら無視される。 */
function enroll(a){
  if(!ready || !a || enrolled.has(a.aid) || enrolled.size >= MAX_PEERS) return false;
  enrolled.set(a.aid, a.name);
  a.honcho = true;
  console.log(`[Honcho] ${a.name} を記憶対象に (${enrolled.size}/${MAX_PEERS})`);
  return true;
}

/** CH.push から呼ばれる。同期・軽量であることが絶対条件。 */
function note(a, e){
  if(!ready || !a || !enrolled.has(a.aid)) return;
  if(MARK_ONLY && !e.mark) return;
  queue.push({ aid:a.aid, day:e.day, text:e.ja, mark:!!e.mark });
  if(queue.length > 400) queue.splice(0, queue.length - 400);   // 詰まったら古い方を捨てる
}

/** 日次ロールオーバーから fire-and-forget で呼ぶ。await しない。 */
async function flush(day){
  if(!ready || sending || !queue.length) return;
  sending = true;
  const batch = queue; queue = [];
  try{
    const session = await honcho.session(`day_${day}`);
    const used = [...new Set(batch.map(b => b.aid))];
    for(const aid of used)
      if(!peers.has(aid)) peers.set(aid, await honcho.peer(pid(aid)));
    await session.addPeers(used.map(aid => peers.get(aid)));
    await session.addMessages(
      batch.map(b => peers.get(b.aid).message(`Day${b.day+1} ${b.text}`))
    );
  }catch(err){
    // 再送はしない。SIM_FAST から戻ったときに雪崩れるより、落とした方が安全。
    console.warn('[Honcho] flush 失敗 (シムは継続):', err.message);
  }finally{ sending = false; }
}

/** !story から呼ぶ。ここが唯一の「高い」呼び出し。 */
async function ask(a, q){
  if(!ready || !a || !enrolled.has(a.aid)) return null;
  try{
    if(!peers.has(a.aid)) peers.set(a.aid, await honcho.peer(pid(a.aid)));
    return await peers.get(a.aid).chat(q);
  }catch(err){
    console.warn('[Honcho] chat 失敗:', err.message);
    return null;
  }
}

const isOn = () => ready;
module.exports = { init, enroll, note, flush, ask, isOn, MAX_PEERS };
```

### server.js 側の差分

**① 読み込みとラップ。** 15箇所に個別に足すより、1回ラップした方が漏れません。

```js
const CH = require('./chronicle.js');
const HB = require('./honcho-bridge.js');
const _chPush = CH.push;
CH.push = (a, e) => { _chPush(a, e); HB.note(a, e); };
HB.init().catch(e => console.warn('[Honcho] init 失敗:', e.message));
```

**② 誰を20人に選ぶか。** 先着だと退屈なので、物語が起きた人を優先します。

```js
HB.enroll(founder);      // 起業したとき
HB.enroll(a);            // !join で視聴者が分身を得たとき ← 最優先
HB.enroll(a); HB.enroll(b);  // 友達になったとき
```

**③ 日次フラッシュ。**

```js
function dailyRollover(day){
  if(!CITY || !CITY_EVOLVE) return;
  if(!SIM_FAST) HB.flush(day);   // ★ await しない。早送り中は完全に止める
  ...
```

**④ `!story` を拡張。** 既存の年表は残したまま、1行添える形にします。

```js
const ls=CH.lines(a, JA_HUD, 6);
for(const l of ls) pushTalkLine('', l);

// Honcho が覚えていれば、年表の後に「その人らしさ」を添える
if(HB.isOn()){
  HB.ask(a, `この住民はどういう人か、2文以内で。日本語で。`)
    .then(s => { if(s) pushTalkLine('', `— ${String(s).slice(0,120)}`); });
}
```

`pushTalkLine` は後から足しても崩れない作りなので、**返信を待たずに済みます**。年表は即座に出て、人物評だけ1〜2秒遅れて追加される。

### SIM_FASTという罠（前回の続き）

前回の記事で、実験を回すために時計を tick 起点にして363倍の早送りを実装しました。それがここで牙を剥きます。

通常運転は `DAY_MINUTES=24`、つまり実時間24分で1日。書き込みは**1時間に2.5バッチ**で、無視できる量です。

ところが `SIM_FAST=1` だと1日が約4秒になります。同じコードが**500倍以上の頻度で外部APIを叩く**ことになる。上のコードの `if(!SIM_FAST)` は消してはいけません。

「街の中の時間に実時間を混ぜると早送りのときだけ壊れる」というのが前回の教訓でしたが、**外部サービスを繋ぐと逆向きの罠が生まれる**わけです。シム内時間で駆動しているものは、早送りすると勝手に加速する。

### 未検証のこと

正直に列挙します。

- **SDKのメソッド名は公式ドキュメントの例から取りましたが、実行していません。** `session.addPeers` / `getContext` あたりは v2/v3 で表記が揺れている形跡があります
- `@honcho-ai/sdk` が ESM のみなら上の動的 `import()` が必要。CJS対応なら普通の `require` に落とせます
- **`a.aid` の再利用**が怖いところです。保存キーが `own[a.aid]` になっているので、住民が引っ越して aid が再利用されると**別人の記憶が混ざります**。実装前に単調増加かを確認する必要があります
- **取り込み（ingest）時の課金**がドキュメントで確認できませんでした。公開されているのは推論クエリの価格（$0.001〜$0.50/query）だけです

最後の点があるので、まず**①〜③だけ入れて④を入れずに1日走らせる**のが安全だと考えています。書き込みだけの状態で実際の請求を見てから、読み出しを繋ぐ。

## おわりに

調べる前は「メモリ層」を全部同じものだと思っていましたが、実際には**何を記憶と呼ぶかの定義そのものが違いました**。

- Mem0 は「言われた事実を保存して引く」
- Zep は「事実の有効期間を持つグラフ」
- Honcho は「**言われていないことを推論して人物像にする**」

MESAで欲しかったのは3つ目です。「ミカは飲食店ばかり行く」は Mem0 でも出ますが、「ミカは人と食事をしたがっているが誘い方を知らない」は Honcho の担当範囲になる。

同時に、Honcho の最大の弱点である「誤った推論の固定化」が、シミュレーションという用途では弱点にならない、というのも収穫でした。**正しさの外部基準がない世界では、誤解の蓄積もまた人格です。**

実際に20人ぶん流してみたら、また誤読していたことに気づくかもしれません。そのときはまた書きます。
