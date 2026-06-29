# MESA Persona City Sim — DINOv2 で「見て動く」NPC

サーバー上で都市シミュレーションをヘッドレス描画し、WebSocket+JPEG でブラウザにストリーム配信するシステム。
NPC（ペルソナエージェント）は **地図の座標ではなく「目に見えた景色」だけで行動を決める**、現実のロボットに近い設計です。

---

## 1. コンセプト：地図ではなく「目」で動く

各 NPC は一人称視点（FPV）のカメラ映像を持ち、それを **DINOv2**（自己教師あり学習の汎用画像エンコーダ）で
特徴ベクトルに変換し、その特徴だけを見て「前進 / 左回転 / 右回転」を決めます。

```
エージェントの (x, y, 向き)
  └─ 一人称視点をレイキャスタで描画（テクスチャ付き 224×224）
       └─ DINOv2 → CLS token (384次元)  =「今どんな景色か」の要約ベクトル
            └─ ペルソナ別ポリシー(persona_X.onnx) → 行動(前進/左/右)
```

エージェントが実際に見ている映像はこんな感じです（横に種類の違う店が並ぶ）:

![agent first-person view](docs/images/fpv_showcase.png)

近接するとテクスチャがはっきり見えます（窓・看板つきの店構えとして認識できる）:

![closeup](docs/images/fpv_closeup.png)

ペルソナごとの性格（探索好き・効率重視・グルメ…）は **学習済みの重みに焼き込まれています**。
同じ景色を見ても、ペルソナによって出す行動が変わります。

---

## 2. なぜ DINOv2 か：建物の種類を「見分けられる」

DINOv2 は意味の近いものを近くに配置する埋め込み空間を持っています。実際に 8 種類の建物テクスチャを
DINOv2 に通して CLS の類似度を測ると、**飲食店（牛丼・ラーメン・弁当・カフェ）どうしが自然に固まります**：

![building similarity heatmap](docs/images/dinov2_similarity.png)

- 左上の赤枠（飲食店 4 種）の中が濃い＝**飲食店どうしは似ている**（平均 57）
- 飲食店 × 非食（オフィス等）は薄い（平均 41）

つまり「飲食店」という概念を、**クラスの枠（one-hot）で教え込まなくても、空間上の“ご近所”として認識できる**。
これにより「グルメな人は飲食店に寄っていく」といった行動を、報酬で軽く方向づけるだけで学習できます。

> 完全にクリーンな分離ではありません（牛丼屋と病院が見た目で近い等）。本プロジェクトは精度より
> 「DINOv2 的アプローチで世の中のものを見分けて行動できるか」の検証を主眼にしています。

---

## 3. アーキテクチャ（学習と本番で一貫）

学習（Colab・GPU）と本番（サーバー）で **同じテクスチャ・レイキャスタ＋同じ観測（CLS 384）** を使うのが肝です。

| | 学習（Colab / PyTorch） | 本番（サーバー / Node.js） |
|---|---|---|
| FPV 描画 | テクスチャ DDA レイキャスタ（GPU一括） | テクスチャ DDA レイキャスタ（JS） |
| 観測 | DINOv2 → CLS(384) のみ | DINOv2 → CLS(384) のみ |
| 種類認識 | テクスチャを DINOv2 が見て学習 | テクスチャを DINOv2 が見て推論 |
| 移動可否 | マップ配列（道路/建物が通行可） | マップ配列（`PASSABLE`） |
| 好み（例:グルメ） | `food_bonus` 報酬で学習 | `persona_X.onnx` の重みに宿る |

```
[学習: Colab] build_pro_onnx_by_persona.ipynb
   テクスチャFPV → DINOv2 → CLS → PPO学習 → persona_A〜E.onnx
                                          → dinov2_vits14.onnx (本体エクスポート)
        │  data/ にコピー
        ▼
[本番: server.js]  headless-gl + Three.js
   毎ステップ: 各エージェントのFPV → dinov2_vits14.onnx → CLS → persona_X.onnx → 行動
   映像: Three.jsで都市を描画 → JPEG → WebSocket → ブラウザ
```

### 3.1 1ステップの流れ（建物認識 → 学習 → ポリシー入力）

「DINOv2 が建物を認識し、その結果がどうポリシーに入るか」を 1 ステップ単位で具体的に追うと:

```
① 状態        各エージェントの (x, y, 向きθ)
② FPV描画     θ方向の一人称視点を DDAレイキャスタで 224×224×3 に描画
              → 建物の「見た目」(店のテクスチャ) がそのまま画像に映る
③ DINOv2      dinov2_vits14.onnx (ImageNet学習済み・凍結) に通す。出力は2つ:
              ・cls   (384)      = 画像全体の意味要約 =「今どんな景色/建物か」
              ・patch (256×384)  = 空間トークン (seg_head 用)
④ 建物認識    ここで“認識”は完了している。cls(384) は牛丼屋なら牛丼屋らしい座標、
              病院なら病院らしい座標に来る (§2の類似度がその証拠)。
              → 明示的な分類器は必須ではない (DINOv2 の埋め込み自体が認識)
⑤ 入力組み立て ポリシーへ渡すベクトルを作る:
              ・通常        : cls(384)
              ・目標条件付け : [cls(384), z(8)] = 392   (§4。z=ゼロなら従来と同じ)
⑥ ポリシー    persona_X.onnx (小さな FC + Actor、ペルソナ別) → logits(3)
              → softmax → サンプリングで「前進 / 左 / 右」を決定
⑦ 反映        行動でエージェントを動かし、次ステップへ。
              (SEG_GATE 時は seg_head の patch 判定で前方の通行可否を補助)
```

ポイントは、**重い「見る・認識する」部分（DINOv2）は凍結したまま全ペルソナで共有**し、
学習で育てるのは**末端の小さなヘッド（persona_X.onnx）だけ**であること。学習(Colab)も
本番(server.js)と**完全に同じ描画・同じ cls(384)** を使うので、両者の観測がズレません。

> DINOv2 本体（`dinov2_vits14.onnx`, 約84MB）は Meta公式の ViT-S/14 重みを
> `build_pro_onnx_by_persona.ipynb` が ONNX エクスポートしたもの。学習はしておらず、
> 凍結した「汎用の目」として使う。詳細は §2 と §7「設計の考え方」を参照。

---

## 4. 目標条件付け（z）— 行き先を外から指示する

通常のペルソナは「景色(cls)だけ」を見て自律的に動きます。ここに **目標ベクトル z** を足すと、
**「病院へ向かえ」「飲食店へ寄れ」といった行き先を外から指示**できるようになります（LLM 連携の足場）。

```
ポリシー入力 = [ cls(384), z(8) ] = 392
   z = 行き先の建物タイプ one-hot(8)  (gyudon, ramen, …, hospital)
   z が全ゼロ = 「目標なし」= 従来どおりの自律行動
```

### 仕組みと後方互換

- ポリシーは**書き換えない**。毎ステップ読み込む**入力スロット `z` を書き換えるだけ**で、次の推論tickから行動が変わる（重みは固定）。
- 学習時も `GOAL_NONE_PROB`（既定 0.4）の割合で **z=ゼロ** を混ぜて訓練するので、**z を渡さなければ今まで通りに動く**。
- メタの `goal_dim` で**新旧モデルを自動判別**：
  - 現行の `input_size=384` モデル（`goal_dim` なし）→ **z は無視＝完全に従来挙動**
  - 学習し直した `input_size=392` モデル（`goal_dim=8`）→ **z が有効**

### 学習（z 対応モデルを作る）

`build_pro_onnx_by_persona.ipynb` の**末尾「goal条件付けパッチ」セル**が、
`PolicyNet` / `PersonaVecEnv` / エクスポート / 学習ループを上書きして z 対応モデルを生成します
（パッチセルを削除すれば元の 384 構成に戻る）。Colab で再実行すると `persona_*.onnx` が `input_size=392`・
`goal_dim=8` で書き出されます。

> 注意: fc の入力次元が変わるため、旧 `ckpt_*.pt` は読み込めません（自動で新規学習に切替）。

### z をセットする（3通り）

| 経路 | 使い方 |
|---|---|
| **standalone UI** | 画面下「🎯 Goal」ボタン → ペルソナ別に行き先の建物タイプを選択（`?admin=1` でコントロール表示） |
| **standalone JS** | コンソール/連携から `setGoal('A', 7)`（病院へ）/ `setGoal('A', -1)`（解除） |
| **server HTTP** | `GET /goal?persona=A&type=7`（設定）/ `type=-1`（解除）/ `GET /goal`（一覧） |

