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
[学習: Colab] step2_persona_train_food.ipynb
   テクスチャFPV → DINOv2 → CLS → PPO学習 → persona_A〜E.onnx
                                          → dinov2_vits14.onnx (本体エクスポート)
        │  data/ にコピー
        ▼
[本番: server.js]  headless-gl + Three.js
   毎ステップ: 各エージェントのFPV → dinov2_vits14.onnx → CLS → persona_X.onnx → 行動
   映像: Three.jsで都市を描画 → JPEG → WebSocket → ブラウザ
```

---

## 4. セットアップ & 実行

### 4.1 サーバー（本番）

```bash
npm install
# ローカル:
node server.js
# 本番(Linux, ヘッドレス):
xvfb-run -s "-screen 0 1x1x24" node server.js
# → http://localhost:8080
```

`data/` に必要なファイル（学習後に配置）:

```
data/
├── dinov2_vits14.onnx (+ .data)     ← DINOv2本体（全ペルソナ共有・1個）
├── persona_A.onnx + persona_A_meta.json
├── ... (B〜E)
```

建物テクスチャ（`textures/`）はリポジトリに同梱済み。サーバー起動時に観測用に自動ロードされます。

起動ログで確認:
- `[Raycast] textures 8/8 loaded ready=true`
- `[ONNX] dinov2_vits14 OK`
- `[ONNX] persona_A OK  DINOv2(384)`
- `[Infer] … フォールバック` が**出ていない**こと

### 4.2 学習（Colab・GPU）

`dinov2seg/step2_persona_train_food.ipynb` を使います。

1. **テクスチャをアップロード** → `/content/drive/MyDrive/mesa_textures/` に 8 枚（`gyudon, ramen, bento, cafe, office, house, conbini, hospital` の `.png`）。`textures/` ごと上げてOK。
2. **報酬を設定** → Drive の `persona_rewards.json`。グルメにしたいペルソナに 2 行足すだけ:
   ```jsonc
   "food_bonus": 8.0,
   "food_classes": [0, 1, 2, 3]   // gyudon, ramen, bento, cafe
   ```
3. **古いチェックポイントを削除** → `SAVE_DIR` の `ckpt_*.pt` を全消し（再開機能の罠＋構造変更のため）。
4. ランタイム再起動 → すべて実行。`cell5` でテクスチャ FPV のサンプルが表示されるので「店が描けてるか」を確認。
5. 学習後、`persona_*.onnx` と `dinov2_vits14.onnx` を `data/` にコピー。

> 学習時間は `STEPS_PER_PERSONA`（cell3）で調整。`STEPS_PER_PERSONA ≈ sps × 1800` で約30分/人。
> まず少なめ（数百万 step）でデモ品質を見て、良ければ増やすのが安全。

---

## 5. 主要な設定（環境変数）

| 変数 | 既定 | 意味 |
|---|---|---|
| `WIDTH` / `HEIGHT` | 200 | 配信映像の解像度（メモリ/CPU に直結） |
| `FPS` | 12 | 配信フレームレート |
| `TICK` | 150 | シミュレーション 1 歩の間隔(ms) |
| `INFER_EVERY` | 10 | 何歩ごとに推論するか（上げると軽い） |
| `JPEG_Q` | 70 | JPEG 品質 |
| `SEG_GATE` | 0 | 1 で seg_head による前進判定（既定はマップ配列） |

メモリ/CPU が厳しいときは `INFER_EVERY` を上げる・`WIDTH/HEIGHT` を下げるのが効きます。

---

## 6. 設計の考え方

### 「見て動く」の利点
- **新しいマップ・配置でも動く**：座標ではなく見た目で判断し、学習も Domain Randomization（毎回違うマップ）で行うため、配置が変わっても通用する。
- **前提**：視界(FOV)に入っていること。記憶や全体地図は持たない反応型なので「見えたら寄る／見えなければ探す」。

### なぜ one-hot ではなく埋め込みか
- 建物を「クラスの枠（one-hot 8個）」で表すと、新カテゴリ追加＝枠追加＝次元変化＝**全モデル作り直し**になり硬い。
- DINOv2 の CLS は **RGB が任意の色を 3 数字で表すように、任意の見た目を 384 数字で表す連続ベクトル**。新しい建物は「新しい座標」になるだけで次元は不変＝**オープン語彙で柔軟**。

### グルメ行動はどこにあるか
- ハードコードのルールはどこにもない。**そのペルソナの `persona_X.onnx`（学習済みの重み）の中**にある。
- `food_bonus`（reward）は**学習時にだけ**効いて重みを「飲食店に寄る形」に育てる。実行時に reward は使われない。

### 限界
- 生の DINOv2 類似度はノイジー（牛丼屋↔病院など）なので挙動は粗い。精度を上げるなら：テクスチャの差別化、building_classifier 等の薄い学習層、視野の取り方の改善など。

---

## 7. ファイル構成

```
server.js            メインサーバー（headless-gl + Three.js + WebSocket/JPEG + 推論）
client.html          ブラウザクライアント
data/                ONNX モデル（dinov2_vits14 / persona_* + meta）
textures/            建物テクスチャ（3D描画 & 観測レイキャスタ用）
docs/images/         README 用の図
NPC_INFERENCE.md     推論パイプラインの詳細メモ
dinov2seg/
  ├── step2_persona_train_food.ipynb   ★テクスチャ学習＋CLS(384) 本体
  ├── METHOD_A_food_persona.md         グルメ実装の解説
  └── step1_*/step2_*                  補助・旧バージョン
webrtc-version/      WebRTC 配信版（別実装）
```

---

## 補足

- 配信は WebSocket + JPEG 方式（`server.js`）。WebRTC 版は `webrtc-version/` を参照。
- `headless-gl` は CPU レンダリングのため、解像度・FPS がそのまま負荷になります。
- Linux でエラー時: `apt-get install libgl1-mesa-dev xvfb`。
