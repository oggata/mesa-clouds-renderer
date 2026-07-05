---
# 第3章　物理エンジン基礎 — 6つのソルバーを使いこなす
---

本章では、Genesisの心臓部である物理エンジンを理解する。Genesisが提供する6つの物理ソルバー——剛体・MPM・SPH・FEM・PBD・Stable Fluid——それぞれの原理と使いどころを、実際に動くコードとともに学ぶ。これらの理解は、後章のロボット強化学習やMESA都市シミュレーターの設計に直結する。

:::message
💻 **実行環境の目安**：本章の剛体・小規模なMPM/FEM/PBDの動作確認は、**M4 Macのローカル**（`backend=gs.metal` または `gs.cpu`）で動きます。大量の粒子を使う流体（SPH）や高解像度のStable Fluidは重くなるので、そこは**Colab（`gs.cuda`）**に回すのが快適です。以降のコードは環境に応じて `gs.init()` のバックエンドを読み替えてください。
:::

## 3.1　Genesisの設定システム（Config System）

各ソルバーに入る前に、シーン設定の全体構造を把握しておこう。Genesisの「Config System」は、シーンの全コンポーネントを明示的に設定できる設計になっている。

```python
import genesis as gs
gs.init(backend=gs.gpu)   # 環境が自動判定される（Mac=metal / Colab=cuda）

scene = gs.Scene(
    # ── シミュレーション全体設定 ──
    sim_options=gs.options.SimOptions(
        dt=0.01,               # タイムステップ（秒）
        substeps=1,            # サブステップ数（流体系は10以上推奨）
        gravity=(0, 0, -9.81),
        requires_grad=False,   # 微分可能シミュレーション（第12章）
    ),
    # ── ソルバー間の結合設定 ──
    coupler_options=gs.options.CouplerOptions(
        rigid_mpm=True,        # 剛体とMPMの結合
        rigid_sph=True,        # 剛体とSPHの結合
        rigid_pbd=True,        # 剛体とPBDの結合
    ),
    # ── 各ソルバー固有の設定（使うものだけでよい） ──
    mpm_options=gs.options.MPMOptions(lower_bound=(-1,-1,0), upper_bound=(1,1,2)),
    sph_options=gs.options.SPHOptions(lower_bound=(-0.5,-0.5,0), upper_bound=(0.5,0.5,1), particle_size=0.01),
    # ── 可視化 ──
    viewer_options=gs.options.ViewerOptions(camera_fov=40, res=(1280, 720)),
    show_viewer=True,          # Colabでは False
)
```

**使わないソルバーのオプションは省略してよい。** 必要なソルバーだけ指定することで、シーンを軽量に保てる（Macで動かすときは特に重要）。

エンティティの追加は常に「形状（morph）・素材（material）・外観（surface）」の3点セットで行う。

```python
entity = scene.add_entity(
    morph=gs.morphs.Box(),           # 形状（Box, Sphere, Mesh, URDF...）
    material=gs.materials.Rigid(),   # 素材（どのソルバーを使うか）
    surface=gs.surfaces.Default(),   # 外観（色・テクスチャ・反射）
)
```

## 3.2　剛体ソルバー（Rigid Body）— まずはこれ

剛体ソルバーは最も基本的で、最速のソルバーだ。金属・木材・プラスチックなど変形しない物体に使う。ロボットのリンク・関節・床や壁など、ロボティクスシミュレーションの大部分は剛体で構成される。**43 million FPSはこの剛体ソルバーの数字**であり、Macでも軽快に動く。

```python
import genesis as gs
gs.init(backend=gs.metal)   # Macの場合。Colabなら gs.cuda

scene = gs.Scene(
    viewer_options=gs.options.ViewerOptions(camera_pos=(2,2,1.5), camera_lookat=(0,0,0.5), camera_fov=50, max_FPS=60),
    show_viewer=True, show_FPS=True,
)
plane = scene.add_entity(gs.morphs.Plane())   # 地面

box = scene.add_entity(   # 剛体ボックス（赤）
    material=gs.materials.Rigid(rho=1000.0, friction=0.5),
    morph=gs.morphs.Box(pos=(0,0,1.0), size=(0.2,0.2,0.2), euler=(30,0,45)),
    surface=gs.surfaces.Default(color=(0.8, 0.3, 0.3, 1.0)),
)
sphere = scene.add_entity(   # 剛体球（青）
    morph=gs.morphs.Sphere(pos=(0.3,0,2.0), radius=0.1),
    surface=gs.surfaces.Default(color=(0.3, 0.6, 0.9, 1.0)),
)

scene.build()
for i in range(500):
    scene.step()
    if i % 50 == 0:
        print(f"step {i}: pos={box.get_pos()}, vel={box.get_vel()}")
```

