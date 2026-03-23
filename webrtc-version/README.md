# Cloud Renderer — Three.js → WebRTC → Browser

サーバー側でThree.jsをヘッドレスレンダリングし、WebRTCでブラウザにストリーム配信するシステム。

## アーキテクチャ

```
[Node.js Server]
  headless-gl         ← OpenGLコンテキスト (GPU不要)
  Three.js            ← 3Dシーンレンダリング
  RGBA → I420変換      ← WebRTCフォーマット
  wrtc (VideoSource)  ← フレームをWebRTCトラックに注入
  WebSocket           ← SDPシグナリング
       ↓ WebRTC (VP8/H264)
[Browser Client]
  RTCPeerConnection   ← ビデオトラック受信
  <video> element     ← 再生
```

## セットアップ

### 依存パッケージのインストール

```bash
npm install
```

> **注意**: `wrtc` はネイティブビルドが必要です。
> ビルドツールが必要: `npm install -g node-gyp`
> macOS: `xcode-select --install`
> Linux: `apt-get install build-essential`

### サーバー起動

```bash
npm start
# → http://localhost:8080 でアクセス
```

### ブラウザで開く

```
http://localhost:8080
```

[ CONNECT ] ボタンを押すとWebRTCネゴシエーションが始まり、
サーバーで動くThree.jsのシーンがリアルタイムにストリームされます。

## ファイル構成

```
server.js     ← メインサーバー (Three.js + WebRTC送信側)
client.html   ← ブラウザクライアント (WebRTC受信側)
package.json
```

## カスタマイズポイント

### server.js

- `WIDTH / HEIGHT / FPS` — 解像度とフレームレート
- `createHeadlessRenderer()` 内のシーン構築部分を差し替えると
  任意のThree.jsシーンをストリームできます
- `renderFrame()` — フレームごとのアニメーションロジック

### MESAへの応用

MESAのシミュレーション可視化をサーバー側で動かし、
ブラウザには映像だけを送ることで:
- クライアントにThree.js不要
- エージェント数が増えても描画負荷をサーバーに集約
- 複数クライアントが同じシミュレーションを閲覧可能

## トラブルシューティング

| 問題 | 対処 |
|------|------|
| `wrtc` インストール失敗 | node-gyp + ビルドツールを確認 |
| 映像が出ない | ICEのSTUNが通っているか確認 |
| FPSが低い | `WIDTH/HEIGHT` を下げるか、`gl`のGPUバックエンドを確認 |
| headless-glエラー | Linux環境では `apt-get install libgl1-mesa-dev` |

## 制限事項

- `wrtc` はNode.js v18/v20 推奨 (v22では要確認)
- `headless-gl` はCPUレンダリング (GPU使用の場合はEGL設定が必要)
- 本番環境ではSTUNの代わりにTURNサーバーが必要
