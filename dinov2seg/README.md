# MESA — MultiEntity Simulation Architecture

**ペルソナを定義するだけで、AIエージェントの行動特性が変わる都市シミュレーション**

LLMがペルソナ説明から報酬関数を自動生成し、FPV（一人称視点）カメラ画像 + DINOv2 + セグメンテーションを組み合わせたPPO強化学習でエージェントごとの行動ポリシーを学習させます。マップ配列に頼らず**画像だけで移動判断・建物認識**を行う、現実のロボットに近い設計です。

---

## コンセプト

```
「人間の行動は、その人のペルソナによって形成される」

ペルソナ A: 探索者   → マップを広く歩き回る
ペルソナ B: 慎重派   → 最短経路を繰り返す
ペルソナ C: 社交家   → 他エージェントに近づく
ペルソナ D: 効率主義 → 直進してゴールへ
ペルソナ E: 観光客   → 建物周辺をゆっくり巡る

さらに:
  「お腹が空いた → 牛丼屋を探す」
  FPV画像をDINOv2で解析 → 牛丼屋を認識して向かう
```

---

## システム全体像

```
┌──────────────────────────────────────────────────────────────────┐
│  Step 1   ペルソナ定義 + 報酬設計                                 │
│  Step 1.5 建物分類ヘッド学習   → building_classifier.onnx        │
│  Step 1.6 セグメンテーション学習 → seg_head.onnx                  │
│  Step 2   FPV + DINOv2 PPO学習  → persona_A〜E.onnx             │
│  Step 3   Three.js ブラウザビジュアライザー                        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 観測パイプライン

```
FPV画像 (224×224×3ch)  視野角60度 / レイ224本 / 最大8セル

  ↓ DINOv2 forward_features()

  CLS token (384次元)      Patch tokens (256×384次元)
       ↓                          ↓
  建物分類ヘッド              セグメンテーションヘッド
  8クラス確率               5クラス (open=道路方向)
       ↓                          ↓
  concat (392次元)         前方中央が open → 前進可能
       ↓
  FC PolicyNet → 前進 / 左回転 / 右回転
```

---

## ファイル構成

```
mesa/
├── README.md
│
├── 📓 メインパイプライン (この順番で実行)
│   ├── step1_persona_reward_gen.ipynb       ペルソナ → 報酬パラメータJSON
│   ├── step1_5_building_classifier.ipynb   建物分類ヘッド学習 → ONNX
│   ├── step1_6_seg_head.ipynb              セグメンテーション学習 → ONNX
│   ├── step2_persona_train.ipynb            PPO学習 → ペルソナ別ONNX
│   └── step3_persona_city_sim.html          ブラウザビジュアライザー
│
├── 📄 サンプルデータ
│   └── persona_rewards.json                APIキーなしで試せるサンプル
│
├── 📁 data/  (学習後にここに配置)
│   ├── persona_A.onnx + persona_A_meta.json
│   ├── persona_B.onnx + persona_B_meta.json
│   ├── persona_C.onnx + persona_C_meta.json
│   ├── persona_D.onnx + persona_D_meta.json
│   ├── persona_E.onnx + persona_E_meta.json
│   ├── building_classifier.onnx + building_classifier_meta.json
│   └── seg_head.onnx + seg_head_meta.json
│
└── 📁 archive/  (旧版・現行版に統合済み・通常不要)
    ├── city_fp_sim.html
    ├── city_sim_pure_rl.html
    ├── genesis_fp_rl_colab.ipynb
    ├── genesis_pure_rl_colab.ipynb
    ├── fix_onnx_singlefile.ipynb
    ├── gpu_diagnosis.ipynb
    └── MESA_FPV_presentation.pptx
```

---

## 実行手順

### 事前準備

```bash
cd mesa/
python3 -m http.server 8000
# → http://localhost:8000/step3_persona_city_sim.html
```

---

### Step 1: ペルソナ定義 → 報酬パラメータ生成

**ファイル:** `step1_persona_reward_gen.ipynb`
**環境:** Google Colab (CPU可) / **所要時間:** 約5分

```python
# セル2: APIキーを設定
ANTHROPIC_API_KEY = 'sk-ant-...'

# セル3: ペルソナを編集
PERSONAS = [
    { "id": "A", "name": "探索者タロウ",
      "description": "20歳。新しい場所に積極的。同じ道は通りたがらない。" },
    # B〜E も定義...
]
```

**出力:** `persona_rewards.json`

> APIキーがない場合はリポジトリ内の `persona_rewards.json` をそのまま使えます。

---

### Step 1.5: 建物分類ヘッド学習

**ファイル:** `step1_5_building_classifier.ipynb`
**環境:** Google Colab T4 推奨 / **所要時間:** 約10〜15分

```
セル3: Unsplashから各クラス5枚を自動ダウンロード
セル4: DINOv2で特徴抽出 → t-SNEで可視化
セル5: 分類ヘッド学習 (200epoch)
セル6: 混同行列で精度確認
セル7: building_classifier.onnx をエクスポート
```

精度の目安: 各5枚→70〜80% / 各20枚→85〜95% / 各50枚→95%+

自分の写真を追加する場合:
```
/content/drive/MyDrive/mesa_persona/building_images/
  gyudon/   my_photo_01.jpg  ← 追加してセル4〜7を再実行