![画像](https://static.zenn.studio/user-upload/fce0e0f7b633-20260306.gif)

利用できる代表的な形状（morph）は次の通り。

| morph | 説明 |
|---|---|
| `gs.morphs.Plane()` | 無限平面（地面） |
| `gs.morphs.Box()` | 直方体（pos, size, euler） |
| `gs.morphs.Sphere()` | 球（pos, radius） |
| `gs.morphs.Cylinder()` | 円柱（pos, radius, height） |
| `gs.morphs.Mesh(file=...)` | OBJ/GLB/PLY/STLメッシュ |
| `gs.morphs.URDF(file=...)` | URDFロボット定義（第4章） |
| `gs.morphs.MJCF(file=...)` | MuJoCo XMLロボット定義 |

## 3.3　MPMソルバー（Material Point Method）

MPM（物質点法）は、粒子（Particle）とグリッド（Grid）の両方を使うハイブリッド手法で、弾性体・可塑性体・液体・砂・雪など「変形する物質」を幅広く扱える。**MPMはGenesisで唯一「微分可能」に対応する主要ソルバー**であり、勾配を使った制御最適化ができる（第12章）。

| 材料タイプ | クラス | 用途例 |
|---|---|---|
| 弾性体 | `MPM.Elastic()` | ゴムボール・シリコン |
| 液体 | `MPM.Liquid()` | ジェル・粘性液体 |
| 砂 | `MPM.Sand()` | 砂・粉体・土壌 |
| 雪 | `MPM.Snow()` | 雪・ふわふわ素材 |
| 泡沫 | `MPM.Foam()` | スポンジ・クッション |
| 筋肉 | `MPM.Muscle()` | ソフトロボット |

弾性体・液体・砂を同一シーンに共存させる例（粒子が多いので**Colab推奨**）。

```python
import genesis as gs
gs.init(backend=gs.cuda)   # 粒子が多いのでColab等のGPUが快適

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=4e-3, substeps=10),
    mpm_options=gs.options.MPMOptions(lower_bound=(-0.5,-1,0), upper_bound=(0.5,1,1)),
    viewer_options=gs.options.ViewerOptions(camera_pos=(2,2,1.5), camera_lookat=(0,0,0.3), camera_fov=50, max_FPS=60),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
elastic = scene.add_entity(   # 弾性体（赤）
    material=gs.materials.MPM.Elastic(E=1e4, nu=0.2),
    morph=gs.morphs.Box(pos=(0,-0.5,0.3), size=(0.2,0.2,0.2)),
    surface=gs.surfaces.Default(color=(1.0,0.4,0.4), vis_mode='visual'),
)
liquid = scene.add_entity(   # 液体（青）
    material=gs.materials.MPM.Liquid(sampler='regular'),
    morph=gs.morphs.Box(pos=(0,0,0.3), size=(0.3,0.3,0.3)),
    surface=gs.surfaces.Default(color=(0.4,0.7,1.0), vis_mode='particle'),
)
sand = scene.add_entity(   # 砂（黄）
    material=gs.materials.MPM.Sand(friction_angle=30),
    morph=gs.morphs.Box(pos=(0,0.5,0.3), size=(0.2,0.2,0.2)),
    surface=gs.surfaces.Default(color=(0.9,0.8,0.3), vis_mode='particle'),
)
scene.build()
for i in range(1000):
    scene.step()
```

![画像](https://static.zenn.studio/user-upload/4ae2543745b8-20260306.gif)

MPMの `lower_bound` / `upper_bound` はシミュレーション領域の境界ボックスで、この外に出た粒子は削除される。シーンのスケールに合わせて必ず設定する。また `substeps=10` は安定性のために必要で、MPMで `substeps=1` だと発散しやすい。

**微分可能MPM**は、シミュレーション結果に損失を定義し、PyTorchのように勾配を逆伝播できる。`SimOptions(requires_grad=True)` を有効にすると、ロボットの制御パラメータをシミュレーションを通じて直接最適化できる（詳細は第12章）。

## 3.4　SPHソルバー（Smoothed Particle Hydrodynamics）

SPH（平滑化粒子流体力学）は、流体を粒子の集合として表現するラグランジュ法だ。MPMの液体モードより厳密な流体力学を表現でき、水・油・粘性流体の精密なシミュレーションに向く。

| 比較 | `MPM.Liquid()` | `SPH.Liquid()` |
|---|---|---|
| 計算方式 | ハイブリッド（粒子＋グリッド） | 純粒子（ラグランジュ） |
| 流体精度 | 中程度 | 高精度 |
| 計算速度 | 速い | やや遅い |
| 粘性制御 | 間接的 | mu/gammaで直接制御 |

```python
import genesis as gs
gs.init(backend=gs.cuda)   # 粒子が多いのでColab推奨

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=4e-3, substeps=10),
    sph_options=gs.options.SPHOptions(lower_bound=(-0.5,-0.5,0), upper_bound=(0.5,0.5,1), particle_size=0.01),
    viewer_options=gs.options.ViewerOptions(camera_pos=(2,2,1.5), camera_lookat=(0,0,0.5), camera_fov=50, max_FPS=60),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
water = scene.add_entity(
    material=gs.materials.SPH.Liquid(sampler='regular'),
    morph=gs.morphs.Box(pos=(0,0,0.5), size=(0.4,0.4,0.4)),
    surface=gs.surfaces.Default(color=(0.4,0.8,1.0,0.8), vis_mode='particle'),
)
scene.build()
for i in range(1000):
    scene.step()
    if i == 0:
        print(f"粒子数: {water.n_particles}, 位置shape: {water.get_particles_pos().shape}")
```

![画像](https://static.zenn.studio/user-upload/cf7b0dc4ed8d-20260306.gif)

第9章のMESA都市シミュレーターでは、噴水・水たまり・雨のシミュレーションにSPHが使える。視覚的リアリティを高めつつ、エージェントの回避行動（水たまりを避けて歩く）の学習環境として機能する。

## 3.5　FEMソルバー（Finite Element Method）

FEM（有限要素法）は、物体を有限個の要素（メッシュ）に分割し、各要素の変形を方程式で解く。ゴム・シリコン・生体組織など「変形するが流れない」弾性体の精密シミュレーションに最も適している。

```python
import genesis as gs
gs.init(backend=gs.metal)   # 小規模ならMacでも動く

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=2e-3, substeps=20),
    fem_options=gs.options.FEMOptions(),
    viewer_options=gs.options.ViewerOptions(camera_pos=(2,2,1.5), camera_lookat=(0,0,0.5), camera_fov=50, max_FPS=60),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
rubber_ball = scene.add_entity(
    material=gs.materials.FEM.Elastic(E=5e4, nu=0.45, rho=1200.0),
    morph=gs.morphs.Sphere(pos=(0,0,1.0), radius=0.15),
    surface=gs.surfaces.Default(color=(0.2,0.8,0.4,1.0)),
)
scene.build()
for i in range(500):
    scene.step()
```

![画像](https://static.zenn.studio/user-upload/9bfa52941e6d-20260306.gif)

パラメータの目安は、ヤング率 E＝1e3（柔らかいゲル）〜1e7（硬いゴム）、ポアソン比 nu＝0.0〜0.499（ほぼ非圧縮）。ゴムは nu＝0.45〜0.49 が典型値だ。

## 3.6　PBDソルバー（Position-Based Dynamics）

PBD（位置ベース力学）は、力方程式ではなく「位置の拘束条件」を直接解く手法で、布・ロープ・紐など「薄くて変形する物体」が得意だ。計算効率に優れる。材料は `PBD.Cloth()`（布）・`PBD.Elastic()`（体積変形体）・`PBD.Liquid()`（軽量液体）・`PBD.Granular()`（粒状物質）がある。

```python
import genesis as gs
gs.init(backend=gs.cuda)

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=4e-3, substeps=10),
    viewer_options=gs.options.ViewerOptions(camera_pos=(2,2,1.5), camera_lookat=(0,0,0.5), camera_fov=30, res=(1280,720), max_FPS=60),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
cloth = scene.add_entity(
    material=gs.materials.PBD.Cloth(),
    morph=gs.morphs.Mesh(file='meshes/cloth.obj', scale=2.0, pos=(0,0,0.5)),
    surface=gs.surfaces.Default(color=(0.2,0.4,0.8,1.0), vis_mode='visual'),
)
scene.build()
cloth.fix_particles([0, 10, 110, 120])   # build() の後で角を固定
for i in range(1000):
    scene.step()
```

![画像](https://static.zenn.studio/user-upload/990230a8d89e-20260306.gif)

MESA都市シミュレーターでは、風にはためく旗・テント・衣服をPBDで表現でき、エージェントが布に触れたときの反応も物理的に正確にシミュレートされる。

## 3.7　Stable Fluidソルバー（気体・煙・炎）

Stable Fluid（安定流体）は、オイラー法ベースの気体シミュレーションだ。固定グリッド上で速度・密度・温度を計算し、煙・蒸気・炎・霧など「体積的な気体現象」に使う。気体が「グリッドに束縛された場（Field）」として存在するため、大規模な気体の流れを効率的に表現できる。`res`（グリッド解像度）を上げるほど精密だが重くなるので、高解像度はColab向きだ。

```python
import genesis as gs
gs.init(backend=gs.cuda)

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=2e-2, substeps=5),
    sf_options=gs.options.SFOptions(lower_bound=(-1,-1,0), upper_bound=(1,1,2), res=64),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
smoke = scene.add_entity(
    material=gs.materials.SF.Smoke(density=1.0, temperature=500.0, buoyancy=0.5),  # 高温ほど上昇
    morph=gs.morphs.Box(pos=(0,0,0.1), size=(0.2,0.2,0.05)),
)
scene.build()
for i in range(500):
    scene.step()
```

## 3.8　マルチソルバー結合 — 異なる素材を同一シーンに

Genesisの最大の特徴の一つが「複数のソルバーを同一シーンで結合できる」ことだ。剛体のロボットがMPMの液体をすくい、FEMの弾性体をつまみ、PBDの布をめくる——これらを1つのシーンで同時にシミュレートできる。結合は `coupler_options` で明示的に有効化する。

```python
scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=4e-3, substeps=10),
    coupler_options=gs.options.CouplerOptions(rigid_mpm=True, rigid_sph=True, rigid_pbd=True),
    mpm_options=gs.options.MPMOptions(lower_bound=(-1,-1,0), upper_bound=(1,1,1.5)),
    show_viewer=True,
)
plane  = scene.add_entity(gs.morphs.Plane())
robot  = scene.add_entity(gs.morphs.URDF(file='robot.urdf'))
liquid = scene.add_entity(material=gs.materials.MPM.Liquid(), morph=...)
cloth  = scene.add_entity(material=gs.materials.PBD.Cloth(), morph=...)
scene.build()
for i in range(500):
    scene.step()   # 剛体ロボットが液体・布と相互作用しながら進む
```

ただしマルチソルバーは計算コストが増える。**強化学習で並列RLをするときは、不要なソルバーを有効にしないこと。** 例えばSO-101の把持学習なら剛体のみで十分なケースが多く、そのぶんMacやColabで軽く回せる。

## 3.9　ソルバー選択クイックガイド

| シミュレートしたいもの | 推奨ソルバー | 材料クラス |
|---|---|---|
| ロボットリンク・機械部品・建物 | Rigid | `gs.materials.Rigid()` |
| ゴム・シリコン・グリッパー（大変形） | MPM | `gs.materials.MPM.Elastic()` |
| ゴム・タイヤ（精密弾性） | FEM | `gs.materials.FEM.Elastic()` |
| ゼリー・ゲル・液状食品 | MPM | `gs.materials.MPM.Liquid()` |
| 水・油・精密液体 | SPH | `gs.materials.SPH.Liquid()` |
| 砂・粉体・土壌 | MPM | `gs.materials.MPM.Sand()` |
| 雪・泡 | MPM | `gs.materials.MPM.Snow()` / `Foam()` |
| 布・衣服・旗・ロープ | PBD | `gs.materials.PBD.Cloth()` |
| 煙・蒸気・炎・霧 | Stable Fluid | `gs.materials.SF.Smoke()` |
| ソフトロボットの筋肉 | MPM | `gs.materials.MPM.Muscle()` |

:::message
📷 **画像プレースホルダー**：ソルバー選択のフローチャート。「変形する？→流れる？→薄い？→気体？」といった分岐で、Rigid/MPM/SPH/FEM/PBD/Stable Fluidのどれを選ぶかを一目で判断できる図。
:::

## 3.10　まとめ

- Genesisは6つの物理ソルバー（Rigid・MPM・SPH・FEM・PBD・Stable Fluid）を統一フレームワークで提供する。
- 素材は `material=`、形状は `morph=`、外観は `surface=` で指定する。
- **剛体は最速でMacでも軽快**。MPMは弾性体・液体・砂・雪・筋肉を扱える汎用ソルバーで、かつ微分可能。SPHは精密流体、FEMは精密弾性、PBDは布・ロープに特化する。
- 粒子が多い流体（SPH）や高解像度のStable Fluidは重いので、**Colabに回す**のが快適。
- `coupler_options` で異なるソルバー間を結合すると、剛体ロボットが液体・布と相互作用するシーンを作れる。
- 強化学習では不要なソルバーを有効にせず、剛体のみで完結させるとパフォーマンスが最大化される。

次章では、この物理エンジンの上でロボット——関節・URDFファイル・センサー——を扱う方法を学ぶ。


---
# 第4章　ロボット統合基礎 — URDF・制御・IK・センサー
---

本章では、Genesisでロボットを動かすための基本スキルをまとめて習得する。URDFファイルの読み込みから、ジョイントとDoFの概念、3種類の制御モード（位置・速度・トルク）、逆運動学（IK）によるエンドエフェクター制御、把持動作、そしてカメラ・IMUなどセンサーの使い方まで、ひと通り解説する。ここで身につけたことが、第5章以降のSO-101制御と強化学習の直接の土台になる。

:::message
💻 **実行環境の目安**：本章の内容は、URDF読み込み・制御・IK・可視化まで**すべてM4 Macで動く**（`backend=gs.metal`）。GPU並列IK（1万体を2msで解く）のような大規模な話は出てくるが、本章の学習自体はMacで完結する。以降のコードは環境に合わせてバックエンドを読み替えてほしい。
:::

## 4.1　URDFとMJCFの読み込み

Genesisがサポートするロボット定義ファイルは主に次の通り。

| 形式 | 拡張子 | 特徴 | 推奨用途 |
|---|---|---|---|
| URDF | `.urdf` | ROSエコシステムの標準。ベースリンクは世界に固定されないため `fixed=True` が必要 | 汎用ロボット・自作ロボット |
| MJCF | `.xml` | MuJoCoの形式。ワールドとの接続情報を含み `fixed` 指定不要 | Franka等MuJoCo資産の多いロボット |
| USD | `.usd/.usda` | Pixar開発の汎用シーン記述。複雑なシーンごと読み込める | 大規模シーン・アセット管理 |

URDF読み込みの基本形は次の通り。**ロボットアームのようにベースを固定したい場合は `fixed=True` を必ず指定する。**

```python
import numpy as np
import genesis as gs

gs.init(backend=gs.metal)   # Macの場合。Colabなら gs.cuda

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=0.01),
    rigid_options=gs.options.RigidOptions(enable_joint_limit=False),
    viewer_options=gs.options.ViewerOptions(
        camera_pos=(3,-1,1.5), camera_lookat=(0,0,0.5), camera_fov=30, max_FPS=60,
    ),
    show_viewer=True, show_FPS=True,
)
plane = scene.add_entity(gs.morphs.Plane())
robot = scene.add_entity(gs.morphs.URDF(
    file='urdf/robot.urdf', pos=(0,0,0), euler=(0,0,0),
    fixed=True,               # ← ベースを世界に固定
    scale=1.0, merge_fixed_links=True,
))
scene.build()
for i in range(1000):
    scene.step()
```

:::message alert
⚠️ URDFではベースリンクがデフォルトで6自由度のフリージョイントで世界に接続される。固定したい場合は必ず `fixed=True` を指定すること。MJCFは内部に接続情報を持つため不要。
:::

ロボット読み込み後は、リンク・ジョイント・DoF構造を確認する習慣をつけよう。

```python
scene.build()
print("Links:",  [link.name for link in robot.links])
print("Joints:", [joint.name for joint in robot.joints])
print("DoFs:",   robot.n_dofs)              # Frankaなら 9（7関節 + グリッパー2）
print("DoF lower/upper:", robot.dofs_limit) # 各DoFの可動範囲
```

## 4.2　ジョイントとDoF（自由度）の概念

Genesisの制御APIを理解するには、「ジョイント（Joint）」と「DoF（Degree of Freedom：自由度）」の違いを押さえることが重要だ。

| 概念 | 説明 | 例 |
|---|---|---|
| Joint（関節） | 2つのリンクをつなぐ物理的な接続。URDFに名前で定義される | `joint1`, `finger_joint1` |
| DoF（自由度） | 独立して制御できる運動の次元。1ジョイントが複数DoFを持つこともある | 回転1軸=1DoF、ボールジョイント=3DoF |
| `dof_idx_local` | そのロボット内でのDoFインデックス（0始まり） | Franka: 0〜8 |

**制御APIはほぼすべて「DoFインデックス」を基準に動く。** まずジョイント名からDoFインデックスへのマッピングを作るのが最初のステップだ。

```python
jnt_names = ['joint1','joint2','joint3','joint4','joint5','joint6','joint7',
             'finger_joint1','finger_joint2']
dofs_idx = [robot.get_joint(name).dof_idx_local for name in jnt_names]  # → [0..8]

# アームとグリッパーを分けて管理するのが定石
motors_dof  = np.arange(7)     # アーム7DoF
fingers_dof = np.arange(7, 9)  # グリッパー2DoF
```

## 4.3　制御ゲインの設定

Genesisには内蔵のPDコントローラー（比例・微分制御）がある。ジョイントごとに制御ゲイン（`kp`＝位置ゲイン、`kv`＝速度ゲイン）と力の上下限を設定することで、ロボットの応答特性が決まる。

```python
# Frankaアームの推奨ゲイン例
robot.set_dofs_kp(np.array([4500,4500,3500,3500,2000,2000,2000, 100, 100]), dofs_idx)
robot.set_dofs_kv(np.array([ 450, 450, 350, 350, 200, 200, 200,  10,  10]), dofs_idx)
robot.set_dofs_force_range(          # 安全のための力の上下限（N または N·m）
    lower=np.array([-87,-87,-87,-87,-12,-12,-12,-100,-100]),
    upper=np.array([ 87, 87, 87, 87, 12, 12, 12, 100, 100]),
    dofs_idx_local=dofs_idx,
)
```

**💡 ゲインチューニングの勘所**：`kp`/`kv` はURDF/MJCFから自動パースされることもあるが、精度を出すには手動調整が要ることが多い。`kp` が大きすぎると振動し、小さすぎると追従が遅い。一般に **`kv ≈ kp/10`** を出発点にするとよい。

## 4.4　3種類の制御モード

| 制御モード | APIメソッド | 入力 | 用途 |
|---|---|---|---|
| 位置制御 | `control_dofs_position()` | 目標関節角度 [rad] | 最頻出。姿勢制御・把持 |
| 速度制御 | `control_dofs_velocity()` | 目標角速度 [rad/s] | 一定速度の回転・車輪駆動 |
| トルク制御 | `control_dofs_force()` | 印加トルク [N·m] | 最も低レベル。把持力の直接制御・触覚 |
| 位置の直接設定 | `set_dofs_position()` | 位置 [rad] | 物理を無視して即時配置。初期化・デバッグ |

4つのフェーズで各モードを使う例を示す。

```python
scene.build()
motors_dof, fingers_dof = np.arange(7), np.arange(7, 9)
# （ここで 4.3 の制御ゲイン設定を行う）

# フェーズ1: 初期姿勢を直接設定（物理計算なし）
init_qpos = np.array([0,-0.5,0,-1.5,0,1.2,0, 0.04,0.04])
franka.set_dofs_position(init_qpos)

# フェーズ2: 位置制御で目標姿勢へ
target_qpos = np.array([0.3,-0.3,0,-1.2,0,1.5,0.5, 0.04,0.04])
for i in range(200):
    franka.control_dofs_position(target_qpos)
    scene.step()

# フェーズ3: アームは位置制御、グリッパーはトルク制御で把持
for i in range(100):
    franka.control_dofs_position(target_qpos[:-2], motors_dof)
    franka.control_dofs_force(np.array([-0.5,-0.5]), fingers_dof)
    scene.step()

# フェーズ4: 速度制御（joint1を0.5rad/sで回転）
for i in range(100):
    franka.control_dofs_velocity(np.array([0.5]), np.array([0]))
    scene.step()

# 状態の取得
qpos   = franka.get_dofs_position()       # 現在の関節角度
qvel   = franka.get_dofs_velocity()       # 現在の角速度
ctrl_f = franka.get_dofs_control_force()  # コントローラーの指令力
total_f= franka.get_dofs_force()          # コリオリ・衝突を含む総合力
```

**📌 `get_dofs_force` と `get_dofs_control_force` の違い**：前者はコリオリ力・衝突力なども含む「実際の総合力」、後者は「コントローラーが計算した指令力」。衝突検出・力センシングには `get_dofs_force()` が有用だ。

## 4.5　逆運動学（IK）とモーションプランニング

「手先（エンドエフェクター）をXYZ座標のここに動かしたい」という直感的な指定を可能にするのが逆運動学（IK）だ。GenesisはIKソルバーを内蔵し、`inverse_kinematics()` 1行で関節角度に変換できる。

**GPU並列IKの威力**：1万体のFrankaアームのIKを同時に約2msで解ける。これが並列強化学習（第6章）でIKを使うことを現実的にしている。

把持〜持ち上げまでを、IK＋モーションプランニングで実装する例。

```python
end_effector = franka.get_link('hand')

# Step1: プリグラスプ位置へ（滑らかに移動）
qpos = franka.inverse_kinematics(
    link=end_effector,
    pos=np.array([0.65, 0.0, 0.25]),   # 目標XYZ
    quat=np.array([0, 1, 0, 0]),        # 目標姿勢（w-x-y-z、下向き）
)
qpos[-2:] = 0.04                        # グリッパーを開く
path = franka.plan_path(qpos_goal=qpos, num_waypoints=200)  # 200step=2秒
for waypoint in path:
    franka.control_dofs_position(waypoint)
    scene.step()
for _ in range(100):                    # 最終ウェイポイントに確実に到達
    scene.step()

# Step2: 把持位置へ降下
qpos = franka.inverse_kinematics(link=end_effector,
    pos=np.array([0.65,0.0,0.130]), quat=np.array([0,1,0,0]))
franka.control_dofs_position(qpos[:-2], motors_dof)
for _ in range(100): scene.step()

# Step3: グリッパーを閉じて把持（0.5Nで）
franka.control_dofs_force(np.array([-0.5,-0.5]), fingers_dof)
for _ in range(100): scene.step()

# Step4: 持ち上げ
qpos = franka.inverse_kinematics(link=end_effector,
    pos=np.array([0.65,0.0,0.28]), quat=np.array([0,1,0,0]))
franka.control_dofs_position(qpos[:-2], motors_dof)
for _ in range(200): scene.step()
```

**マルチリンクIK**では、グリッパーの左右指を別々のリンクとして扱い、複数目標点を同時に解ける。`rot_mask` で方向拘束を部分的に緩められる。

```python
qpos = franka.inverse_kinematics_multilink(
    links=[franka.get_link('left_finger'), franka.get_link('right_finger')],
    poss =[np.array([0.65, 0.02,0.15]), np.array([0.65,-0.02,0.15])],
    quats=[np.array([0,1,0,0]),         np.array([0,1,0,0])],
    rot_mask=[np.array([1,1,0]), np.array([1,1,0])],  # Z軸だけ拘束、XYは自由
)
```

:::message
🚀 モーションプランニング（`plan_path`）はOMPLライブラリを使うため `pip install ompl` が別途必要。IK単体は組み込みソルバーなのでそのまま使える。
:::

## 4.6　カメラセンサー — RGB・深度・セグメンテーション

Genesisのカメラは、ビューアーウィンドウとは独立して動く「ヘッドレスカメラ」だ。必要なときだけレンダリングし、RGB・深度マップ・セグメンテーションマスク・法線マップを取得できる。強化学習の視覚観測や合成データ生成に使う。**ヘッドレスで動くこの仕組みこそ、Colabで学習データを量産できる理由**でもある。

```python
scene = gs.Scene(
    show_viewer=True,
    renderer=gs.renderers.Rasterizer(),   # 高速。高品質なら RayTracer()
)
plane  = scene.add_entity(gs.morphs.Plane())
franka = scene.add_entity(gs.morphs.MJCF(file='xml/franka_emika_panda/panda.xml'))

cam = scene.add_camera(res=(640,480), pos=(3.5,0.0,2.5),
                       lookat=(0.0,0.0,0.5), fov=30, GUI=False)
scene.build()

# 静止画レンダリング（各種チャンネル）
rgb, depth, seg, normal = cam.render(rgb=True, depth=True, segmentation=True, normal=True)
print(f"RGB: {rgb.shape}, Depth: {depth.min():.2f}-{depth.max():.2f} m")

# 動画の録画（カメラを周回させる）
cam.start_recording()
for i in range(120):
    scene.step()
    cam.set_pose(pos=(3*np.sin(i/60*np.pi), 3*np.cos(i/60*np.pi), 2.5), lookat=(0,0,0.5))
    cam.render()
cam.stop_recording(save_to_filename='robot_demo.mp4', fps=60)
```

カメラをロボットのリンクに固定すれば、**搭載カメラ（一人称視点）**を実装できる。模倣学習の手首カメラ観測などに直結する。

```python
wrist_cam = scene.add_camera(res=(320,240), pos=(0,0,0), lookat=(1,0,0), fov=60)
scene.build()
wrist_cam.attach(link=franka.get_link('hand'), offset_T=np.eye(4))  # 手先に固定
for i in range(200):
    scene.step()
    ee_rgb = wrist_cam.render()   # 手先視点の画像がループ中も追従する
```

| レンダラー | 用途 | 速度 |
|---|---|---|
| Rasterizer | 強化学習・大量データ生成・リアルタイム表示 | 高速 |
| RayTracer（LuisaRender） | フォトリアルな合成データ・Sim2Real精度向上 | 低速 |
| BatchRenderer | 並列環境での一括レンダリング（RL用） | 並列最適化 |

## 4.7　IMUセンサー

IMU（慣性計測ユニット）は、リンクの線形加速度と角速度を測定する。脚型ロボットのバランス制御、ドローンの姿勢推定、アームの動的制御などに使う。Genesisは現実的なノイズパラメータ付きのIMUをシミュレートできる。

```python
imu = scene.add_sensor(gs.sensors.IMU(
    link=franka.get_link('hand'),
    noise_acc=0.01,    # 加速度計ノイズ標準偏差
    noise_gyro=0.001,  # ジャイロノイズ標準偏差
))
scene.build()

# （制御ゲイン設定のうえ）手先を円軌道で動かしながらIMUを読む
circle_center, circle_radius = np.array([0.4,0.0,0.5]), 0.15
end_effector, motors_dof = franka.get_link('hand'), np.arange(7)
for i in range(1000):
    rate = 2/180*np.pi
    pos = circle_center + np.array([np.cos(i*rate), np.sin(i*rate), 0]) * circle_radius
    qpos = franka.inverse_kinematics(link=end_effector, pos=pos, quat=np.array([0,1,0,0]))
    franka.control_dofs_position(qpos[:-2], motors_dof)
    scene.step()
    acc, gyro       = imu.read()               # ノイズあり計測値
    acc_gt, gyro_gt = imu.read_ground_truth()  # 真値
    if i % 100 == 0:
        print(f"Step {i}: acc={acc}, gyro={gyro}")
```

**🔮 今後のセンサー**：v0.3.x時点でIMUと触覚センサーが利用可能。LiDAR（距離センサー）や力覚センサーも近日公開予定とされている。

## 4.8　デバッグ可視化テクニック

開発中のデバッグに役立つ可視化機能をまとめる。座標フレーム表示とデバッグ形状の描画が特に有用だ。

```python
scene = gs.Scene(vis_options=gs.options.VisOptions(
    show_world_frame=True, world_frame_size=1.0,  # ワールド座標系
    show_link_frame=True,                          # 全リンクの座標系
    show_cameras=True,                             # カメラの位置・方向
    plane_reflection=True, ambient_light=(0.1,0.1,0.1),
))

# 目標位置を赤い球、方向を緑の矢印で可視化
scene.draw_debug_sphere(pos=(0.5,0.0,0.3), radius=0.02, color=(1,0,0,0.8))
scene.draw_debug_arrow(start=(0,0,0), end=(0.5,0,0.5), color=(0,1,0,1))

# 手先位置をリアルタイムに追跡表示
for i in range(100):
    scene.step()
    ee_pos = franka.get_link('hand').get_pos()
    scene.draw_debug_sphere(pos=ee_pos, radius=0.01, color=(1,0.5,0,0.5))
```

## 4.9　状態取得API クイックリファレンス

強化学習の観測空間（Observation Space）を設計する際に頻繁に使うAPIをまとめる。

| API | 戻り値 | 説明 |
|---|---|---|
| `robot.get_dofs_position()` | `[n_dofs]` | 全DoFの現在角度 [rad] |
| `robot.get_dofs_velocity()` | `[n_dofs]` | 全DoFの現在角速度 [rad/s] |
| `robot.get_dofs_force()` | `[n_dofs]` | 各DoFにかかる総合力 |
| `robot.get_dofs_control_force()` | `[n_dofs]` | コントローラーの制御力 |
| `link.get_pos()` / `link.get_quat()` | `[3]` / `[4]` | リンクのXYZ位置 / 姿勢クォータニオン |
| `link.get_vel()` / `link.get_ang()` | `[3]` / `[3]` | リンクの線速度 / 角速度 |
| `robot.get_pos()` / `entity.get_pos()` | `[3]` | ルートリンク / エンティティの位置 |

**🔢 並列環境での形状**：第6章で扱う並列環境（`n_envs > 1`）では、これらの戻り値が `[n_envs, n_dofs]` のような2次元テンソルになり、全環境を一度にバッチ処理できる。

## 4.10　まとめ

- URDFは `fixed=True` 必須、MJCFはそのまま読み込める。読み込み後はリンク・ジョイント構造を確認する習慣を。
- 制御はDoFインデックスへのマッピングから始まる。アームとグリッパーのDoFを分けて管理するのが定石。
- 3種類の制御モード（位置・速度・トルク）を用途で使い分ける。把持はトルク、姿勢保持は位置が基本。
- IKは `inverse_kinematics()` 1行。GPU並列IKで1万体を2msで処理でき、並列RLでの活用が現実的。
- カメラはヘッドレスでRGB/深度/セグメンテーションを取得でき、リンクへ取り付ければ搭載カメラになる。この仕組みがColabでのデータ量産を支える。
- 状態取得APIは観測空間設計に直結し、並列環境ではバッチテンソルで返る。

次章ではいよいよSO-101ロボットアームをGenesisに持ち込み、単体での動作確認からLeRobotフレームワークとの接続まで実践する。ここまではすべてMacで動かせる範囲だ。

*第5章へ続く →*


---
# 第5章　SO-101アームをGenesisで動かす
---

本章では、Hugging FaceとThe Robot Studioが共同開発したオープンソースロボットアーム「SO-101」をGenesisに組み込む。URDFの入手・構造確認から、単体動作確認、制御ゲイン調整、IKによるエンドエフェクター制御、把持シーケンス、そしてLeRobotフレームワークとのブリッジ（Gymnasium互換環境）まで一気通貫で解説する。本章を終えると、SO-101が「Genesisで思い通りに動く状態」になり、第6章の並列強化学習へそのまま接続できる。

:::message
💻 **実行環境の目安**：本章の内容——URDFロード・IK・把持シーケンス・カメラ観測・Gym環境の定義まで——は**すべてM4 Macで動く**（`backend=gs.metal`）。しかもSO-101の**実機制御（USB接続）はMacの得意分野**だ。実際に1024並列で回す学習は次章でColabに任せるが、環境づくりと動作確認はここまでMacで完結する。
:::

![画像](https://static.zenn.studio/user-upload/3ed22b893e65-20260312.gif)

## 5.1　SO-101とは

SO-101（Standard Open Arm 101）は、2025年4月にHugging Faceが発表したオープンソースロボットアームだ。前世代SO-100の後継で、AIビルダーがすぐ購入して使い始められる最初のロボットアームとして位置づけられている。

| 項目 | SO-101 |
|---|---|
| 開発 | The Robot Studio × Hugging Face |
| 自由度 | 6DoF（肩・上腕・前腕・手首×2 + グリッパー） |
| アクチュエーター | STS3215 Feetechサーボ |
| フレームワーク連携 | LeRobot（Hugging Face） |
| コスト | $130程度から（3Dプリント + サーボ） |
| URDF | TheRobotStudio/SO-ARM100 リポジトリに同梱 |
| 改善点（vs SO-100） | 配線改善・ギア比最適化・リーダー⇔フォロワー制御 |
| 用途 | 模倣学習・強化学習・物体操作研究 |

SO-101はリーダーアームとフォロワーアームの2本セットで構成される。人間がリーダーを操作するとフォロワーがミラーリングし、その軌跡をLeRobotで記録してAIに学習させる——これが基本ワークフローだ。本章では「フォロワーアーム（6DoF）」をGenesisでシミュレートする。

## 5.2　URDFの入手と構造確認

URDFはThe Robot StudioのGitHubから入手できる。

```bash
git clone https://github.com/TheRobotStudio/SO-ARM100.git
cd SO-ARM100
ls Simulation/                       # → so100.urdf so101.urdf meshes/ など
cp -r Simulation/ ~/genesis_ws/robots/so101/
```

**💡 代替入手先**：Hugging Faceの `haixuantao/dora-bambot` リポジトリにも `so101.urdf` がある。またLeRobotをインストールすると同梱URDFが使える。

主要リンクとジョイントの構成は次の通り。**ジョイント名はURDFのバージョンで異なることがあるので、次節のコードで `robot.joints` を出力して必ず確認する。**

| リンク名 | 部位 | ジョイント名 | タイプ |
|---|---|---|---|
| `base_link` | ベース（固定） | — | — |
| `shoulder_link` | 肩 | `Rotation_Shoulder` | revolute |
| `upper_arm_link` | 上腕 | `Rotation_Upper_Arm` | revolute |
| `forearm_link` | 前腕 | `Rotation_Forearm` | revolute |
| `wrist_link` | 手首（ピッチ） | `Rotation_Wrist_Pitch` | revolute |
| `hand_link` | 手首（ロール） | `Rotation_Wrist_Roll` | revolute |
| `gripper_base` | グリッパー | `Rotation_Gripper` | revolute |

## 5.3　GenesisへのSO-101ロード

```python
import numpy as np
import genesis as gs

gs.init(backend=gs.metal)   # Macの場合。Colabなら gs.cuda

scene = gs.Scene(
    sim_options=gs.options.SimOptions(dt=0.01, gravity=(0,0,-9.81)),
    viewer_options=gs.options.ViewerOptions(
        camera_pos=(0.5,-0.8,0.6), camera_lookat=(0.0,0.0,0.2), camera_fov=50),
    vis_options=gs.options.VisOptions(show_world_frame=True, world_frame_size=0.3),
    show_viewer=True,
)
plane = scene.add_entity(gs.morphs.Plane())
so101 = scene.add_entity(gs.morphs.URDF(
    file='robots/so101/so101.urdf', pos=(0,0,0), euler=(0,0,0), fixed=True))
scene.build()

# 構造の確認
print(f"DoF数: {so101.n_dofs}")
for link in so101.links:
    print("  link:", link.name)
for joint in so101.joints:
    print(f"  joint: {joint.name} (dof_idx_local={joint.dof_idx_local})")
```

構造確認で得たジョイント名から、DoFマッピングを作る。

```python
jnt_names = ['Rotation_Shoulder','Rotation_Upper_Arm','Rotation_Forearm',
             'Rotation_Wrist_Pitch','Rotation_Wrist_Roll','Rotation_Gripper']
dofs_idx = [so101.get_joint(name).dof_idx_local for name in jnt_names]  # → [0..5]

arm_dofs     = dofs_idx[:5]   # 肩〜手首の5DoF
gripper_dofs = dofs_idx[5:]   # グリッパー1DoF
```

## 5.4　SO-101用の制御ゲイン調整

SO-101のSTS3215サーボは産業用アームより低トルクだ。Frankaと同じゲインでは振動したり追従が遅れる。SO-101の物理特性に合わせて小さめに設定する。

```python
so101.set_dofs_kp(np.array([800,800,600,400,400,200]), dofs_idx)  # 位置ゲイン
so101.set_dofs_kv(np.array([ 80, 80, 60, 40, 40, 20]), dofs_idx)  # 速度ゲイン（kp/10目安）
so101.set_dofs_force_range(                       # STS3215: 最大約1.6 N·m
    lower=np.array([-15,-15,-15,-8,-8,-5]),
    upper=np.array([ 15, 15, 15, 8, 8, 5]),
    dofs_idx_local=dofs_idx,
)
```

**🔧 チューニングの指針**：`kp` を少しずつ上げ、振動が始まる手前の値に設定し、`kv` を増やして振動を抑えるのが定石。**実機転送時は必ず実機側でも再調整する。**

## 5.5　初期姿勢と関節可動域

全関節を中央付近に置いた安全な初期姿勢（ホームポジション）を定義する。LeRobotのキャリブレーション基準にも対応する。

```python
HOME_QPOS = np.array([
     0.0,   # 肩: 正面
    -1.0,   # 上腕: 後方へやや傾ける
     1.5,   # 前腕: 上へ
    -0.5,   # 手首ピッチ: やや下向き
     0.0,   # 手首ロール: 水平
     0.0,   # グリッパー: 全開
])
so101.set_dofs_position(HOME_QPOS, dofs_idx_local=dofs_idx)   # 物理なしで即時配置
print("現在角度:", np.round(so101.get_dofs_position(dofs_idx_local=dofs_idx), 3))
```

各関節の可動域はURDFから取得でき、任意の関節をスイープしてワークスペースを確認できる。

```python
for i, name in enumerate(jnt_names):
    lo = so101.dofs_limit[0][dofs_idx[i]]; hi = so101.dofs_limit[1][dofs_idx[i]]
    print(f"  {name}: [{np.degrees(lo):.1f}, {np.degrees(hi):.1f}] deg")

def sweep_joint(joint_idx, start, end, steps=100):
    qpos = HOME_QPOS.copy()
    for angle in np.linspace(start, end, steps):
        qpos[joint_idx] = angle
        so101.control_dofs_position(qpos, dofs_idx_local=dofs_idx)
        scene.step()

sweep_joint(0, -1.5, 1.5)   # 肩を左右にスイープ
sweep_joint(1, -2.0, 0.5)   # 上腕をスイープ
```

## 5.6　逆運動学によるエンドエフェクター制御

手先を目標XYZ座標へ動かすヘルパーを用意する。

```python
ee_link = so101.get_link('gripper_base')   # URDFで確認した先端リンク

def move_to_pose(target_pos, target_quat=np.array([1,0,0,0]), steps=200):
    qpos = so101.inverse_kinematics(link=ee_link, pos=target_pos, quat=target_quat)
    for _ in range(steps):
        so101.control_dofs_position(qpos, dofs_idx_local=dofs_idx)
        scene.step()
    return qpos

targets = [
    np.array([0.20, 0.00, 0.15]),   # 正面近距離
    np.array([0.28, 0.10, 0.05]),   # 右斜め前・低い
    np.array([0.28,-0.10, 0.05]),   # 左斜め前・低い
    np.array([0.15, 0.00, 0.25]),   # 正面・高い
]
for target in targets:
    move_to_pose(target)
```

:::message
📐 **SO-101のリーチ範囲**：全長約25cmのSO-101の作業空間は、概ね前方15〜30cm・高さ0〜25cmの半球状。目標がこの範囲外だとIKが解を見つけられず `nan` を返す。実機座標系はLeRobot連携で再調整する。
:::

:::message
📷 **画像プレースホルダー**：SO-101のリーチ範囲を示す図。アームを中心に、前方15〜30cm・高さ0〜25cmの半球状の作業空間を色付きで示し、代表的な目標点をプロットする。
:::

## 5.7　グリッパー制御と把持シーケンス

グリッパーは位置制御（開閉）と力制御（把持）を使い分ける。

```python
GRIPPER_OPEN, GRIPPER_CLOSE, GRIPPER_FORCE = 0.0, 0.8, 2.0   # rad, rad, N

def open_gripper(steps=50):
    for _ in range(steps):
        so101.control_dofs_position(np.array([GRIPPER_OPEN]), dofs_idx_local=gripper_dofs)
        scene.step()

def close_gripper_force(steps=50):
    for _ in range(steps):
        so101.control_dofs_force(np.array([-GRIPPER_FORCE]), dofs_idx_local=gripper_dofs)  # 負=閉じる
        scene.step()
```

キューブを1個置き、「プリグラスプ→降下→把持→持ち上げ→移動→リリース→ホーム」の一連の把持シーケンスを実装する。

```python
cube = scene.add_entity(
    gs.morphs.Box(pos=(0.25,0.0,0.02), size=(0.04,0.04,0.04)),
    surface=gs.surfaces.Default(color=(0.8,0.3,0.2,1.0)),
)
scene.build()   # （制御ゲイン・DoFマッピングは前掲）

so101.set_dofs_position(HOME_QPOS, dofs_idx_local=dofs_idx)   # 1. ホームへ
for _ in range(100): scene.step()
open_gripper()                                                # 2. 開く

cube_pos = cube.get_pos()
move_to_pose(cube_pos + np.array([0,0,0.10]))                 # 3. プリグラスプ（真上10cm）
move_to_pose(cube_pos + np.array([0,0,0.02]), steps=100)      # 4. 把持位置へ降下
close_gripper_force(50)                                       # 5. 閉じて把持
move_to_pose(cube_pos + np.array([0,0,0.14]), steps=150)      # 6. 持ち上げ
move_to_pose(np.array([0.20,0.15,0.10]), steps=150)           # 7. 横移動
move_to_pose(np.array([0.20,0.15,0.02]), steps=100)           # 8. 下ろす
open_gripper()                                                #    リリース
so101.set_dofs_position(HOME_QPOS, dofs_idx_local=dofs_idx)   # 9. ホームへ
for _ in range(100): scene.step()
print("把持シーケンス完了")
```

:::message
📷 **画像プレースホルダー**：把持シーケンスの7ステップを時系列コマ割りで示す図。プリグラスプ→降下→把持→持ち上げ→移動→リリースの各姿勢を、Genesisのビューアーのスクリーンショットで並べる。
:::

## 5.8　カメラ配置とビジョン観測

実機SO-101では、手首カメラ（Wrist）と俯瞰カメラ（Top-down）の2視点を使うことが多い。GenesisでもLeRobotと同じ構成を再現できる。

```python
cam_top = scene.add_camera(res=(640,480), pos=(0.0,0.0,0.6),
                           lookat=(0.25,0.0,0.0), fov=70, GUI=False)   # 俯瞰
cam_wrist = scene.add_camera(res=(320,240), pos=(0,0,0), lookat=(1,0,0), fov=60)  # 手首
scene.build()

T_offset = np.eye(4); T_offset[2,3] = 0.05      # グリッパー先端から5cm前方
cam_wrist.attach(link=so101.get_link('gripper_base'), offset_T=T_offset)

for i in range(500):
    scene.step()
    if i % 10 == 0:
        rgb_top = cam_top.render()
        rgb_wrist, depth_wrist = cam_wrist.render(depth=True)
        qpos = so101.get_dofs_position(dofs_idx_local=dofs_idx)
        obs = {
            'observation.image.top':   rgb_top,
            'observation.image.wrist': rgb_wrist,
            'observation.state':       qpos,
        }
```

## 5.9　LeRobotフレームワークとのブリッジ

LeRobotは観測・行動を決まったキー形式で扱う。Genesis環境をこの形式に準拠させると、実機で学習したポリシーをシミュレーターでそのまま実行できる。

| LeRobotキー | Genesisでの対応 | 型・形状 |
|---|---|---|
| `observation.state` | `so101.get_dofs_position()` | float32 [6] |
| `observation.image.top` | `cam_top.render()` | uint8 [H,W,3] |
| `observation.image.wrist` | `cam_wrist.render()` | uint8 [H,W,3] |
| `action` | `control_dofs_position()` への入力 | float32 [6] |

これをGymnasium互換の環境クラスにまとめる。第6章の並列強化学習はこの環境を土台にする。

```python
import gymnasium as gym
from gymnasium import spaces
import numpy as np
import genesis as gs

class SO101GenesisEnv(gym.Env):
    """SO-101のGenesis強化学習環境（Gymnasium互換 / LeRobot observation形式準拠）"""
    metadata = {'render_modes': ['rgb_array']}

    def __init__(self, render_mode=None):
        super().__init__()
        self.render_mode = render_mode
        gs.init(backend=gs.cuda)   # 学習はColab想定。Macで試すなら gs.metal
        self.scene = gs.Scene(
            sim_options=gs.options.SimOptions(dt=0.01),
            show_viewer=(render_mode == 'human'),
        )
        self.plane = self.scene.add_entity(gs.morphs.Plane())
        self.so101 = self.scene.add_entity(
            gs.morphs.URDF(file='robots/so101/so101.urdf', fixed=True))
        self.cube  = self.scene.add_entity(
            gs.morphs.Box(pos=(0.25,0.0,0.02), size=(0.04,0.04,0.04)))
        self.cam   = self.scene.add_camera(res=(64,64), pos=(0,0,0.6),
                                           lookat=(0.25,0,0), fov=70)
        self.scene.build()

        self.n_dofs   = 6
        self.dofs_idx = list(range(self.n_dofs))
        self.so101.set_dofs_kp(np.array([800,800,600,400,400,200]))
        self.so101.set_dofs_kv(np.array([ 80, 80, 60, 40, 40, 20]))

        self.action_space = spaces.Box(-np.pi, np.pi, (self.n_dofs,), np.float32)
        self.observation_space = spaces.Dict({
            'observation.state':     spaces.Box(-np.pi, np.pi, (self.n_dofs,), np.float32),
            'observation.image.top': spaces.Box(0, 255, (64,64,3), np.uint8),
        })
        self.max_steps, self.step_count = 200, 0

    def _get_obs(self):
        qpos = self.so101.get_dofs_position(dofs_idx_local=self.dofs_idx).astype(np.float32)
        img  = self.cam.render().astype(np.uint8)
        return {'observation.state': qpos, 'observation.image.top': img}

    def _get_reward(self):
        ee   = self.so101.get_link('gripper_base').get_pos()
        cube = self.cube.get_pos()
        return -np.linalg.norm(ee - cube)   # 手先とキューブの距離が近いほど高報酬

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        HOME = np.array([0.0,-1.0,1.5,-0.5,0.0,0.0])
        self.so101.set_dofs_position(HOME, dofs_idx_local=self.dofs_idx)
        rng = np.random.default_rng(seed)
        self.cube.set_pos(np.array([rng.uniform(0.18,0.30), rng.uniform(-0.10,0.10), 0.02]))
        for _ in range(20): self.scene.step()
        self.step_count = 0
        return self._get_obs(), {}

    def step(self, action):
        self.so101.control_dofs_position(action.astype(np.float64),
                                         dofs_idx_local=self.dofs_idx)
        self.scene.step()
        self.step_count += 1
        obs, reward = self._get_obs(), self._get_reward()
        terminated = reward > -0.02                 # キューブに到達
        truncated  = self.step_count >= self.max_steps
        return obs, reward, terminated, truncated, {}

    def render(self):
        if self.render_mode == 'rgb_array':
            return self.cam.render()
    def close(self): pass
```

## 5.10　よくある問題とデバッグチェックリスト

| 症状 | 原因 | 対処 |
|---|---|---|
| ロボットが重力で崩れる | `fixed=True` 未設定 | URDFに `fixed=True` を指定 |
| 関節が振動する | `kp` が大きすぎる | `kp` を半分にし、安定後に少しずつ戻す |
| IKが `nan` を返す | 目標がリーチ範囲外 | 前方15〜30cm内に収める |
| ジョイント名エラー | URDFバージョン不一致 | `robot.joints` を出力して実名を確認 |
| グリッパーが閉じない | 力の方向が逆／ゲイン不足 | force符号を反転、または `kp` 増加 |
| カメラ画像が黒い | `build()` 前に `render()` | 必ず `build()` 後に `render()` |
| メモリ不足 | GPU/VRAM不足 | 解像度を下げる／`gs.cpu`・`gs.metal` に切替 |

## 5.11　まとめ

- SO-101は6DoF（アーム5 + グリッパー1）のオープンソースアーム。URDFは TheRobotStudio/SO-ARM100 から入手できる。
- 読み込み時は `fixed=True` 必須。ロード後に `robot.joints` を確認してDoFマッピングを確立する。
- 制御ゲインはFrankaより低い値に。STS3215サーボのトルク特性に合わせて調整し、実機では再調整する。
- 把持シーケンスは「プリグラスプ→降下→把持→持ち上げ→移動→リリース」が基本形。
- `SO101GenesisEnv` はGymnasium互換で、LeRobotのobservation形式に準拠させることで実機ポリシーとの互換性を確保できる。
- **ここまでのすべてをMacで動かせる。** 実機のUSB制御もMacの得意分野だ。

次章では、このSO-101環境を1024並列で同時実行し、強化学習でキューブ把持を学習させる。並列数が効いてくるので、いよいよColabのGPUが主役になる。

*第6章へ続く →*


---
# 第6章　SO-101の並列強化学習 — 1024環境でキューブ把持を学ぶ
---

本章は本書のクライマックスの第一部だ。第5章で作ったSO-101環境を大量並列で同時稼働させ、PPO（Proximal Policy Optimization）でキューブ把持タスクを自動学習する。並列化の仕組みから報酬設計・学習ループ・TensorBoard監視・ドメインランダマイゼーションまで、実用的なRLパイプラインを組み上げる。

:::message
☁️ **この章はColab（GPU）が主役**：1024並列の強化学習は、本書のなかで最もGPUの恩恵が大きい部分だ。**M4 Macでも `n_envs` を64〜128程度に絞れば「学習が回っていく流れ」を体験できる**が、数十分で収束させたいなら **Colab（T4/A100）を推奨**する。コードは共通で、変えるのは `gs.init()` のバックエンドと `n_envs` だけだ。第5章までの「Mac完結」から、ここで初めてクラウドGPUに手を伸ばす。
:::

## 6.1　Genesisの並列シミュレーション — `n_envs` の魔法

並列化に必要な変更は**たった1行**。`scene.build()` に `n_envs` を渡すだけで、独立した物理シミュレーションが1つのGPU上で同時に走り出す。

```python
scene.build()                                     # 単体（1環境）
scene.build(n_envs=1024)                          # 1024の独立環境
scene.build(n_envs=1024, env_spacing=(1.0, 1.0))  # ビューアーで間隔を空けて表示
```

並列化後は、状態取得・制御APIがすべてバッチテンソルを返す。

```python
qpos = robot.get_dofs_position()           # n_envs=1 → [6],  n_envs=1024 → [1024, 6]
robot.control_dofs_position(target_qpos)   # 入力も [1024, 6] のバッチ
```

Genesisはバッチ行列演算で `n_envs` 個を同時処理するため、**生成できるサンプル総量（サンプル/秒）は `n_envs` にほぼ比例して増える**。これが「学習が数日から数十分に縮む」からくりだ。目安は次の通り（GPU環境で顕著に効く）。

| n_envs | 相対スループット | 主な用途 |
|---|---|---|
| 1 | 基準 | デバッグ・動作確認（Macでも可） |
| 64〜128 | 数十倍 | Macで流れを体験／小規模実験 |
| 512 | 数百倍 | 標準的な操作タスク（Colab） |
| 1024 | 約1000倍 | 本格ポリシー学習・本章の主対象（Colab） |
| 4096 | 数千倍 | 高難易度・大規模探索（大きめVRAM） |

## 6.2　SO-101並列環境クラスの設計

ロボティクスで広く使われるPPO実装 **rsl_rl** との統合を前提に、並列環境クラスを設計する。全体は次のファイル構成にする。

```
so101_grasp_rl/
├── envs/so101_grasp_env.py   # 並列環境クラス（本節）
├── train.py                   # 学習エントリポイント（6.4）
├── eval.py                    # 評価・可視化（6.7）
└── logs/                      # TensorBoardログ・チェックポイント
```

環境クラスの核心は、シーン構築・バッファ初期化・`reset`・`step`・観測計算・報酬計算・終了判定だ。まず初期化とシーン構築から。

```python
# envs/so101_grasp_env.py
import torch, numpy as np
import genesis as gs

class SO101GraspEnv:
    """SO-101キューブ把持タスク — 並列強化学習環境（rsl_rl連携）"""

    def __init__(self, num_envs, env_cfg, reward_cfg, show_viewer=False, device='cuda'):
        self.num_envs, self.device = num_envs, device
        self.env_cfg, self.reward_cfg = env_cfg, reward_cfg
        self.max_episode_length = env_cfg.get('max_episode_length', 200)
        self.action_scale       = env_cfg.get('action_scale', 0.5)
        self.n_dofs = 6
        # obs = qpos(6)+qvel(6)+ee_pos(3)+cube_pos(3)+cube_rel(3) = 21
        self.num_obs, self.num_actions = 21, self.n_dofs
        self._build_scene(show_viewer)
        self._init_buffers()

    def _build_scene(self, show_viewer):
        gs.init(backend=gs.cuda, precision='32', logging_level='warning')  # Macなら gs.metal
        self.scene = gs.Scene(
            sim_options=gs.options.SimOptions(dt=0.01, substeps=2, gravity=(0,0,-9.81)),
            show_viewer=show_viewer,
        )
        self.plane = self.scene.add_entity(gs.morphs.Plane())
        self.robot = self.scene.add_entity(
            gs.morphs.URDF(file='robots/so101/so101.urdf', pos=(0,0,0), fixed=True))
        self.cube  = self.scene.add_entity(
            gs.morphs.Box(pos=(0.25,0.0,0.02), size=(0.04,0.04,0.04)),
            surface=gs.surfaces.Default(color=(0.8,0.3,0.2,1.0)))

        self.scene.build(n_envs=self.num_envs)   # ← 1行で並列化

        jnt_names = ['Rotation_Shoulder','Rotation_Upper_Arm','Rotation_Forearm',
                     'Rotation_Wrist_Pitch','Rotation_Wrist_Roll','Rotation_Gripper']
        self.dofs_idx = [self.robot.get_joint(n).dof_idx_local for n in jnt_names]
        self.robot.set_dofs_kp(np.array([800,800,600,400,400,200]))
        self.robot.set_dofs_kv(np.array([ 80, 80, 60, 40, 40, 20]))
        self.robot.set_dofs_force_range(np.array([-15,-15,-15,-8,-8,-5]),
                                        np.array([ 15, 15, 15, 8, 8, 5]))
        self.ee_link = self.robot.get_link('gripper_base')

    def _init_buffers(self):
        n, d = self.num_envs, self.device
        self.home_qpos = torch.tensor([0.0,-1.0,1.5,-0.5,0.0,0.0],
                                      device=d).unsqueeze(0).expand(n, -1)  # [n,6]
        self.episode_length_buf = torch.zeros(n, dtype=torch.int32, device=d)
        self.last_actions = torch.zeros((n, self.num_actions), device=d)
        self.obs_buf = torch.zeros((n, self.num_obs), device=d)
```

`reset` / `step` は、**終了した環境だけを選んでリセットする**のがポイントだ（全環境を止めない）。

```python
    def reset(self):
        self._reset_envs(torch.arange(self.num_envs, device=self.device))
        return self._compute_obs()

    def _reset_envs(self, env_ids):
        if len(env_ids) == 0: return
        n = len(env_ids)
        self.robot.set_dofs_position(self.home_qpos[env_ids],
                                     dofs_idx_local=self.dofs_idx, envs_idx=env_ids)
        # キューブをランダム位置に（ドメインランダマイゼーションの一部）
        cube_x = torch.rand(n, device=self.device) * 0.12 + 0.18   # 0.18〜0.30
        cube_y = torch.rand(n, device=self.device) * 0.20 - 0.10   # -0.10〜0.10
        cube_z = torch.full((n,), 0.02, device=self.device)
        self.cube.set_pos(torch.stack([cube_x, cube_y, cube_z], dim=1), envs_idx=env_ids)
        self.episode_length_buf[env_ids] = 0
        self.last_actions[env_ids] = 0.0
        for _ in range(5): self.scene.step()   # 数ステップ安定化

    def step(self, actions):
        actions = torch.clamp(actions, -1.0, 1.0)
        current = self.robot.get_dofs_position(dofs_idx_local=self.dofs_idx)  # [n,6]
        target  = current + actions * self.action_scale                      # デルタ制御
        target  = torch.clamp(target,
            torch.tensor(self.env_cfg['dof_lower'], device=self.device),
            torch.tensor(self.env_cfg['dof_upper'], device=self.device))
        self.robot.control_dofs_position(target, dofs_idx_local=self.dofs_idx)
        self.scene.step()
        self.episode_length_buf += 1

        rewards = self._compute_rewards(actions)
        dones   = self._compute_dones()
        self._reset_envs(dones.nonzero(as_tuple=False).squeeze(-1))  # 終了環境を自動リセット
        self.last_actions = actions.clone()
        obs = self._compute_obs()
        infos = {'episode_length': self.episode_length_buf.float().mean().item()}
        return obs, rewards, dones, infos
```

観測・報酬・終了判定はすべてバッチ（`[n_envs, ...]`）で計算する。

```python
    def _compute_obs(self):
        qpos = self.robot.get_dofs_position(dofs_idx_local=self.dofs_idx)  # [n,6]
        qvel = self.robot.get_dofs_velocity(dofs_idx_local=self.dofs_idx)  # [n,6]
        ee   = self.ee_link.get_pos()     # [n,3]
        cube = self.cube.get_pos()        # [n,3]
        self.obs_buf = torch.cat([qpos, qvel, ee, cube, cube - ee], dim=-1)  # [n,21]
        return self.obs_buf

    def _compute_rewards(self, actions):
        ee, cube = self.ee_link.get_pos(), self.cube.get_pos()
        rewards = torch.zeros(self.num_envs, device=self.device)
        # ① 到達: 距離を最小化（指数で近いほど高報酬）
        dist = torch.norm(ee - cube, dim=-1)
        rewards += self.reward_cfg['w_reach'] * torch.exp(-dist * 10.0)
        # ② 持ち上げ: キューブZ>0.05 で加点（疎な報酬）
        rewards += self.reward_cfg['w_lift'] * (cube[:, 2] > 0.05).float()
        # ③ スムーズネス: 急な動作変化を抑制
        rewards += self.reward_cfg['w_smooth'] * (-torch.norm(actions - self.last_actions, dim=-1))
        # ④ 関節制限ペナルティ: 可動域端に近い関節を罰する
        qpos  = self.robot.get_dofs_position(dofs_idx_local=self.dofs_idx)
        lower = torch.tensor(self.env_cfg['dof_lower'], device=self.device)
        upper = torch.tensor(self.env_cfg['dof_upper'], device=self.device)
        at_limit = ((qpos < lower + 0.1) | (qpos > upper - 0.1)).float()
        rewards += self.reward_cfg['w_limit'] * (-at_limit.sum(dim=-1))
        return rewards

    def _compute_dones(self):
        timeout = self.episode_length_buf >= self.max_episode_length
        success = self.cube.get_pos()[:, 2] > 0.08   # 十分な高さまで持ち上げた
        return timeout | success
```

## 6.3　報酬設計の詳細と調整指針

報酬設計は強化学習で最も重要かつ難しい。適切でないとエージェントは意図しない「近道」を見つける（報酬ハッキング）。本タスクの4項をまとめる。

| 報酬項 | 数式 | 役割 | 推奨重み |
|---|---|---|---|
| `r_reach`（到達） | `exp(-dist×10)` | 手先をキューブへ誘導。近いほど高報酬 | 1.0 |
| `r_lift`（持ち上げ） | `cube_z > 0.05 ? 1 : 0` | 持ち上げを促す疎な報酬 | 2.0 |
| `r_smooth`（スムーズ） | `-‖aₜ - aₜ₋₁‖` | 急な動作変化を抑え実機での安定に寄与 | 0.01 |
| `r_limit`（制限） | `-(可動域端の関節数)` | 関節が端に当たるのを防ぐ | 0.1 |

段階的に報酬を足すと安定して学習できる。**Phase1**（〜100k step）は `w_reach` だけで到達を学び、**Phase2**（〜300k）で `w_lift` を足して把持を学び、**Phase3** で `w_smooth` を足して実機転送に備える。

:::message alert
⚠️ **報酬ハッキングに注意**：`r_lift` の疎な報酬だけだと、手先がキューブを弾き飛ばして高さを達成する挙動が出ることがある。`r_reach` と組み合わせて「近づいてから持ち上げる」動作へ誘導すること。
:::

## 6.4　PPO学習スクリプト（rsl_rl 統合）

```bash
pip install rsl-rl-lib==2.2.4 tensorboard
```

設定を辞書で渡し、`OnPolicyRunner` に環境を接続する。**Macで試すときは `NUM_ENVS` を小さくする**。

```python
# train.py
import os, torch
from rsl_rl.runners import OnPolicyRunner
from envs.so101_grasp_env import SO101GraspEnv

env_cfg = {
    'max_episode_length': 200,
    'action_scale': 0.3,   # デルタ制御スケール [rad]
    'dof_lower': [-2.0,-2.5,-0.5,-1.5,-1.5,-0.5],
    'dof_upper': [ 2.0, 0.5, 2.5, 1.5, 1.5, 1.5],
}
reward_cfg = {'w_reach': 1.0, 'w_lift': 2.0, 'w_smooth': 0.01, 'w_limit': 0.1}

train_cfg = {
    'seed': 42,
    'algorithm': {'class_name':'PPO', 'learning_rate':3e-4,
        'num_learning_epochs':5, 'num_mini_batches':4, 'gamma':0.99, 'lam':0.95,
        'clip_param':0.2, 'entropy_coef':0.01, 'value_loss_coef':1.0, 'max_grad_norm':1.0},
    'policy': {'class_name':'ActorCritic',
        'actor_hidden_dims':[256,128,64], 'critic_hidden_dims':[256,128,64],
        'activation':'elu', 'init_noise_std':1.0},
    'runner': {'num_steps_per_env':24, 'max_iterations':500, 'save_interval':50,
        'experiment_name':'so101_grasp', 'run_name':'v1', 'log_dir':'logs'},
}

def train():
    NUM_ENVS = 1024                    # Macで試すなら 64〜128 に
    env = SO101GraspEnv(NUM_ENVS, env_cfg, reward_cfg, show_viewer=False, device='cuda')
    log_dir = os.path.join('logs', 'so101_grasp', 'v1')
    os.makedirs(log_dir, exist_ok=True)
    runner = OnPolicyRunner(env, train_cfg, log_dir, device='cuda')
    runner.learn(num_learning_iterations=train_cfg['runner']['max_iterations'])
    torch.save(runner.get_inference_policy(), os.path.join(log_dir, 'final_policy.pt'))
    print("学習完了")

if __name__ == '__main__':
    train()
```

## 6.5　TensorBoard による学習監視

rsl_rlは自動でメトリクスを記録する。別ターミナル（Colabなら別セル）で `tensorboard --logdir logs/` を起動し、推移を確認する。

| メトリクス | 正常な推移 | 異常のサイン |
|---|---|---|
| `mean_reward` | 単調増加または収束 | 全く増えない／急落 |
| `mean_episode_length` | 序盤短く、学習が進むと伸びる | 常に最大（タイムアウトし続け） |
| `value_function_loss` | 初期に大きく徐々に減少 | 増え続ける（学習率が高すぎ） |
| `surrogate_loss` | 小さな正の値で推移 | 大きく振動（clip_paramが小さすぎ） |
| `mean_noise_std` | 徐々に減少（探索→活用） | 0に近づかない（収束しない） |

**📊 収束の目安**：`n_envs=1024` なら、GPU環境で概ね100〜200イテレーション（10〜20分）で `mean_reward` が安定し、500イテレーション（30〜40分）で実用的なポリシーに収束する。Macで `n_envs` を絞った場合は「増えていく傾向」を確認する用途と割り切る。

## 6.6　ドメインランダマイゼーション（Sim2Real強化）

シミュレーションで学んだポリシーを実機へ移すときの最大の障壁が「リアリティギャップ」だ。ドメインランダマイゼーション（DR）は、リセット時に環境をわざとばらつかせてこのギャップを埋める。`_reset_envs` を拡張する。

```python
    def _reset_envs(self, env_ids):
        if len(env_ids) == 0: return
        n = len(env_ids)
        # キューブ位置
        cube = torch.stack([
            torch.rand(n, device=self.device) * 0.12 + 0.18,
            torch.rand(n, device=self.device) * 0.20 - 0.10,
            torch.full((n,), 0.02, device=self.device)], dim=1)
        self.cube.set_pos(cube, envs_idx=env_ids)
        # キューブ姿勢（Z軸回転 ±180°）
        yaw = torch.rand(n, device=self.device) * 2*3.14159 - 3.14159
        h = yaw / 2
        z = torch.zeros(n, device=self.device)
        self.cube.set_quat(torch.stack([torch.cos(h), z, z, torch.sin(h)], dim=1),
                           envs_idx=env_ids)
        # 制御ゲインを±10%ばらつかせる（実機サーボ差を模倣）
        kp_scale = 1.0 + (torch.rand(1).item() - 0.5) * 0.2
        self.robot.set_dofs_kp((np.array([800,800,600,400,400,200]) * kp_scale).clip(100, 2000))
        # 初期関節角度にノイズ
        home = self.home_qpos[env_ids] + torch.randn_like(self.home_qpos[env_ids]) * 0.05
        self.robot.set_dofs_position(home, dofs_idx_local=self.dofs_idx, envs_idx=env_ids)
        self.episode_length_buf[env_ids] = 0
        self.last_actions[env_ids] = 0.0
        for _ in range(5): self.scene.step()
```

| ランダム化項目 | 効果 | 推奨範囲 |
|---|---|---|
| キューブ位置（XY） | 多様なリーチを学習 | ±10cm |
| キューブ姿勢（Z回転） | 任意方向から把持 | ±180° |
| 制御ゲイン kp/kv | 実機サーボのばらつき対応 | ±10〜20% |
| 初期関節角度 | ホーム位置ずれ対応 | ±0.05 rad |
| 重力方向 | 傾いた台への対応 | ±0.1 rad |

## 6.7　評価・可視化スクリプト

学習済みポリシーを少数環境（可視化ON）で走らせ、成功率を測る。**評価はビューアーで見られるのでMacでも快適だ。**

```python
# eval.py
import torch
from envs.so101_grasp_env import SO101GraspEnv

def evaluate(checkpoint_path, num_envs=4):
    env = SO101GraspEnv(num_envs, env_cfg, reward_cfg, show_viewer=True, device='cuda')
    policy = torch.load(checkpoint_path, map_location='cuda'); policy.eval()
    obs = env.reset()
    total_rewards, success, episodes = [], 0, 0
    for step in range(2000):
        with torch.no_grad():
            actions = policy(obs)
        obs, rewards, dones, infos = env.step(actions)
        total_rewards.append(rewards.mean().item())
        success  += (env.cube.get_pos()[:, 2] > 0.08).sum().item()
        episodes += dones.sum().item()
        if step % 100 == 0:
            rate = success / max(episodes, 1) * 100
            print(f"Step {step:4d}: avg_reward={sum(total_rewards[-100:])/100:.3f}, "
                  f"success_rate={rate:.1f}%")
    print(f"平均報酬 {sum(total_rewards)/len(total_rewards):.3f}, "
          f"成功率 {success/max(episodes,1)*100:.1f}%")

if __name__ == '__main__':
    evaluate('logs/so101_grasp/v1/final_policy.pt', num_envs=4)
```

## 6.8　ハイパーパラメータ調整ガイド

| 症状 | 原因 | 対処 |
|---|---|---|
| 報酬が全く増えない | 報酬スケール小／観測不足 | `w_reach` を10倍／`cube_rel` 観測を確認 |
| 増えてすぐ下がる | 学習率が高い／clipが大きい | `lr` を1e-4へ／`clip_param` を0.1へ |
| 学習が振動する | ミニバッチが多すぎ | `num_mini_batches` を2へ |
| 探索が乏しい | エントロピー係数が小さい | `entropy_coef` を0.05〜0.1へ |
| OOM（メモリ不足） | `n_envs×steps` が大きい | `n_envs` を512へ／`num_steps_per_env` を16へ |
| 実機で発散 | `action_scale` が大きい／DR不足 | `action_scale` を0.1へ／DR範囲を拡大 |

調整の順序は、①`action_scale`（0.1〜0.5）→ ②`w_reach:w_lift` の比（1:1→1:2→1:5）→ ③安定しなければ `learning_rate` を1/10 → ④実機転送前に `action_scale` を安全値まで下げる、が効率的だ。

## 6.9　メモリ最適化とスケーリング

```python
import torch
print(f"GPU使用 {torch.cuda.memory_allocated()/1e9:.2f} GB / "
      f"予約 {torch.cuda.memory_reserved()/1e9:.2f} GB")
```

`n_envs` ごとのVRAM目安（SO-101＋キューブ、24GBクラス）：256→約1GB、1024→約3GB、4096→約10GB、8192→約20GB。節約のコツは、①`show_viewer=False`、②`precision='32'`、③`merge_fixed_links=True`、④カメラ解像度を下げる（64×64）。**ColabのT4（16GB）なら1024〜2048並列が現実的**だ。

## 6.10　まとめ

- `scene.build(n_envs=1024)` の1行でSO-101を並列展開でき、全APIが自動でバッチテンソルを返す。
- `SO101GraspEnv` は `reset` / `step` / `_compute_obs` / `_compute_rewards` / `_compute_dones` が核心で、rsl_rlの `OnPolicyRunner` にそのまま渡せる。
- 報酬は到達（dense）＋持ち上げ（sparse）＋スムーズネス＋制限ペナルティの4項。段階的に足すのが安定への近道。
- ドメインランダマイゼーションは実機転送成功率を大きく左右する。最初から組み込む。
- 収束しないときはまず `action_scale` を疑う。
- **本格学習はColab推奨。Macは `n_envs` を絞れば流れを体験でき、評価（可視化）はMacで快適に行える。**

強化学習は「報酬を設計して試行錯誤で学ばせる」アプローチだった。次章では、もう一つの主要な学習手法——人間のデモをまねる **模倣学習**（ACT・Diffusion Policy）——を扱う。学習手法をひと通り押さえたうえで、第8章で実機への転送（Sim2Real）に進む。

*第7章へ続く →*


---
# 第7章　模倣学習 — ACT・Diffusion PolicyでSO-101を教える
---

前章の強化学習は「報酬を設計して試行錯誤で動作を発見させる」手法だった。本章で扱う**模倣学習（Imitation Learning / IL）**は逆に、人間が実際に動かしたデモから直接動作を学ぶ。報酬設計が要らず、直感的でデータ効率が高い。LeRobotが提供する2大アルゴリズム——ACT（Action Chunking with Transformers）とDiffusion Policy——をSO-101で実践する。50本のデモで70%以上の把持成功率を達成した実績のある手法だ。

:::message
💻 **役割分担**：デモ収集（`lerobot-record`）と実機推論は**Macが得意（USB接続）**。ポリシーの学習（ACT/DP）はGPUが要るので **Colab推奨**。Genesis上でのシミュレーションデモ生成（7.5節）は単体環境なので**Macでも回せる**。「Macで集めて、Colabで学習し、Macで動かす」が本章の基本動線だ。
:::

## 7.1　模倣学習と強化学習の使い分け

| 比較軸 | 模倣学習（ACT/DP） | 強化学習（PPO） |
|---|---|---|
| 学習データ | 人間のデモ50〜200本 | 自動生成サンプル数億〜 |
| 環境設計 | 報酬設計不要 | 報酬関数の設計が必須 |
| 学習時間 | 数時間（単一GPU） | 数十分〜数時間（並列GPU） |
| ハードウェア | 実機デモで十分 | 強力なGPUが必要 |
| 汎化性能 | デモ分布外に弱い | ランダム化で汎化可能 |
| 適用場面 | 精密操作・複雑な手順 | 物理的に定義しやすいタスク |

**💡 組み合わせが最強**：現在のトレンドは「RLで探索・ILで精密化」の組み合わせだ。Genesisで並列RL（第6章）を行い、実機でデモを追加収集してILでファインチューニングするのが、実用的なSim2Realの王道になっている。

## 7.2　デモデータ収集のベストプラクティス

模倣学習の品質はデモデータの質で9割決まる。悪いデモからは悪いポリシーしか学べない。

**環境セットアップ**：①カメラを三脚・専用マウントで固定する（デモ中にずれると推論時に誤動作）。②作業台の高さ・色・反射率を学習時と推論時で統一する。③背景を単純化し無関係な物体を映さない（不要な特徴への依存＝spurious correlationを防ぐ）。④照明をLEDで安定させる。⑤把持対象の初期位置を±5cm程度ランダムに変えて汎化性能を上げる。

**良いデモの録り方**：動作はゆっくり滑らかに。失敗エピソードは混ぜない。把持戦略（左から／上から）を統一する。本数は最低50本（基本動作）、100本で安定、200本以上で高汎化が目安。

デモ収集はLeRobotの `lerobot-record` で行う。リーダーアームで操作し、フォロワーの軌跡とカメラ映像を記録する。

```bash
export HF_USER=your_huggingface_username
lerobot-record \
  --robot.type=so101_follower --robot.port=/dev/ttyACM0 --robot.id=my_follower_arm \
  --robot.cameras="{ top:   {type: opencv, index_or_path: 0, width: 640, height: 480, fps: 30},
                     wrist: {type: opencv, index_or_path: 2, width: 320, height: 240, fps: 30} }" \
  --teleop.type=so101_leader --teleop.port=/dev/ttyACM1 --teleop.id=my_leader_arm \
  --display_data=true \
  --dataset.repo_id=${HF_USER}/so101_grasp_cube \
  --dataset.num_episodes=50 \
  --dataset.single_task="Pick up the red cube and place it in the box"
```

収集後は品質を確認する。Hugging Faceの `lerobot/visualize_dataset` Space、またはローカルで検証できる。

```python
from lerobot.datasets import LeRobotDataset
dataset = LeRobotDataset(repo_id=f'{HF_USER}/so101_grasp_cube')
print(f'エピソード数 {dataset.num_episodes}, 総フレーム {dataset.num_frames}, FPS {dataset.fps}')
sample = dataset[0]
print("state:", sample['observation.state'].shape, "action:", sample['action'].shape)
```

## 7.3　ACT — Action Chunking with Transformers

ACT（2023年、Tony Zhaoら）の最大の特徴は「Action Chunking」——単一行動ではなく、複数ステップ分の行動シーケンス（チャンク）を一度に予測することで、複合的な動作を安定して学べる。

| コンポーネント | 役割 |
|---|---|
| VAEエンコーダー | 行動チャンクをガウス潜在変数Zに圧縮しデモの多様性をモデル化 |
| Transformerエンコーダー | カメラ画像＋関節角をToken化して処理 |
| Transformerデコーダー | Zと観測から `chunk_size` 分の行動を一度に予測 |
| Action Chunking | 100step分を予測し平滑化して出力、時間的一貫性を確保 |

学習はLeRobotの `lerobot-train` で行う（**GPU環境＝Colab推奨**）。

```bash
lerobot-train \
  --dataset.repo_id=${HF_USER}/so101_grasp_cube \
  --policy.type=act \
  --policy.chunk_size=100 \      # 一度に予測する行動ステップ数
  --policy.dim_model=512 \       # Transformer次元（少データなら256でも可）
  --training.num_steps=100000 \  # 50本なら50k、200本なら200kが目安
  --training.batch_size=8 \      # VRAM 16GBで8、24GBで16
  --training.lr=1e-4 \
  --output_dir=outputs/train/act_so101_grasp --policy.device=cuda --wandb.enable=true
```

主なハイパーパラメータの調整指針：`chunk_size`（精密動作は50、長い手順は200）、`kl_weight`（大きいほど一貫したデモを学習、デフォルト10）、`lr`（損失が発散するなら1/10）。

**📊 SO-101での実績**：50エピソード・100,000ステップ（単一GPUで数時間）で成功率70%、200エピソードで85%以上に達した事例がある。

## 7.4　Diffusion Policy

Diffusion Policyは拡散モデルの考え方をロボット制御に応用し、ノイズだらけの行動から少しずつノイズを除去して最終行動を生成する。ACTより計算コストは高いが、**マルチモーダルな行動分布**（同じ状態から複数の成功パターンがある場合）を自然にモデル化できる。

| 比較 | ACT | Diffusion Policy |
|---|---|---|
| アーキテクチャ | VAE + Transformer | U-Net/Transformer + DDPM/DDIM |
| 推論速度 | 速い（1回のforward） | 遅い（複数denoising step） |
| マルチモーダル | 限定的 | 優秀 |
| 必要デモ数 / VRAM | 50本〜 / 16GB | 100本〜 / 24GB推奨 |

```bash
lerobot-train \
  --dataset.repo_id=${HF_USER}/so101_grasp_cube \
  --policy.type=diffusion \
  --training.num_steps=200000 \   # DPはACTより多くのステップが必要
  --training.batch_size=64 \      # DPは大きいバッチが効果的
  --output_dir=outputs/train/dp_so101_grasp --policy.device=cuda --wandb.enable=true
# 推論時は --policy.num_inference_steps=10 でdenoising stepを減らし約10倍高速化
```

## 7.5　GenesisでILデータを生成する（シミュレーションデモ）

実機デモ収集は手間がかかる。GenesisのIKベースのスクリプトポリシーや第6章のRLポリシーで、大量のシミュレーションデモを自動生成し学習データにする手法が注目されている。**単体環境なのでMacでも生成できる。**

```python
import numpy as np
import genesis as gs

gs.init(backend=gs.metal)   # Mac。Colabなら gs.cuda
scene = gs.Scene(sim_options=gs.options.SimOptions(dt=0.01))
plane = scene.add_entity(gs.morphs.Plane())
robot = scene.add_entity(gs.morphs.URDF(file='robots/so101/so101.urdf', fixed=True))
cube  = scene.add_entity(gs.morphs.Box(pos=(0.25,0,0.02), size=(0.04,0.04,0.04)))
cam   = scene.add_camera(res=(640,480), pos=(0,0,0.6), lookat=(0.25,0,0), fov=70)
scene.build(n_envs=1)      # デモ生成は単体環境でOK

dofs_idx, ee_link = [0,1,2,3,4,5], robot.get_link('gripper_base')
episodes, NUM_DEMOS = [], 200
for ep in range(NUM_DEMOS):
    cube.set_pos(np.array([np.random.uniform(0.18,0.30), np.random.uniform(-0.10,0.10), 0.02]))
    robot.set_dofs_position(np.array([0.0,-1.0,1.5,-0.5,0.0,0.0]), dofs_idx_local=dofs_idx)
    for _ in range(20): scene.step()

    cube_pos = cube.get_pos().numpy()
    waypoints = [cube_pos+[0,0,0.12], cube_pos+[0,0,0.01],    # プリグラスプ, 把持
                 cube_pos+[0,0,0.15], [0.20,0.15,0.12]]        # 持ち上げ, 移動先
    frames = []
    for wp in waypoints:
        qpos_target = robot.inverse_kinematics(link=ee_link, pos=np.array(wp))
        for _ in range(50):
            robot.control_dofs_position(qpos_target, dofs_idx_local=dofs_idx)
            scene.step()
            frames.append({
                'observation.state':      robot.get_dofs_position(dofs_idx_local=dofs_idx).numpy(),
                'observation.images.top': cam.render(),
                'action':                 qpos_target.numpy(),
            })
    episodes.append(frames)
    if (ep+1) % 10 == 0: print(f'デモ生成 {ep+1}/{NUM_DEMOS}')
# LeRobotDataset形式への変換は公式APIを参照
```

**📝 Sim/Realデータの混合**：NVIDIAの研究では、実機データにシミュレーションデータを7〜10%混ぜるだけで汎化性能が大きく改善したと報告されている。GenesisデモをLeRobotDataset形式に変換して実機データと組み合わせるのが実践的だ。

:::message
📷 **画像プレースホルダー**：Genesisで生成したシミュレーションデモと実機デモを並べた比較図。俯瞰カメラ視点で同じ把持動作を示し、「両者を混ぜて学習する」という流れを矢印で表す。
:::

## 7.6　学習済みポリシーの評価

学習したACTポリシーを実機で推論しながら記録し、成功率を測る（**実機推論はMac**）。

```bash
lerobot-record \
  --robot.type=so101_follower --robot.port=/dev/ttyACM0 --robot.id=my_follower_arm \
  --robot.cameras="{ top: {type: opencv, index_or_path: 0, width: 640, height: 480, fps: 30},
                     wrist: {type: opencv, index_or_path: 2, width: 320, height: 240, fps: 30} }" \
  --policy.path=outputs/train/act_so101_grasp/checkpoints/100000/pretrained_model \
  --dataset.repo_id=${HF_USER}/so101_eval_act \
  --dataset.num_episodes=20 --dataset.single_task="Pick up the red cube"
```

| 評価指標 | 説明 | 目標値（キューブ把持） |
|---|---|---|
| Task Success Rate | タスク完了エピソードの割合 | 50本:60%以上 / 100本:75%以上 |
| Completion Time | 平均完了時間 | 15秒以内 |
| Generalization Range | 初期位置ばらつきへの成功率 | ±10cmで60%以上維持 |
| Rollout Stability | 動作の滑らかさ | per-step delta < 5deg |

## 7.7　よくある失敗パターンと対処法

| 症状 | 原因 | 対処 |
|---|---|---|
| 同じ動作を繰り返しフリーズ | コンパウンドエラー（分布外へ） | DAgger／失敗からの回復デモを追加 |
| 把持直前で止まる | グリッパー動作の不一致 | 閉じるタイミングを統一し明確に |
| 特定のカメラ方向でのみ成功 | カメラ位置がデモ時とずれ | 台に固定しずれ防止ガイドを設置 |
| lossが下がらない | データのバグ／過少 | `dataset[0]` で観測・行動の対応を検証 |
| 推論が非常に遅い | DPのdenoising stepが多い | `num_inference_steps` を10に |
| 成功率がランダム以下 | 観測ミス（画像が黒等） | `display_data=true` で目視確認 |

## 7.8　マルチタスク学習

`dataset.single_task` を変えながら複数タスクを1つのリポジトリに集め、言語条件付き（`--policy.use_language_conditioning=true`）で学習すると、タスク記述に応じて行動を切り替えるマルチタスクポリシーになる。

```bash
# タスクごとに記述を変えて同じリポジトリへ追記
lerobot-record --dataset.repo_id=${HF_USER}/so101_multi_task \
  --dataset.single_task="Pick up the red cube and place it in the box" --dataset.num_episodes=50 ...
lerobot-record --dataset.repo_id=${HF_USER}/so101_multi_task \
  --dataset.single_task="Stack the blue cube on top of the red cube" --dataset.num_episodes=50 ...
# 言語条件付きで学習
lerobot-train --dataset.repo_id=${HF_USER}/so101_multi_task \
  --policy.type=act --policy.use_language_conditioning=true --output_dir=outputs/train/act_multi_task ...
```

学習済みモデルは `huggingface-cli login` の後、`--policy.repo_id=${HF_USER}/act_so101_grasp_cube` で Hugging Face Hub に公開でき、他のSO-101ユーザーがファインチューニングの出発点に使える。

## 7.9　RL × IL ハイブリッドパイプライン

強化学習（第6章）・模倣学習（本章）・Sim2Real（次章）を組み合わせた実践フローを俯瞰しておく。学ぶ順序（RL→IL→Sim2Real）と、実際に運用するときのフロー（下表）は少し異なる点に注意してほしい。

| フェーズ | 手法 | 目的 |
|---|---|---|
| Phase 1 | Genesis並列RL（第6章） | 初期ポリシーの高速獲得 |
| Phase 2 | 実機デモ収集（本章） | 高品質デモの収集（RLポリシーを補助に） |
| Phase 3 | ACT/DPファインチューニング（本章） | 精度・汎化性能の向上 |
| Phase 4 | Sim2Real転送（次章） | 実機への安全な移植と動作確認 |
| Phase 5 | 反復改善 | 評価結果を基にデモ追加・再学習 |

## 7.10　まとめ

- 模倣学習（ACT/DP）は報酬設計不要で、人間が示せる動作を直接学べる。50本のデモで70%以上の成功率が可能。
- データ品質がすべて。カメラ固定・背景統一・物体位置ランダム化・滑らかなデモの4点が要。
- ACTは高速・軽量・単一GPU対応で最初に試すべき手法。Diffusion Policyはマルチモーダルな行動分布に強い。
- GenesisのスクリプトデモやRLポリシーで大量のシミュレーションデモを生成し、実機データと混合すると汎化が向上する。
- **デモ収集・実機推論はMac、学習はColab**の役割分担が効率的。
- RL（探索）× IL（精度・実機適応）のハイブリッドが、現在の実用的なロボット学習の王道だ。

次章では、ここまで学んだポリシー（RL／IL）を**実機SO-101に安全に転送する Sim2Real** の手順を扱う。シミュレーションと現実のギャップをどう埋めるかが焦点だ。

*第8章へ続く →*


---
# 第8章　Sim2Real — 学習済みポリシーを実機SO-101に転送する
---

第6章（強化学習）・第7章（模倣学習）で作ったポリシーを、いよいよ実物のSO-101で動かす。シミュレーションと実機の橋渡し（Sim2Real）は、ロボット学習における最大の実装課題の一つだ。焦点は「リアリティギャップ」——シミュレーターの完璧な物理と、摩擦・ノイズ・遅延を抱えた実機との差——をどう埋めるかにある。

:::message
💻 **この章はMacが主役**：実機制御（USBでサーボと通信）は、まさにMacの得意分野だ。原典の多くはUbuntuを前提にするが、LeRobotはmacOSでも動き、ポートは `/dev/tty.usbmodemXXXX` として現れる。GPUは要らない——**手元のM4 Macとアーム1本で、シミュレーションの学習成果を現実に持ち込める。**
:::

## 8.1　Sim2Realとリアリティギャップ

「シミュレーターで完璧に動くのに実機では全く動かない」——ロボット学習で最もよく経験する挫折だ。原因を体系的に理解しておく。

| ギャップの種類 | 具体例 | 対策 |
|---|---|---|
| 物理モデル誤差 | 実機の関節に摩擦・バックラッシュがある | ドメインランダマイゼーション（第6章6.6） |
| 観測ノイズ | 実機はエンコーダノイズを持つ | 学習時に観測ノイズを追加 |
| アクチュエーター遅延 | 実機はUSB通信遅延がある | シミュレーターにも遅延を模擬 |
| 座標系の不一致 | Genesisと実機で符号・ゼロ点が違う | キャリブレーション座標変換（8.5） |
| 接触モデル誤差 | 摩擦係数・弾性が実機と異なる | 把持面の摩擦を実測値に調整 |

**📌 SO-101特有の注意**：公式の `lerobot-sim2real` によると、SO-101はSO-100と外見は似ているがギア比・関節構造に違いがあり、そのままではSim2Realに失敗しうる。本章は確認済みの相違点を踏まえて解説する。

## 8.2　実機SO-101のセットアップ

必要なものは、SO-101フォロワーアーム（STS3215×6）、バスサーボアダプター（USB接続）、電源（7.4V/12V 5A以上）、ホストPC（**M4 Mac可**、Python 3.10/3.11）、任意でUSBカメラ。

LeRobotはソースからインストールする。

```bash
conda create -n lerobot python=3.11 && conda activate lerobot
git clone https://github.com/huggingface/lerobot.git && cd lerobot
pip install -e '.[feetech]'      # Feetech(STS3215) SDKを含む
python -c "import lerobot; print(lerobot.__version__)"
```

USBポートを特定する。`lerobot-find-port` を実行し、アダプターを抜いたときに消えるポートがフォロワーだ。

```bash
lerobot-find-port
# macOS 例: /dev/tty.usbmodemXXXX  /  Linux 例: /dev/ttyACM0
# Linuxで権限が必要な場合: sudo usermod -a -G dialout $USER
```

## 8.3　キャリブレーション — 最重要ステップ

キャリブレーションはSim2Real成功の要だ。各サーボの物理的な可動域（最小・最大）をLeRobotに登録することで、任意の関節角を標準化された値に変換でき、シミュレーション座標と実機座標のマッピングが成立する。

```bash
lerobot-calibrate --robot.type=so101_follower \
  --robot.port=/dev/tty.usbmodemXXXX --robot.id=my_follower_arm
# 手順: ①ホーム付近へ移動してEnter ②各関節を最大・最小まで動かす
#       ③ ~/.cache/huggingface/lerobot/calibration/.../my_follower_arm.json に保存
```

:::message alert
⚠️ **キャリブレーション中の安全**：この間モータートルクが無効化され、アームが自重で落下しうる。手で支えながら実施すること。特に関節3（前腕）は重力の影響を受けやすい。
:::

## 8.4　テレオペレーションで動作確認

ポリシー転送の前に、テレオペレーション（リーダーアームによる手動制御）で実機が正常に動くことを確認する。安全確認の最初の関門だ。

```bash
lerobot-teleoperate \
  --robot.type=so101_follower --robot.port=/dev/tty.usbmodemXXXX --robot.id=my_follower_arm \
  --teleop.type=so101_leader --teleop.port=/dev/tty.usbmodemYYYY --teleop.id=my_leader_arm \
  --display_data=true   # カメラを付ける場合は --robot.cameras=... を追加しRerunで可視化
```

| 確認項目 | 正常 | 異常と対処 |
|---|---|---|
| 全関節の追従 | リーダーに滑らかに追従 | 特定関節が動かない → キャリブレーション再実施 |
| グリッパー | 開閉が正確 | 逆向きに動く → `drive_mode` を変更 |
| トルク感度 | 適度な抵抗感 | カクつく → `kp` が高すぎ／電圧不足 |
| USBエラー | エラーなく継続 | `JointOutOfRangeError` → キャリブレーション再実施 |

## 8.5　座標系変換 — Genesisと実機の橋渡し

GenesisとLeRobotでは関節角の表現が異なる（単位・ゼロ点・符号・正規化）。この変換を正確に実装しないとポリシーが実機で暴走する。

| 項目 | Genesis | LeRobot（実機） |
|---|---|---|
| 単位 | ラジアン | 度（デフォルト） |
| ゼロ点 | URDFのデフォルト姿勢 | キャリブレーション時のホーム姿勢 |
| 符号方向 | 右手系（URDF依存） | モーターID・gear設定に依存 |
| グリッパー | ラジアンの回転角 | 0〜100%（0=全開/100=全閉） |

変換を1クラスに集約する。`SIGN_CORRECTIONS` と `HOME_OFFSET_RAD` は**実機で1関節ずつ確認して調整する**。

```python
# sim2real/coord_transform.py
import numpy as np, math

class SO101CoordTransform:
    """Genesis[rad] ←→ LeRobot実機[deg] の座標変換。符号は実機で必ず確認する。"""
    JOINT_NAMES = ['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper']
    SIGN_CORRECTIONS = {   # 逆転していれば -1 にする
        'shoulder_pan': -1, 'shoulder_lift': 1, 'elbow_flex': 1,
        'wrist_flex': 1, 'wrist_roll': -1, 'gripper': 1}
    HOME_OFFSET_RAD = {    # Genesisホーム姿勢と実機ゼロ点のオフセット
        'shoulder_pan': 0.0, 'shoulder_lift': 1.0, 'elbow_flex': -1.5,
        'wrist_flex': 0.5, 'wrist_roll': 0.0, 'gripper': 0.0}

    @classmethod
    def sim_to_real(cls, sim_qpos_rad):
        """Genesis関節角[rad] → LeRobotコマンド[deg]"""
        out = {}
        for i, name in enumerate(cls.JOINT_NAMES):
            delta = sim_qpos_rad[i] - cls.HOME_OFFSET_RAD[name]
            out[name] = math.degrees(delta * cls.SIGN_CORRECTIONS[name])
        return out

    @classmethod
    def real_to_sim(cls, real_obs_deg):
        """LeRobot観測[deg] → Genesis観測[rad]"""
        out = np.zeros(len(cls.JOINT_NAMES))
        for i, name in enumerate(cls.JOINT_NAMES):
            rad = math.radians(real_obs_deg.get(name, 0.0))
            out[i] = rad * cls.SIGN_CORRECTIONS[name] + cls.HOME_OFFSET_RAD[name]
        return out

    @classmethod
    def gripper_sim_to_real(cls, gripper_rad, gripper_max_rad=1.0):
        """グリッパー: rad → 0〜100%"""
        return float(np.clip(gripper_rad / gripper_max_rad, 0.0, 1.0) * 100.0)
```

:::message alert
⚠️ **符号補正は必ず実機で確認**：`SIGN_CORRECTIONS` はURDFバージョンや組み立て方向で変わる。初回は低速で1関節ずつ動作方向を確認し、期待と逆なら `-1` にすること。
:::

## 8.6　安全な段階的動作確認プロトコル

学習済みポリシーを投入する前に、必ず段階的に確認する。「動くか」より先に「安全に動くか」を確かめる。モーターバスは `FeetechMotorsBus` で直接扱える。

```python
# sim2real/safety_check.py
import time, numpy as np
from lerobot.motors import Motor, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus

bus = FeetechMotorsBus(port='/dev/tty.usbmodemXXXX', motors={
    'shoulder_pan':  Motor(1, 'sts3215', MotorNormMode.DEGREES),
    'shoulder_lift': Motor(2, 'sts3215', MotorNormMode.DEGREES),
    'elbow_flex':    Motor(3, 'sts3215', MotorNormMode.DEGREES),
    'wrist_flex':    Motor(4, 'sts3215', MotorNormMode.DEGREES),
    'wrist_roll':    Motor(5, 'sts3215', MotorNormMode.DEGREES),
    'gripper':       Motor(6, 'sts3215', MotorNormMode.DEGREES)})
bus.connect()

print("=== 現在の関節角 ===", bus.read('Present_Position'))

# ゆっくりホームへ（手を離して観察、異常ならCtrl+C）
HOME_DEG = {name: 0.0 for name in bus.motors}
print("ホームへ移動します。3秒後に開始。"); time.sleep(3)
bus.write('Goal_Position', HOME_DEG); time.sleep(2)

# 1関節ずつ+10度動かして方向を目視確認
def test_joint_direction(joint_name, delta_deg=10.0):
    cur = bus.read('Present_Position')
    bus.write('Goal_Position', {joint_name: cur[joint_name] + delta_deg})
    time.sleep(1.5)
    print(f"{joint_name}: {cur[joint_name]:.1f} → {bus.read('Present_Position')[joint_name]:.1f} deg")

for name in bus.motors:
    input(f"\n{name} をテスト。Enterで続行...")
    test_joint_direction(name)
    input("方向は正しかった？ Enterでホームへ...")
    bus.write('Goal_Position', HOME_DEG); time.sleep(1.5)
bus.disconnect()
```

## 8.7　ポリシー推論スクリプト

動作確認が済んだら、学習済みポリシー（第6章の `final_policy.pt` 等）を実機で動かす。**1ステップの最大移動量を制限する安全クリップが要**だ。

```python
# sim2real/run_policy.py
import time, numpy as np, torch
from lerobot.motors import Motor, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus
from coord_transform import SO101CoordTransform

POLICY_PATH, MAX_STEPS, STEP_DT = 'logs/so101_grasp/v1/final_policy.pt', 200, 0.05
MAX_DELTA_DEG = 5.0   # 1ステップの最大移動量。まず5度から

bus = FeetechMotorsBus(port='/dev/tty.usbmodemXXXX', motors={
    n: Motor(i+1, 'sts3215', MotorNormMode.DEGREES) for i, n in enumerate(
    ['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper'])})
bus.connect()
policy = torch.load(POLICY_PATH, map_location='cpu'); policy.eval()

print(f"推論開始（最大移動 {MAX_DELTA_DEG} deg/step）。Ctrl+Cで停止。"); time.sleep(2)
try:
    for step in range(MAX_STEPS):
        t0 = time.time()
        real_obs   = bus.read('Present_Position')                  # deg
        sim_obs    = SO101CoordTransform.real_to_sim(real_obs)      # rad
        with torch.no_grad():
            action = policy(torch.tensor(sim_obs, dtype=torch.float32).unsqueeze(0))
        target_real = SO101CoordTransform.sim_to_real(sim_obs + action.squeeze(0).numpy())
        # 安全クリップ: 現在位置からのデルタを ±MAX_DELTA_DEG に制限
        safe = {name: real_obs[name] + np.clip(target_real[name] - real_obs[name],
                                               -MAX_DELTA_DEG, MAX_DELTA_DEG) for name in bus.motors}
        bus.write('Goal_Position', safe)
        if step % 20 == 0: print(f"Step {step:3d}: {safe}")
        time.sleep(max(0, STEP_DT - (time.time() - t0)))            # 20Hz制御周期
except KeyboardInterrupt:
    print("\n=== ユーザー停止 ===")
finally:
    bus.disconnect()   # 終了時は必ずトルク無効化
```

:::message alert
🔒 **安全第一**：`MAX_DELTA_DEG` は5度から始め、安定してから10・15・20度と段階的に緩める。急な速度変化はメカニカルストレスで3Dプリントパーツ破損やサーボ脱調を招く。
:::

:::message
📷 **画像プレースホルダー**：Sim2Realの流れ図。Genesisで学習したポリシー →（座標変換）→ 実機SO-101、というパイプラインを、シミュレーション画面と実機写真を左右に並べて示す。
:::

## 8.8　実機ファインチューニングという保険

ドメインランダマイゼーションを尽くしてもギャップが残る場合は、実機デモを50〜100本追加収集してファインチューニングするのが最も効果的だ。デモ収集・学習の手順は第7章（模倣学習）と同じ `lerobot-record` / `lerobot-train` を使う。

| アプローチ | 特徴 | 適用場面 |
|---|---|---|
| Sim2Real直接転送 | 追加コストなし。DRが十分なら機能 | 対象が単純・作業空間が狭い |
| 実機ファインチューニング | 50〜100デモで大幅改善 | ギャップが残る・視覚ポリシー |
| Sim+Real混合学習 | シミュ93%＋実機7%が有効との報告 | 大規模・高汎化が必要 |
| 端から模倣学習 | Sim2Realを回避 | シミュ環境が正確でない場合 |

## 8.9　Sim2Real トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| 最初から暴走 | 座標変換の符号ミス | 1関節ずつ `SIGN_CORRECTIONS` 確認、`MAX_DELTA_DEG=2` で試す |
| 特定関節だけ逆向き | その関節の符号が未補正 | 対象関節を `-1` に |
| 到達精度が悪い | `HOME_OFFSET_RAD` のずれ | 実機ホーム姿勢をGenesisで再現し調整 |
| `JointOutOfRangeError` | 可動域超過の指令 | `MAX_DELTA_DEG` を下げる／再キャリブレーション |
| 把持できない | グリッパー変換ミス | `gripper_sim_to_real` を確認 |
| 実機成功率が極端に低い | DR不足 | 6.6のランダム化範囲を広げ再学習 |
| USB通信エラー頻発 | ケーブル／ボーレート | ケーブル交換／`lerobot-setup-motors` で再設定 |

## 8.10　まとめ

- Sim2Realは「物理誤差・観測ノイズ・遅延・座標系不一致・接触モデル誤差」の5ギャップを意識して取り組む。
- `lerobot-calibrate` によるキャリブレーションが最重要。各サーボの可動域登録が全ての基盤。
- `SO101CoordTransform` で `Genesis[rad] ←→ LeRobot[deg]` を一元管理し、符号は実機で1関節ずつ確認する。
- 初回は `MAX_DELTA_DEG=5` の安全クリップをかけ、段階的に緩める安全プロトコルを必ず守る。
- ギャップが残るなら、50〜100本の実機デモでファインチューニングするのが最も効果的。
- **これらはすべてM4 Macで完結できる。** シミュレーションで鍛えたポリシーが、手元のアームで動く瞬間がPhysical AIの醍醐味だ。

ここまでで「Genesisで学び、実機で動かす」一周を体験した。次章からは応用編に入る。第9章では、本書のもう一つのメインテーマ——都市規模のマルチエージェントシミュレーション **MESA×Genesis** ——へ進む。

*第9章へ続く →*


