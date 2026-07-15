# Ubuntu VPS セットアップ & 運用メモ

MESA Persona City Sim を Ubuntu VPS で動かすための手順まとめ。
SSH ポート `2222` / アプリポート `8080`（環境に合わせて読み替え）

---

## ⚡ よく使うコマンド（pm2 運用チートシート）

普段はこれだけ見ればOK。

```bash
# SSH ログイン（Macから）
ssh -p 2222 ユーザー名@サーバーのIP

# 状態確認 / ログ
pm2 list            # online か確認
pm2 logs mesa       # ログをリアルタイム表示（Ctrl+C で抜ける）
pm2 status mesa

# 操作
pm2 restart mesa    # 再起動
pm2 stop mesa       # 停止
pm2 start mesa      # 起動
pm2 delete mesa     # 登録解除

# コードを更新したとき
cd ~/mesa-clouds-renderer && git pull
pm2 restart mesa

# .env（キー）を書き換えたとき ※source が必要
cd ~/mesa-clouds-renderer
set -a; source .env; set +a
pm2 restart mesa --update-env
```

### アプリの初回登録（pm2 に載せ直すとき）
`pm2 delete` した後などに、また mesa を登録する手順。

```bash
cd ~/mesa-clouds-renderer
set -a; source .env; set +a      # .env を読み込む（重要）
pm2 start "xvfb-run -s '-screen 0 1x1x24' node server.js" --name mesa
pm2 save                          # 状態を保存（再起動後の復活用）
```

> ⚠️ `.env` を読ませるには起動前に必ず `set -a; source .env; set +a` を実行すること。
> これを忘れると `YT_STREAM_KEY` などが渡らず YouTube 配信が無効になる。

ブラウザ確認: http://サーバーのIP:8080

---

## 🆕 まっさらな VPS を最初からセットアップする手順

新しいサーバーを立てたとき用。上から順に実行。

### 1. システム更新
```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### 2. Git
```bash
sudo apt-get install -y git
```

### 3. Node.js 18+（LTS 20 を推奨）
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

### 4. ネイティブビルド用ライブラリ（headless-gl / xvfb 用・必須）
このアプリは `gl`（headless-gl）でヘッドレス描画するため必須。
```bash
sudo apt-get install -y \
  build-essential python3 pkg-config \
  libgl1-mesa-dev libglu1-mesa-dev \
  libxi-dev libxext-dev \
  xvfb
```

### 5. ffmpeg（YouTube 配信を使う場合のみ）
```bash
sudo apt-get install -y ffmpeg
```

### 6. スワップ追加（メモリ不足＝OOM 対策・推奨）
メモリの少ない VPS だと `npm install` 中に OOM で殺されるため。
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h                                         # Swap: 2.0Gi を確認
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 再起動後も有効
```

### 7. コード取得
```bash
cd ~
git clone https://github.com/oggata/mesa-clouds-renderer
cd mesa-clouds-renderer
```

### 8. 依存インストール（CUDA はスキップ！）
GPU の無い VPS では onnxruntime の CUDA バイナリ（数百MB）は不要かつ OOM の原因。
必ず `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` を付ける。
```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install
```
> CPU 版 ONNX で推論は問題なく動く。GPU が無いので CUDA は入れても使われない。

### 9. `.env` 作成（キー設定）
このアプリは `.env` を自動読込しない（dotenv 未使用）。値は起動時に `source` して渡す。
```bash
nano .env
```
中身:
```bash
YT_STREAM_KEY=あなたのYouTubeストリームキー
# 任意
# YT_VIDEO_BITRATE_K=3000
# PORT=8080
# WIDTH=720
# HEIGHT=720
# FPS=30
```
Git に載せない:
```bash
echo ".env" >> .gitignore
```

### 10. ファイアウォール（8080 開放）
ufw が有効な場合:
```bash
sudo ufw allow 8080/tcp
sudo ufw reload
sudo ufw status
```
> さくら VPS の場合、管理コンソールの「パケットフィルタ」でも 8080/TCP の許可が必要なことがある。

### 11. pm2 で常駐化
```bash
sudo npm install -g pm2

cd ~/mesa-clouds-renderer
set -a; source .env; set +a
pm2 start "xvfb-run -s '-screen 0 1x1x24' node server.js" --name mesa

pm2 save
pm2 startup      # 表示されたコマンドをコピペ実行 → OS 起動時に自動立ち上げ
```

### 12. 確認
```bash
pm2 list
pm2 logs mesa
```
ログに `[Loops] sim / render / stats loops started` が出れば成功。
ブラウザで http://サーバーのIP:8080

---

## 🔧 トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `npm install` が `Killed` / exit 137 | OOM。手順6のスワップ追加＋手順8の CUDA スキップ |
| `libonnxruntime_providers_cuda.so` を DL しようとする | `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` を付け忘れ |
| `gl` のビルドで失敗 | 手順4のライブラリ不足 |
| ブラウザで開けない | ufw で 8080 開放 + さくらのパケットフィルタ確認 |
| `[YT] YT_STREAM_KEY 未設定` が出る | 起動前に `set -a; source .env; set +a` を忘れている |
| YouTube 配信されない | ffmpeg 未インストール（手順5） |
| ポート確認 | `sudo ss -tlnp \| grep 8080`（`0.0.0.0:8080` ならOK） |

## 📝 メモ
- アプリは全インターフェース（0.0.0.0）で待ち受けるので、ログの `http://localhost:8080` 表示は気にしなくてよい。外部 IP からアクセス可能。
- 環境変数一覧は `server.js` の冒頭（36〜59 行目付近）を参照: `PORT / WIDTH / HEIGHT / FPS / JPEG_Q / TICK / MAX_TRAIL / INFER_EVERY / YT_STREAM_KEY / YT_RTMP_URL / YT_VIDEO_BITRATE_K` など。
- CUDA/GPU は不要。CPU 版 ONNX で動作する。