いずれも内部的には各エージェントの `agent.goalZ`（`Float32Array(8)` の one-hot）を書き込みます。
建物タイプの index は `0:gyudon 1:ramen 2:bento 3:cafe 4:office 5:house 6:conbini 7:hospital`。

> 現行の 384 モデルでは設定は**保持されるが挙動には反映されません**（UI/`/goal` がその旨を表示）。
> 392 モデルに差し替えた瞬間、同じ UI/API がそのまま効きます。将来 LLM をつなぐ場合は、この
> `agent.goalZ`（または `/goal`）を LLM が書き込む口にします。

---

## 5. セットアップ & 実行

### 5.1 サーバー（本番）

```bash
npm install
# ローカル:
node server.js
# 本番(Linux, ヘッドレス):
xvfb-run -s "-screen 0 1x1x24" node server.js
# → http://localhost:8080
```

配信クライアントは 3 系統:

| URL | 内容 |
|---|---|
| `/` (`client.html`) | WebSocket で JPEG フレームを受信する軽量ビューア |
| `/standalone.html` | **ブラウザ単独版**。DINOv2/persona をブラウザ内で直接推論（`data/` `textures/` は server と共有配信） |
| `/goal` | 目標 z の設定・一覧 API（§4） |

> 旧 `/client/` は `/standalone.html` へ 301 リダイレクトします。
> standalone をデバッグ表示する場合は `?debug=1`、コントロールUI（Pause/Goal等）は `?admin=1`。

`data/` に必要なファイル（学習後に配置）:

```
data/
├── dinov2_vits14.onnx (+ .data)     ← DINOv2本体（全ペルソナ共有・1個・約84MB）
├── persona_A.onnx + persona_A_meta.json
├── ... (B〜E)
```

建物テクスチャ（`textures/`）はリポジトリに同梱済み。サーバー起動時に観測用に自動ロードされます。

起動ログで確認:
- `[Raycast] textures 8/8 loaded ready=true`
- `[ONNX] dinov2_vits14 OK`
- `[ONNX] persona_A OK  DINOv2(384)`（z 対応モデルなら `DINOv2(392)`）
- `[Infer] … フォールバック` が**出ていない**こと

### 5.2 学習（Colab・GPU）

`build_pro_onnx_by_persona.ipynb`（リポジトリ直下。goal 対応パッチ同梱）を使います。

1. **テクスチャをアップロード** → `/content/drive/MyDrive/mesa_textures/` に 8 枚（`gyudon, ramen, bento, cafe, office, house, conbini, hospital` の `.png`）。`textures/` ごと上げてOK。
2. **報酬を設定** → Drive の `persona_rewards.json`。グルメにしたいペルソナに 2 行足すだけ:
   ```jsonc
   "food_bonus": 8.0,
   "food_classes": [0, 1, 2, 3]   // gyudon, ramen, bento, cafe
   ```
3. **古いチェックポイントを削除** → `SAVE_DIR` の `ckpt_*.pt` を全消し（再開機能の罠＋構造変更のため）。
4. ランタイム再起動 → すべて実行。FPV のサンプル画像で「店が描けてるか」を確認。
5. 学習後、`persona_*.onnx` と `dinov2_vits14.onnx` を `data/` にコピー。

> 学習時間は `STEPS_PER_PERSONA` で調整（目安 `≈ sps × 1800` で約30分/人）。
> まず少なめ（数百万 step）でデモ品質を見て、良ければ増やすのが安全。

---

## 6. 主要な設定（環境変数 / パラメータ）

| 変数 | 既定 | 意味 |
|---|---|---|
| `WIDTH` / `HEIGHT` | 720 | 配信映像の解像度（メモリ/CPU に直結） |
| `FPS` | 30 | 配信フレームレート |
| `TICK` | 150 | シミュレーション 1 歩の間隔(ms) |
| `INFER_EVERY` | 10 | 何歩ごとに推論するか（上げると軽い） |
| `JPEG_Q` | 100 | JPEG 品質 |
| `MAX_TRAIL` | 500 | 軌跡(trail)の最大点数。長いほど遠くまで残るが描画コスト(メッシュ数)が増える |
| `SEG_GATE` | 0 | 1 で seg_head による前進判定（既定はマップ配列） |

