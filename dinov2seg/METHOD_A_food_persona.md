# 方法A・案2 — 「グルメ＝飲食店に寄る」ペルソナの作り方

DINOv2 の CLS(384) に **「視界にある建物の種類」one-hot(8)** を足した **392次元** で学習し、
飲食店タイプに到着したら追加報酬を与える。

- **学習時**：建物種類は環境が持つ正解（`BTYPE_T`）から one-hot で与える（赤箱の学習画面では分類器が使えないため）。
- **本番(サーバー)時**：既存の `building_classifier.onnx` がテクスチャから同じ8確率を供給（サーバーは392経路対応済み）。

クラス順（学習・分類器・サーバーで共通）:
`0:gyudon 1:ramen 2:bento 3:cafe 4:office 5:house 6:conbini 7:hospital`
**飲食店 = [0,1,2,3]**

> 注意：このパッチは `dinov2seg/step2_persona_train.ipynb` 用。Colabで動かして検証してください。

---

## ① 定数（セル3の末尾に追記）

```python
# 観測 = DINOv2 CLS(384) + 建物クラス one-hot(8) = 392
OBS_FEAT     = DINO_DIM + N_BLDG_CLASSES         # 392
BLDG_CLASSES = ['gyudon','ramen','bento','cafe','office','house','conbini','hospital']
FOOD_CLASSES = [0,1,2,3]                          # 飲食店タイプ
```

---

## ② 建物サブタイプmap（セル4に追記）

`BCELLS_T` 定義の直後に追加：

```python
def assign_building_types(bcells_np, seed=123):
    rng = np.random.default_rng(seed)
    bt = np.full((GRID, GRID), -1, dtype=np.int64)
    for (r, c) in bcells_np:
        bt[r, c] = int(rng.integers(0, 8))   # 0-7 を割当
    return bt

BTYPE_NP = assign_building_types(BCELLS_NP)
BTYPE_T  = torch.tensor(BTYPE_NP, device=DEVICE)
```

`randomize_map()` の中（`BCELLS_T = ...` の後）にも追加し、`global` 宣言に `BTYPE_NP, BTYPE_T` を足す：

```python
def randomize_map():
    global MAP_NP, MAP_T, MAP_F, PASS_T, BCELLS_NP, BCELLS_T, NB, BTYPE_NP, BTYPE_T
    # ... 既存処理 ...
    BTYPE_NP = assign_building_types(BCELLS_NP, seed=random.randint(0, 10**9))
    BTYPE_T  = torch.tensor(BTYPE_NP, device=DEVICE)
```

> サーバーの建物配置と**セル単位で一致させる必要はありません**。「種類kを見て、飲食店なら寄ると良い」を学ぶだけなので、index↔種類の意味（上のクラス順）さえ一致していればOKです。

---

## ③ 視界の建物種類を取得する関数（セル6の先頭・class定義の前に追加）

```python
def building_in_view(xs, ys, ths):
    """中央レイ(向きθ)で最初に当たる建物の種類を one-hot(N,8)で返す。
       道路は通過、木/空地で遮蔽されたら建物なし(ゼロ)。学習時の擬似分類器。"""
    N = xs.shape[0]
    dx = torch.cos(ths); dy = torch.sin(ths)
    onehot = torch.zeros(N, N_BLDG_CLASSES, device=DEVICE)
    active = torch.ones(N, dtype=torch.bool, device=DEVICE)   # まだ何にも当たっていない
    d = RAY_STEP
    while d <= RAY_MAX and bool(active.any()):
        px = xs + dx*d; py = ys + dy*d
        inb = (px>=0)&(px<GRID)&(py>=0)&(py<GRID)
        ri = px.long().clamp(0, GRID-1); ci = py.long().clamp(0, GRID-1)
        ct = MAP_T[ri, ci]
        hit = active & inb & (ct != ROAD)            # 最初の非道路ヒット
        is_bldg = hit & (ct == BUILDING)
        if bool(is_bldg.any()):
            bt  = BTYPE_T[ri, ci].clamp(min=0)
            idx = torch.nonzero(is_bldg).squeeze(1)
            onehot[idx, bt[idx]] = 1.0
        active = active & ~hit                         # ヒットしたレイは終了
        d += RAY_STEP
    return onehot
```

