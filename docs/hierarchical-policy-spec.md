# 階層方策 — ハイポリシー / ローポリシー の仕様 (Phase A)

住民の行動決定を **「いま何をするか」(HLP)** と **「それをどう実行するか」(LLP)** に
分ける。目的は 2 つ。

1. **性格が1日の流れに効くようにする。** これまで1日は `needOf()` の if-else 梯子
   ひとつで決まっていて、閾値は全員共通の定数だった。冒険好きも食いしん坊も同じ
   梯子を同じ順で降りていた。
2. **行動を後から足せるようにする。** 起業・窃盗・娯楽・まだ無い行動が入ってくる。
   行動集合を固定サイズの softmax ヘッドにすると、行動を1つ足すたびに再学習が要る。

対象は `server.js` (配信サーバ) のみ。`standalone/index.html` は触らない。

---

## 0. 出発点 — いま何が起きているか (2026-09-10 実測)

| | 実態 | 根拠 |
|---|---|---|
| ONNX 方策 | **移動に一切使われていない** | `MOVE_MODE = 'pursuit'` がハードコード ([server.js:11064](../server.js)) → `prefetchAllActions` が即 return ([server.js:1202](../server.js)) → `inferAction()` は一度も呼ばれない |
| 視覚 (DINOv2) | 移動判断に関与しない | 同上。`SEG_GATE=1` のときだけ通行可否に効くが既定 OFF |
| `a.goalZ` | 毎tick組み立てて**捨てている** | 読む場所は `inferAction` の中だけ ([server.js:1148](../server.js))。到達不能 |
| 1日の流れ | if-else 梯子 | `needOf()` ([server.js:7643](../server.js)) |
| 性格の効き目 | 「どの店を選ぶか」だけ | `pickLifeGoal` の `PREF_WEIGHT*prefOf()` と `a.taught` |

実際の移動は `pickLifeGoal → planPath(A*) → stepNavigate(pure pursuit) → naturalWalk` の
完全な決定論。**「視覚を補助的に使って建物に寄っている」のではなく、視覚は寄与ゼロ。**

---

## 1. 層の分け方

```
HLP  (低頻度: Option 終了時 / 割り込み時)          hlp.js + options.js
  入力  性格 / 内部状態 / 時刻・曜日 / 記憶 / 社会文脈 / 街の状態 / 割り込み
  出力  Option ひとつ {verb, targetSpec, deadline}
        ★ targetSpec は座標ではなく仕様 —「飲食カテゴリを好み込みで上位3軒から」

  ↓ Option                                  ↑ percept (割り込み)

LLP 上段  (毎tick)                                llp.js
  targetSpec → 建物セル の解決        resolve: 'map'(既定) / 'vision'
  歩きながらの気づき                   percept: 'off'(既定) / 'geom' / 'vision'
  着いた建物が目的地だったかの確認      verifyArrival

LLP 下段  (毎tick)                                server.js の stepAll() に残す
  ウェイポイント → 前進/左/右
  pursuit : naturalWalk()      ← 既定。FPVレイキャストも ONNX も走らない
  policy  : selectAction()     ← MOVE_MODE=policy のときだけ
```

### なぜ LLP 下段だけ server.js に残すか

そこが `MOVE_MODE` の分岐点で、`stepAll()` の中に**既にある** ([server.js:11962](../server.js) の
`usePursuit`)。分岐を 2 箇所に増やすより、既にある 1 箇所を使うほうが安全。

### targetSpec を座標にしない理由

座標を渡した時点で、LLP 側の「視覚で目的地かどうかを確かめる」という仕事が儀式になる。
**「何を探すか」までしか渡さない**のが、視覚に意味を持たせる前提条件。

---

## 2. 不変条件 — 配信の負荷を上げない

配信 (`MOVE_MODE=pursuit`) では FPV レイキャストも DINOv2 も走らせたくない。
そのために守る条件が 1 つある。