```

**出力:** `building_classifier.onnx` + `building_classifier_meta.json`

> スキップ可能。スキップ時は建物分類スコアがゼロで代替されます。

---

### Step 1.6: セグメンテーションヘッド学習

**ファイル:** `step1_6_seg_head.ipynb`
**環境:** Google Colab T4 推奨 / **所要時間:** 約20〜30分

```
セル4: FPV画像 + セグマスクの自動生成を確認
セル5: 5000枚のデータを自動生成 (アノテーション作業ゼロ)
セル6: DINOv2 + SegHead 定義
セル7: セグメンテーション学習 (mIoUで評価)
セル8: 予測結果の可視化
セル9: seg_head.onnx をエクスポート
```

データ生成の仕組み:
```
ランダムな位置・向き・マップで FPV画像を撮影
  ↓
同じレイキャストでセルタイプを自動ラベル付け
  → アノテーション不要で5000枚生成
```

セグメンテーションクラス:

| ID | クラス | 移動判定 |
|----|--------|---------|
| 0 | sky | — |
| 1 | ground | — |
| **2** | **open** | **前方中央がこれ → 前進可能** |
| 3 | building | — |
| 4 | tree | — |

**出力:** `seg_head.onnx` + `seg_head_meta.json`

> スキップ可能。スキップ時は移動判定がマップ配列フォールバックになります。

---

### Step 2: FPV + DINOv2 PPO強化学習

**ファイル:** `step2_persona_train.ipynb`
**環境:** Google Colab **T4 GPU 必須**
**所要時間:** 約1〜2時間 / ペルソナ × 5ペルソナ

セル構成:

| セル | 内容 |
|------|------|
| 1 | インストール |
| 2 | インポート・GPU確認・Drive マウント |
| 3 | 定数 (IMG_W=224, DINO_MODEL, N_ENVS) |
| 4 | 有機的マップ生成 + Domain Randomization |
| 5 | FPV画像 GPU一括レンダリング (JIT) |
| 6 | PersonaVecEnv (セグ移動判定対応) |
| 7 | DINOv2 + 分類ヘッド + セグヘッド + PolicyNet |
| 8 | ONNX エクスポート |
| 9 | train_persona (Domain Randomization対応) |
| 10 | 報酬パラメータ読み込み |
| 11 | 全ペルソナ学習 → ONNX生成 |
| 12 | 最終確認 |

重要な設定 (セル3):
```python
IMG_W               = 224      # DINOv2 の入力サイズ
DINO_MODEL          = 'dinov2_vits14'   # 384次元
N_ENVS              = 4096     # 並列環境数
MAP_RANDOMIZE_EVERY = 20       # 20 update ごとにマップ変更 (0=固定)
```

VRAMが足りない場合:
```python
N_ENVS  = 1024   # 4096 → 1024
ROLLOUT = 64     # 128  → 64
```

自動読み込みされるファイル:
```
seg_head.onnx              → 移動判定 (なければMAP配列フォールバック)
building_classifier.onnx   → 建物分類スコア (なければゼロ代替)
persona_rewards.json        → 報酬パラメータ
```

**出力:** `persona_A〜E.onnx` + `persona_A〜E_meta.json`

---

### Step 3: ブラウザで動かす

**ファイル:** `step3_persona_city_sim.html`
**必須:** ローカルサーバー (`file://` 不可)

```bash
python3 -m http.server 8000
```

起動モードの選択:

| ボタン | 内容 |
|--------|------|
| **▶ Start Default ONNX** | `./data/` から自動読み込み (推奨) |
| **Start Simulation** | ONNXを手動選択 |
| **Skip (Random Mode)** | ONNXなしで動作確認 |

ステータス表示 (右下):
```
✓ DINOv2 Ready | ✓ SegHead Ready   → 全機能有効 (画像ベース移動判定)
✓ DINOv2 Ready                      → 移動判定はMAPフォールバック
⚠ DINOv2 unavailable                → CNNフォールバックで動作
```

操作方法:

| 操作 | 内容 |
|------|------|
| ペルソナカードをクリック | FPV画面を切り替え |
| **🎲 New Map** | マップをランダム生成 |
| **FP View** | 推論に使うFPV画像を表示 |
| **Trail** | 軌跡表示 |
| **Speed ×1/2/4** | 速度変更 |
| **Pause / Reset** | 一時停止 / リセット |

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| PyTorch + PPO | 強化学習 |
| DINOv2 ViT-S/14 | 視覚特徴抽出 (frozen) |
| TorchScript JIT | GPU並列FPVレンダリング |
| ONNX / onnxruntime-web | ブラウザ推論 |
| Transformers.js | ブラウザ上のDINOv2 |
| Three.js | 3Dビジュアライザー |
| Claude API | ペルソナ → 報酬パラメータ生成 |

---

## 開発ロードマップ

```
Grid RL → Raycast RL (22次元) → FPV-CNN (64×64)
  ↓
DINOv2 + 建物分類 (224×224)
  ↓
DINOv2 + 建物分類 + セグメンテーション移動判定  ← 現在
  ↓
Hierarchical Agent: LLM (計画) × DINOv2 (認識) × PPO (行動)
  「お腹が空いた → 牛丼屋を探して入る」
  ↓
Sim2Real: 実カメラ映像 → 同じDINOv2 → 実ロボット行動
```

---

## ライセンス

MIT License

---

## 関連プロジェクト

- [DINOv2 (Meta AI)](https://github.com/facebookresearch/dinov2)
- [Transformers.js (HuggingFace)](https://huggingface.co/docs/transformers.js)
- [LeRobot (HuggingFace)](https://github.com/huggingface/lerobot)
- [NVIDIA Cosmos WorldModel](https://www.nvidia.com/en-us/research/cosmos/)