> もし寄り方が弱ければ、中央1本ではなく中央±数本のレイを平均すると、全画面を見る分類器の挙動に近づきます。

---

## ④ 環境：bldg() メソッド と グルメ報酬（セル6・PersonaVecEnv）

クラス内にメソッド追加：

```python
    def bldg(self):
        """現在状態の視界中央の建物タイプ one-hot (N,8)"""
        return building_in_view(self.x, self.y, self.th)
```

`step()` の **`rew=torch.where(arrived,rew+rp['goal_reward'],rew)` の直後**に追記：

```python
        # ── グルメ報酬: 飲食店タイプに到着したら追加ボーナス ──
        arr_bt  = BTYPE_T[ri2, ci2]                       # 到着セルの建物種類
        is_food = torch.zeros_like(arrived)
        for fc in rp.get('food_classes', []):
            is_food = is_food | (arr_bt == int(fc))
        rew = torch.where(arrived & is_food, rew + float(rp.get('food_bonus', 0.0)), rew)
```

---

## ⑤ PolicyNet：観測に建物 one-hot を渡す（セル7のメソッドを差し替え）

`forward` / `act` を **(画像, 建物one-hot)** を取る形に変更し、学習時は分類器を呼ばず軽い CLS 抽出を使う：

```python
    def _cls(self, x):
        if x.dim() == 2: x = x.view(-1, IMG_CH, IMG_H, IMG_W)
        x = normalize_for_dino(x)
        with torch.no_grad():
            feat = dino_backbone.forward_features(x)['x_norm_clstoken']   # (N,384)
        return feat

    def forward(self, x, bld):
        feat     = self._cls(x)
        combined = torch.cat([feat, bld], dim=1)        # (N, 392)
        h        = self.fc(combined)
        return self.actor(h), self.critic(h)

    def act(self, x, bld):
        lg, val = self.forward(x, bld)
        dist    = torch.distributions.Categorical(torch.softmax(lg, -1))
        a       = dist.sample()
        return a, dist.log_prob(a), dist.entropy(), val.squeeze(-1)

    def get_seg_passable(self, x):
        if x.dim() == 2: x = x.view(-1, IMG_CH, IMG_H, IMG_W)
        xx = normalize_for_dino(x)
        with torch.no_grad():
            patch = dino_backbone.forward_features(xx)['x_norm_patchtokens']
        return get_passable_from_seg(patch.cpu().numpy().astype(np.float32))
```

セル7末尾の動作確認も2引数に修正：

```python
_net   = PolicyNet().to(DEVICE)
_dummy = torch.randn(2, IMG_CH, IMG_H, IMG_W, device=DEVICE)
_bld   = torch.zeros(2, N_BLDG_CLASSES, device=DEVICE)
_lg, _val = _net.forward(_dummy, _bld)
assert _lg.shape == (2, ACT_DIM)
print('forward OK', _lg.shape, _val.shape)
```

---

## ⑥ 学習ループ：建物 one-hot をバッファに通す（セル9）

変更点だけ。

**(a) reset 直後**：
```python
    obs = env.reset_all()
    bld = env.bldg()                                   # ← 追加
```

**(b) バッファ追加**（`obs_buf` 定義の近く）：
```python
    bld_buf = torch.zeros(ROLLOUT, N_ENVS, N_BLDG_CLASSES, device=DEVICE)
```

**(c) Domain Randomization の `obs = env.reset_all()` の後**：
```python
            obs = env.reset_all()
            bld = env.bldg()                           # ← 追加
```