> **HLP と Option の定義に「視覚があること」を前提させない。**
> 視覚は精度を上げるが、無くても同じ行動が成立する。

具体的には解決器と知覚源を差し替え可能にし、既定を「配信で回せる側」にする。

| つまみ | 既定 | 効果 |
|---|---|---|
| `MOVE_MODE` | `pursuit` | LLP 下段のアクチュエータ。`policy` で ONNX 方策 |
| `GOAL_RESOLVE` | `map` | targetSpec の解決。`vision` で CLIP 照合 (Phase B) |
| `PERCEPT` | `off` | 割り込みの出所。`geom` / `vision` |

`geom` 版は **すでに毎tick計算されているものしか見ない**:

| 気づき | 出所 | 追加コスト |
|---|---|---|
| 知り合いを見かけた | `stepNeeds` が既に呼んでいる `SOC.neighbors` の `_nearBuf` | 0 |
| 知らない店を見つけた | `structAt` + `losClear` (どちらも既存) | 半径4セルの走査を `PERCEPT_EVERY`(既定4) tickに1回 |
| 道が塞がっている | `naturalWalk` が既に持っている `a.stall` | 0 |

**HLP 自体は ONNX も DINOv2 も触らない。** MOVE_MODE と無関係に動く。

### HLP を足しても重くならない理由

`needOf(a)` は 25 箇所から呼ばれていて、1エージェント1tickあたり実測 5〜7 回
再計算されている (`stepNeeds` / `ptIdle` / `shouldLeaveBuilding` /
`retargetOnNeedChange` / `describeActivity` / 配達判定 / カメラ選定)。

HLP 版の `needOf` は候補 8 個の precond (数値比較のみ) を舐めるだけ。梯子が
短絡するぶん 1 回あたりは少し重いが、**桁は同じ**。呼ばれる回数は変えていない。

> ⚠️ 「1回に減らせるからむしろ軽い」とは書けない。tick 内キャッシュを入れると
> 欲求が閾値をまたぐタイミングが 1tick ずれ、既存挙動との一致が崩れる。
> **Phase A では一致を優先して、あえてキャッシュしていない。**

---

## 3. Option

`options.js` のデータ。**後から足せることが設計の目的**なので、`register()` を
呼ぶだけで増える。`hlp.js` は一覧を舐めるだけで、個々の Option を知らない。

| 欄 | 意味 |
|---|---|
| `id` | 一意。セーブのキーになるので**一度決めたら変えない** |
| `need` | 既存 `needOf()` が返していた名前。**25箇所の呼び口を変えないための互換の要** |
| `tier` | 効用の段。`needOf()` の優先順位を数値にしたもの |
| `precond` | 候補に上げてよいか。**`needOf()` の各行と 1:1 に対応する** |
| `target` | targetSpec |
| `stay` | 屋内に居るとき留まるか (`shouldLeaveBuilding` の裏返し) |
| `persona` | 性格ボーナス。`HLP_PERSONA=1` でだけ効く |
| `text` | Phase B で埋め込みを作るための自然言語記述 |

### 段 (tier)

```
survival 600  病気
sleep    500  睡眠 (夜 / 限界の疲労)
rest     400  日中のひと休み
eat      300  空腹
duty     200  勤務 / 通学
errand   100  買い物
leisure   50  退屈しのぎ
idle       0  用事なし
```

**段の間隔 (50) は性格ボーナスの上限 `PERSONA_MAX`(20) より大きい。**
そうしないと性格が「腹が減っているのに寝る」のような生命に関わる逆転を起こす。

### 効用

```
score(o) = tier(o) + persona(o) + hook(o)
```

`hook` が **Phase B/D の縫い目**で、`f(state) · g(embed(o))` を後から差す場所。
固定サイズの softmax にしないのはここが理由 —

```
NG:  logits = W · state    →  W の出力次元 = 行動数。行動を足すと再学習
OK:  score(o) = f(state) · g(embed(o))   →  新しい行動は embed を1本足すだけ
```