メモリ/CPU が厳しいときは `INFER_EVERY` を上げる・`WIDTH/HEIGHT` を下げるのが効きます。

**軌跡(trail)の長さ** は可変です:
- サーバー: `MAX_TRAIL=300 node server.js`
- standalone: URL `?trail=300`、または実行中に `setTrailLength(300)`（短くした分は即削除）

---

## 7. 設計の考え方

### 「見て動く」の利点
- **新しいマップ・配置でも動く**：座標ではなく見た目で判断し、学習も Domain Randomization（毎回違うマップ）で行うため、配置が変わっても通用する。
- **前提**：視界(FOV)に入っていること。記憶や全体地図は持たない反応型なので「見えたら寄る／見えなければ探す」。

### なぜ one-hot ではなく埋め込みか
- 建物を「クラスの枠（one-hot 8個）」で表すと、新カテゴリ追加＝枠追加＝次元変化＝**全モデル作り直し**になり硬い。
- DINOv2 の CLS は **RGB が任意の色を 3 数字で表すように、任意の見た目を 384 数字で表す連続ベクトル**。新しい建物は「新しい座標」になるだけで次元は不変＝**オープン語彙で柔軟**。

### グルメ行動・目標(z)はどこにあるか
- ハードコードのルールはどこにもない。**そのペルソナの `persona_X.onnx`（学習済みの重み）の中**にある。
- `food_bonus`（reward）は**学習時にだけ**効いて重みを「飲食店に寄る形」に育てる。実行時に reward は使われない。
- 目標 z も同様で、**z を読めるように学習した重み**があって初めて効く（§4）。

### 限界
- 生の DINOv2 類似度はノイジー（牛丼屋↔病院など）なので挙動は粗い。精度を上げるなら：テクスチャの差別化、building_classifier 等の薄い学習層、視野の取り方の改善など。

---

## 8. ファイル構成

```
server.js            メインサーバー（headless-gl + Three.js + WebSocket/JPEG + 推論 + /goal API）
client.html          ブラウザクライアント（WebSocket受信版、 / で配信）
standalone/
  └── index.html     ブラウザ単独版（DINOv2/persona をブラウザで直接推論）
                     起動中の server から /standalone.html で配信。data/ textures/ は共有。
build_pro_onnx_by_persona.ipynb   ★学習＋ONNX生成（DINOv2エクスポート / persona PPO学習）
                     末尾に「goal条件付けパッチ」セルを同梱（z対応モデルを生成・§4）
data/                ONNX モデル（dinov2_vits14 / persona_* + meta）
textures/            建物テクスチャ（3D描画 & 観測レイキャスタ用）
docs/images/         README 用の図
NPC_INFERENCE.md     推論パイプラインの詳細メモ
dinov2seg/           DINOv2/seg 関連の補助ノートブック・解説
webrtc-version/      WebRTC 配信版（別実装）
```

---

## 9. 最近の追加機能（このセッションでの変更）

- **standalone のルート整理**：`/client/index.html` → **`/standalone.html`** に変更（旧URLは301リダイレクト）。ファイルは `standalone/index.html` に移動。
- **人型モデルの刷新**：箱の積み木から、丸い頭＋髪・テーパー胴体・脚を持つ陰影付き（`MeshLambert`）の立ち姿へ。server.js / standalone 共通。
- **目標条件付け（z）**：ポリシー入力を `[cls, z]` に拡張（§4）。z で行き先を指示でき、`agent.goalZ` / standalone「🎯 Goal」UI / server `/goal` API から設定。z 未指定なら従来挙動。
- **軌跡(trail)の可変化**：上限を `MAX_TRAIL`（env）/ `?trail=` / `setTrailLength()` で調整可能に（§6）。

---

## 補足

- 配信は WebSocket + JPEG 方式（`server.js`）。WebRTC 版は `webrtc-version/` を参照。
- `headless-gl` は CPU レンダリングのため、解像度・FPS がそのまま負荷になります。
- Linux でエラー時: `apt-get install libgl1-mesa-dev xvfb`。