**(d) Rollout ループ**：
```python
        for t in range(ROLLOUT):
            with torch.no_grad():
                actions, logps, _, values = policy.act(obs, bld)   # ← bld
            obs_buf[t]  = obs
            bld_buf[t]  = bld                                       # ← 追加
            act_buf[t]  = actions
            logp_buf[t] = logps
            val_buf[t]  = values
            obs, rew, done = env.step(actions)
            bld = env.bldg()                                        # ← 追加(新状態)
            rew_buf[t]  = rew
            done_buf[t] = done.float()
            # ... 統計は既存のまま ...
```

**(e) GAE ブートストラップ**：
```python
        with torch.no_grad():
            _, lv = policy.forward(obs, bld); lv = lv.squeeze(-1)   # ← bld
```

**(f) PPO reshape & 更新**：
```python
        obs_f = obs_buf.reshape(B, IMG_CH, IMG_H, IMG_W)
        bld_f = bld_buf.reshape(B, N_BLDG_CLASSES)                  # ← 追加
        # ... act_f / logp_f / adv_f / ret_f は既存のまま ...

        for _ in range(EPOCHS):
            perm = torch.randperm(B, device=DEVICE)
            for s in range(0, B, MINIBATCH):
                mb     = perm[s:s+MINIBATCH]
                lg, vs = policy.forward(obs_f[mb], bld_f[mb])       # ← bld_f[mb]
                # ... 以降の loss 計算は既存のまま ...
```

---

## ⑦ エクスポート：392入力に修正（セル8）

`export_persona_onnx` 内：

```python
    dummy_flat = torch.zeros(1, OBS_FEAT)              # 384 → OBS_FEAT(=392)
    # ...
    dummy_np = np.zeros((1, OBS_FEAT), dtype=np.float32)
    # ...
```

meta に種類情報を明記（`input_size` を 392 に）：

```python
        'obs_type':       'fp_image',
        'input_size':     OBS_FEAT,                    # 392
        'obs_components': ['cls', 'building_probs'],   # サーバーが連結する順
        'n_bldg_classes': N_BLDG_CLASSES,
        'bldg_classes':   BLDG_CLASSES,
```

---

## ⑧ 報酬パラメータ（セル10 と persona_rewards.json）

セル10：food 系キーを追加処理：

```python
for pid, rp in all_rewards.items():
    for k in FLOAT_KEYS:
        rp[k] = float(rp.get(k, 0.0))
    rp['food_bonus']   = float(rp.get('food_bonus', 0.0))
    rp['food_classes'] = [int(x) for x in rp.get('food_classes', [])]
```

`persona_rewards.json`：グルメにしたいペルソナに2行足すだけ。例（A をグルメ化）:

```jsonc
"A": {
  "persona_id": "A",
  "persona_name": "グルメ太郎",
  "...": "...既存パラメータ...",
  "food_bonus": 8.0,
  "food_classes": [0, 1, 2, 3]
}
```

> `food_bonus` を入れないペルソナは従来通り（飲食店優遇なし）。複数ペルソナに別々の `food_classes` を与えれば「カフェ専門」「ラーメン党」なども作れます。

---

## ⑨ サーバー側（再掲・対応済み）

- `data/` に **`building_classifier.onnx`**（step1_5）を置く → サーバーが CLS(384) を分類器に通し、8確率を CLS に concat（392）してヘッドへ。これは [server.js](../server.js) で実装済み。
- meta の `input_size=392` を見て自動で392経路に入る。
- 期待ログ：`[ONNX] persona_A OK  DINOv2(392)` / `[ONNX] building_classifier OK`

---

## 注意・既知のギャップ

1. **学習=one-hot / 本番=分類器softmax** … 種類表現が厳密には違う（one-hot vs 確率）。DINOv2＋FCで吸収できる範囲だが、寄り方が不安定なら本番の分類器精度（step1_5 の val_acc）を上げるのが効く。
2. **視界の定義** … 学習は中央レイ、本番分類器は全画面CLS。寄りが弱ければ ③ をコーン平均に広げる。
3. **クラス順は絶対に統一** … `BLDG_CLASSES`／building_classifier の `classes`／サーバー `BLDG_TYPES` の並びを一致させること（現状は一致）。