`embed` は行動の自然言語記述の埋め込み。学習時に存在しなかった行動でもスコアが付く。
**建物側にも同じ機構を使う** (§6)。

---

## 4. 割り込み (LLP → HLP)

`options.js` の `PERCEPTS` が語彙。**ここに無いものは割り込めない。**

| kind | pre | gain | 意味 |
|---|---|---|---|
| `saw-friend` | `idle` | 30 | 知り合いを見かけた |
| `saw-new-shop` | `idle` | 25 | 知らない種類の店を見つけた |
| `saw-crime` | — | 40 | 事件を目撃した |
| `target-gone` | — | 999 | 目的地が無くなっていた |
| `target-mismatch` | — | 999 | 着いたが目的の建物ではなかった |
| `blocked` | — | 10 | 道が塞がっている |

`pre` がある割り込みは「乗り換え先の効用に `gain` を足して、いまの Option を
上回るなら乗り換える」。`pre` が無いものは Option を続けたまま行き先だけ取り直す。

割り込みは**溜めておいて次の決定タイミングでまとめて処理する** (`pump`)。
毎tick即応させると方針が揺れて、歩いている人が同じ角で行ったり来たりする。

---

## 5. Phase A の検証

**「たぶん同じ」では困る。** 2 段構えで確かめる。

### ① 関数の等価 — `node tools/hlp-equiv.js`

```
① 選択      : 480,000 通り / 不一致 0
② 行き先    : 20,000 通り / 不一致 0 / 乱数消費のずれ 0
```

`needOf()` と `pickLifeGoal()` の逐語コピーを参照実装として持ち、時刻 24 × 週末 ×
学生 × REST × 各欲求 5 段の総当たりで突き合わせる。行き先は**乱数を引いた回数まで**
一致を見る (ずれると `tools/determinism-check.js` が落ちる)。

### ② 系の等価 — `node tools/hlp-ab.js`

```
seed=12345  A=9a0aea1a B=9a0aea1a  ✔ 一致
seed=13122  A=f59fb241 B=f59fb241  ✔ 一致
seed=13899  A=c58a69a5 B=c58a69a5  ✔ 一致
```

**関数の等価と系の等価は別物。** 実際、見張りに `a.opt.id` を使った最初の実装は
①を通ったのに実サーバの hash が食い違った:

> `a.opt` は「いま実行中の Option」で、行き先を引き直すたび (`enterWander` →
> `pickLifeGoal`) に張り替わる。それを `retargetOnNeedChange` の見張りに使うと、
> **別経路の `enterWander` が見張りごと更新してしまい**、本来そこで起こすはずの
> 引き直しが 1 回抜ける。

既存の `a.lastNeed` が `retargetOnNeedChange` の中でしか書かれていないのと同じ約束を、
`a.lastOptId` で守る。**新しい状態を足すときは「誰が書いてよいか」を先に決めること。**

---

## 6. 手書きの効用のまま動かす場合 (HLP_NET=0)

つまみの一覧は §8 にまとめてある。ここは「学習した方策をまだ入れないが、
Phase A の構造だけで性格を効かせたい」ときの話。

起動時に必ず 1 行出る。**ここが `(既存挙動と一致)` でないときは、指紋が変わって当然。**

```
[HLP] on persona=0 extra=0 temp=0 goal=map percept=off  (既存挙動と一致)
```

`HLP_LIVE=1` (性格 + 追加Option + 割り込み) の実測 (4日 / pop150 / 2種)。
**2種では何も主張できない**が、経済活動が増える向きには動いている:

```
seed=12345  人口 7→10   経済 290→331   未充足 548→1449
seed=13122  人口 14→18  経済 304→399   未充足 2057→2083
```

計測は `node tools/hlp-ab.js --live --seeds=20` のように種を増やして行うこと。

---

## 7. 学習した方策 (ノートブック側)

`build_pro_onnx_by_persona.ipynb` に追加セル A〜G を入れた。出るものは 2 つ。

```
data/hlp.onnx            ハイポリシー。状態(46) と 候補の埋め込み(K,64) → スコア(K)
data/persona_multi.onnx  ローポリシー。CLS(384)+z(64)+aux+性格 → 前進/左/右
```

**1ファイルにはしない。** ONNX は 1 ファイル 1 グラフなので、まとめるとハイポリシーを
呼ぶたびに DINOv2 の CLS(384) を食わせることになる。ハイポリシーは視覚を必要と
しないので、それは純粋な無駄になる。

### セルの割り当て

| セル | 何をするか | 無いとどうなるか |
|---|---|---|
| A | ALIGNED 世界へのパッチ (物理と光学) | **学習した重みが本番で必ず壊れる** |
| B | ALIGNED 版の env (湧き先/ゴール/到着/compass) | 到着判定が恒偽になりゴール報酬が一度も出ない |
| B2 | 車 / 歩道と車道 / aux 12→16 | **車道を平気で歩き、車を避けない方策になる** |
| C | CLIP テキスト埋め込み (建物 25種 + 行動 23種) | 新しい建物・行動を指す手段が無い |
| D | goal z を one-hot 25 → 埋め込み 64 へ | 26 種類目の建物に方策が案内できない |
| 11 | (既存) ローポリシーの学習 | |
| E | 行動カタログ + 抽象都市 env | ハイポリシーを学習する場所が無い |
| F | ハイポリシーのネットワークと PPO | |
| G | 学習実行 / 検証 / `hlp.onnx` 出力 | |

### 直した世界の不一致 (2 つ)

```
① 物理   notebook  PASS_T = ROAD | BUILDING     建物は歩いて入れる / 空地は壁
        server    PASSABLE = {ROAD, OTHER}     建物は壁 / 空地は歩ける   ← 反転していた
② 光学   notebook  レイは BTYPE_T>=0 (建物) にしか当たらない
        server    ALIGNED は木も視界を遮る (visibleTrees:true)          ← 木が抜けていた
```

②を直さないと「画像では抜けられるのに物理で止まる木」が残り、ALIGNED の狙い
(描画レイの距離 = 進行可能距離) が半分しか成立しない。

`randomize_map()` は cell4 で `PASS_T` を LEGACY で上書きするので、セル A で包んである。
**包み忘れると 1 回目のマップ更新以降ずっと LEGACY に戻る**（症状が「最初だけ調子がいい」
なので気づきにくい）。

### 街を安全に歩くための観測 (セル B2)

改造前のローポリシーには、道を歩くのに要る情報が入っていなかった。

| | 改造前 | 改造後 |
|---|---|---|
| 車 | 学習 env に**1台も居ない** (traffic.js は server.js だけ) | `CarField` が道路セル上を軸沿いに走る |
| 車道か歩道か | `sidewalk_bonus = 0.02` の**べた書き既定**。`road_bonus`(0.3〜0.4) の 1/15 で勾配が届かない | **性格パラメータに昇格** (0.12〜0.60)。慎重な人ほど歩道から出ない |
| 観測 | aux 12 (compass3+visited4+social2+obstacle3) | **aux 16** (+ crowd_left / crowd_right / car_ttc / curb_ahead) |
| 車の罰 | 無し | `car_penalty` (轢かれる / 車が来ているのに踏み出す) |

`WALK_PREF` ([roads.py:203](../roads.py)) は 歩道 1.00 / 横断歩道 1.00 / 舗装 0.85 /
空き地 0.55 / 芝 0.50 / **車道 0.00**。

**横断歩道について:** アトラスには白縞として描かれているが
([make-road-atlas.js:133](../tools/make-road-atlas.js))、`popcount(mask)>=3` の
**交差点にしか描かれない**。報酬上も 横断歩道 = 歩道 = 1.00 で同じなので、
「横断歩道を選んで渡る」を促す信号は**まだ無い**。渡れる場所として認識はする。
セル B2 の自己点検が、街に横断歩道が 1 セルも無い場合に警告を出す。

### 車の速度の対応

```
server  CAR_SPEED = 3.4 ワールド単位/秒、CELL = 2.0  → 1.7 セル/秒
        TICK = 150ms                                → 0.255 セル/tick
notebook MOVE_DIST = 0.25 セル/tick、ACTION_REPEAT = 5
        ⇒ notebook の 1 tick = server の 1 tick は INFER_EVERY = ACTION_REPEAT = 5 のとき
```

`car_ttc` は walk.js の式そのまま — **車道へ踏み出す一歩の前でだけ**計算し、
`min(1, ttc秒 / (carTtc*2 = 4.4秒))` で正規化する。常時計算にすると、歩道を
歩いているだけで値が動いて本番とズレる。

### 直した server.js のバグ

`MOVE_MODE=policy` では `naturalWalk()` が走らない。ところが
`a.crowdL` / `a.carTtc` を書いていたのは `naturalWalk()` だけだったので、
**policy モードでは aux[12..14] が前の値のまま**になり、方策には
「誰も居ない・車も居ない」が入り続けていた。落ちも警告も出ないので気づけない。

`buildAux` から `computeWalkAux()` を呼ぶようにし、混み具合の式は
`walk.js` の `crowd()` に 1 本化した (2 箇所に書くと静かにズレる)。

### ハイポリシーの学習

絵を描かない抽象都市 (`HighLevelCityEnv`) を 4096 並列で回す。1エピソード = 1日 = 40決定。

**性格は報酬に入れる。** 観測に混ぜるだけだと、同じ街・同じ欲求なら最適行動は一つ
なので全員が同じ1日を送る。`reward_weights(P)` が性格ベクトルから重みを作る:

```
explore = 0.2 + 2.8·curiosity      新しい建物に入ったとき
gourmet = 0.1 + 2.4·gourmet        今日まだ入っていない種類の飲食店
crime   = 3.0·(1 − honesty)        窃盗。正直な人には罰、そうでない人には利
```

`persona_rewards.json` が探索者タロウに `explore_bonus: 4.5`、インドア花子に `0.1` を
与えているのと同じ考え方を、1日の行動の側へ持ち込んだもの。

### 未知の行動への備え

```
score(o) = f(状態) · g(埋め込み(o)) + b(埋め込み(o))
```

f が状態を鍵に、g が説明文を錠前に変える。**学習中に行動集合を毎エピソード
25% 落とす** (`opt_dropout`)。固定した集合で学習すると g は「この 23 個」を丸暗記し、
24 個目に何のスコアも付けられなくなる。

### セル G の検証 — どちらかが落ちたら配備してはいけない

| 検証 | 見るもの |
|---|---|
| ① 性格の分化 | 冒険好き・食いしん坊・出不精・働き者・社交的・不正直の6人が、違う1日を送るか |
| ② 未知の行動 | 学習時に無かった `hot-spring` / `bookstore` / `night-market` / `gym` / `donate` に、状況に応じた順位が付くか (疲れていれば温泉が寄付より上、など) |

結果は `hlp_meta.json` の `validation` に残る。**未合格のまま配備すると server.js が
起動時に警告を出す**（黙って動いてしまわないように）。

---

## 8. 配備 (server.js 側)

### つまみ

```bash
# ── 構造 (既定で既存挙動と完全一致) ──
HLP=0                  # 従来の if-else 梯子へ丸ごと戻す (逃げ道)
GOAL_RESOLVE=map       # 行き先の解決。vision で CLIP 照合 (未実装の口)
PERCEPT=off            # 割り込み。geom / vision

# ── 学習した方策 ──
HLP_NET=1              # data/hlp.onnx を使う。★これが「全部ポリシー」の本体
HLP_NET_EVERY=30       # 何tickにスコアを引き直すか (1決定は街の中で数十分)
MOVE_MODE=policy       # 歩行も学習方策に (DINOv2 が要るので研究環境だけ)

# ── 手書きの効用を使うときの実験用 (HLP_NET=0 のとき) ──
HLP_PERSONA=1 / HLP_EXTRA=1 / HLP_TEMP=15 / HLP_LIVE=1
```

`HLP_NET=1` にすると、行動カタログは **`hlp_meta.json` から作り直される**
(`OPTS.registerFromMeta`)。JS 側に一覧を書き写さないのは、書き写すと必ずズレるから。
`precond` は**学習時の `mask()` の逐語訳**にしてある — deploy 側だけが余計に候補を
出す/削ると、方策は学習中に一度も見ていない状況に置かれる。

### 配信の負荷

| | ハイポリシー | ローポリシー |
|---|---|---|
| 重さ | 小さい MLP、視覚なし | **DINOv2 を1体1回** |
| 頻度 | `HLP_NET_EVERY`(30) tick に1回・位相分散 | `INFER_EVERY` tick に1回・位相分散 |
| 配信で回せるか | ○ | ここだけがコスト |

だから `HLP_NET=1` は配信でも入れられるが、`MOVE_MODE=policy` は研究環境向け。
**「歩くところまで全部ポリシー」を配信で成立させるなら、DINOv2 のコストを
受け入れる判断が要る。** そこは env で選べるようにしてあるだけで、決めていない。

### 学習を待たずに配線だけ試す

```bash
node tools/make-dummy-hlp.js --out=data     # でたらめな hlp.onnx を作る
HLP_NET=1 SIM_FAST=1 ... node server.js     # 読み込み〜選択まで通るか
```

ハイポリシーの本体は Colab で数十分〜数時間かかる。その間 server.js 側の配線
(メタ読み込み / カタログ生成 / 観測の組み立て / 非同期スコア先読み / choose への
差し込み) は一度も動かない。**配線の間違いは学習の失敗と見分けがつかない**ので、
先に潰す。学習済みメタがある場所には `--force` なしでは書き込まない。

### 毎日出る診断

```
[HLP] Day4 推論済 12/12人  今日の行動 50回 (2種): sleep:52% eat-cafe:48%
```

- 推論済が 0 人 → 配線が切れている (観測の次元を疑う)
- 1 種類に張り付いている → 観測がおかしいか方策が退化している

★ **「いまの Option」を数えてはいけない。** `dailyRollover` が走るのは日付が変わる
深夜で、そこは precond が sleep しか通さない時刻。何を測っても `sleep:全員` になる。
1日のあいだに**選ばれた回数**を積んで出している。

### 既知の近似 (train と deploy のズレ)

観測のうち 2 つは、学習側と意味は同じだが計算が違う。**挙動がおかしいときは
真っ先にここを疑うこと。**

| 観測 | 学習側 | server 側 |
|---|---|---|
| `known_frac` | 訪れた**建物**の割合 | 歩いた**セル**の割合 |
| `percept.walked` | その行動で歩いた分数 | `pathIdx / 0.9` を分に換算 |

## 9. 決定性

`options.js` / `hlp.js` / `llp.js` はすべて `setRng(RNG.R)` で乱数を差し替える
(`pastime.js` と同じ約束)。**差し替え忘れると他が全部決定的でもここ一本で
世界がずれる**。症状が「たまに再現しない」なので厄介。

- `hlpAttach()` が起動時に一度だけ差す
- `Date.now()` は使わない。街の中の時間は `simNow()` (早送りで壊れる)
- 分岐探索のスナップショットには `a.opt.id` を含める (`agentSnap` / `applyAgentSnap`)

`HLP_LIVE=1` でも決定的であることは実測済み (同種2回で hash 一致)。
