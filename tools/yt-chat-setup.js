#!/usr/bin/env node
/**
 * YouTube ライブチャット連携のセットアップ補助 (依存パッケージなし / Node 18+)
 *
 *   1) APIキーだけで読めるか試す
 *      node tools/yt-chat-setup.js check --key=API_KEY --video=VIDEO_ID
 *      node tools/yt-chat-setup.js check --key=API_KEY --channel=CHANNEL_ID
 *
 *   2) OAuth が要るときのリフレッシュトークン取得 (TV/限定入力デバイス方式)
 *      node tools/yt-chat-setup.js auth --client-id=xxx --client-secret=yyy
 *      → 読むだけなら↑で足りる。**チャットに返信する (YT_CHAT_REPLY=1) なら --reply を付ける**
 *      node tools/yt-chat-setup.js auth --client-id=xxx --client-secret=yyy --reply
 *      → OAuth クライアントが「テレビとリミット入力デバイス」型でないとき (Invalid client
 *        type) は **--local** を付ける。ブラウザで許可して 127.0.0.1 に戻す方式なので、
 *        「デスクトップアプリ」型のクライアントでもそのまま取れる:
 *          node tools/yt-chat-setup.js auth --local --reply
 *        ブラウザのある端末で実行すること (取れたトークンは本番サーバに写せる)。
 *      → **VPS などブラウザを開けないマシン**では --paste。手元の PC で許可して、
 *        飛ばされた先の URL (127.0.0.1 で「接続できません」になるやつ) を貼るだけ:
 *          node tools/yt-chat-setup.js auth --paste --reply
 *        読み取り専用スコープ (youtube.readonly) では liveChatMessages.insert が
 *        403 になる。--reply は書き込みもできる youtube.force-ssl を要求する
 *        (読み取りも含むので、これ1つで取り込みと返信の両方に使える)。
 *
 *   3) 取れたトークンで実際に読めるか確認
 *      node tools/yt-chat-setup.js check --video=VIDEO_ID \
 *           --client-id=xxx --client-secret=yyy --refresh=zzz
 *
 *   4) いま配信中の動画IDを探す (配信を立て直してIDが変わったとき)
 *      node tools/yt-chat-setup.js find --key=API_KEY --channel=CHANNEL_ID
 *      node tools/yt-chat-setup.js find --key=API_KEY --video=前のVIDEO_ID
 *        → 動画IDからチャンネルを引いてから探す。サーバ側 (YT_AUTO_FIND) と同じ手順。
 *
 * 【秘密情報について】このスクリプトは受け取った値を**この端末の標準出力にしか出さない**。
 * どこにも送信しないし、ファイルにも書かない。表示された値は .env などに自分で控えること
 * (.gitignore で .env は除外済み)。
 *
 * ★ 引数は **.env からも読む**。APIキーやクライアントシークレットをコマンドラインに
 *   並べると、シェルの履歴と `ps` の一覧に平文で残る。.env に入っていれば省略できる:
 *     --client-id     ← YT_OAUTH_CLIENT_ID
 *     --client-secret ← YT_OAUTH_CLIENT_SECRET
 *     --refresh       ← YT_OAUTH_REFRESH_TOKEN
 *     --key           ← YT_API_KEY
 *     --video         ← YT_VIDEO_ID
 *     --channel       ← YT_CHANNEL_ID
 *   明示した引数のほうが .env より優先される。ENV_FILE で場所を変えられる。
 *   これで返信用のトークン取得は引数ゼロで済む:
 *     node tools/yt-chat-setup.js auth --reply
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API = process.env.YT_CHAT_API_BASE || 'https://www.googleapis.com/youtube/v3';
// 読むだけなら readonly。チャットに投稿する (返信機能) には force-ssl が要る。
//   force-ssl は読み取りも含むので、返信を使うならこちら1つで足りる。
const SCOPE_READ  = 'https://www.googleapis.com/auth/youtube.readonly';
const SCOPE_WRITE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  if (m) args[m[1]] = m[2] || true;
}

// ── .env の読み込み (server.js と同じ書式・同じ規則) ─────────────────────────
//   秘密情報をコマンドラインに置かないための逃げ道。既にある環境変数は上書きしない。
(function loadDotEnv() {
  const fp = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(fp)) return;
    for (let line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      line = line.replace(/^\s*export\s+/, '');
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '').trim();
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (e) { console.warn(`(.env を読めませんでした: ${e.message})`); }
})();

// 引数が無ければ環境変数から補う。**引数のほうが優先**。
const FROM_ENV = {
  'client-id': 'YT_OAUTH_CLIENT_ID', 'client-secret': 'YT_OAUTH_CLIENT_SECRET',
  refresh: 'YT_OAUTH_REFRESH_TOKEN', key: 'YT_API_KEY',
  video: 'YT_VIDEO_ID', channel: 'YT_CHANNEL_ID',
};
const filled = [];
for (const [k, envKey] of Object.entries(FROM_ENV)) {
  if (!args[k] && process.env[envKey]) { args[k] = process.env[envKey]; filled.push(envKey); }
}
const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'check';
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
// 秘密情報は伏せて出す。端末のログやスクショから漏れるのを避けるため。
const mask = (v) => { const s = String(v || ''); return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`; };
if (filled.length) console.log(`(.env から補完: ${filled.join(' ')})`);

async function accessTokenFromRefresh() {
  if (!args['client-id'] || !args['client-secret'] || !args.refresh) return '';
  const body = new URLSearchParams({
    client_id: args['client-id'], client_secret: args['client-secret'],
    refresh_token: args.refresh, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) die(`リフレッシュトークンからアクセストークンを取れない: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

async function call(path, params, token) {
  const u = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  if (args.key) u.searchParams.set('key', args.key);
  const r = await fetch(u, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j,
           error: (j.error && j.error.message) || '', reason: (((j.error || {}).errors || [])[0] || {}).reason || '' };
}

// ── check: 実際に叩いて「APIキーだけで足りるか」を判定する ──────────────────
async function check() {
  if (!args.key && !args.refresh) die('--key か (--client-id --client-secret --refresh) のどちらかが要る');
  const token = await accessTokenFromRefresh();
  console.log(`\n認証: ${token ? 'OAuth アクセストークン' + (args.key ? ' + APIキー' : '') : 'APIキーのみ'}`);

  let video = args.video;
  if (!video && args.channel) {
    console.log('\n[1/3] 配信中の動画を探す (search.list = 100 units)');
    const s = await call('search', { part: 'id', channelId: args.channel, eventType: 'live', type: 'video', maxResults: 1 }, token);
    if (!s.ok) die(`search.list 失敗 ${s.status} ${s.reason} — ${s.error}`);
    video = (((s.json.items || [])[0] || {}).id || {}).videoId;
    if (!video) die('このチャンネルで配信中の動画が見つからない (配信を開始してから実行する)');
    console.log(`      → ${video}`);
  }
  if (!video) die('--video か --channel が要る');

  console.log('[2/3] activeLiveChatId を取る (videos.list = 1 unit)');
  const v = await call('videos', { part: 'liveStreamingDetails', id: video }, token);
  if (!v.ok) die(`videos.list 失敗 ${v.status} ${v.reason} — ${v.error}`);
  const det = (((v.json.items || [])[0] || {}).liveStreamingDetails) || {};
  if (!det.activeLiveChatId) die('activeLiveChatId が無い。配信中でないか、チャットが無効か、動画IDが違う');
  console.log(`      → ${det.activeLiveChatId.slice(0, 20)}…`);

  console.log('[3/3] チャットを読む (liveChatMessages.list = 5 units)');
  const c = await call('liveChat/messages', { liveChatId: det.activeLiveChatId, part: 'snippet,authorDetails', maxResults: 25 }, token);
  if (!c.ok) {
    console.log(`\n✗ 読めなかった: ${c.status} ${c.reason} — ${c.error}`);
    if (!token && /forbidden|insufficient|unauthorized|login/i.test(c.reason + c.error)) {
      console.log('\n→ **APIキーだけでは足りない**。OAuth が要る:');
      console.log('   node tools/yt-chat-setup.js auth --client-id=xxx --client-secret=yyy');
    }
    // list が駄目でも stream なら通ることがあるので、そちらは見ておく
    await probeStream(det.activeLiveChatId, token);
    process.exit(1);
  }
  const items = c.json.items || [];
  console.log(`\n✓ 読めた。直近 ${items.length} 件:`);
  for (const m of items.slice(-5)) {
    const sn = m.snippet || {}, au = m.authorDetails || {};
    console.log(`   ${au.displayName}: ${sn.displayMessage}`);
  }
  console.log(`\n次のポーリング用トークン (nextPageToken) も取れている: ${c.json.nextPageToken ? 'あり' : 'なし'}`);
  console.log(`API が薦める間隔: ${c.json.pollingIntervalMillis || '(不明)'} ms`);

  await probeStream(det.activeLiveChatId, token);
  console.log('\nserver.js に渡す設定 (.env などに):');
  console.log('  YT_CHAT=1');
  if (args.key) console.log(`  YT_API_KEY=${mask(args.key)}   # ← 実際の値は自分で控える`);
  if (args.channel) console.log(`  YT_CHANNEL_ID=${args.channel}`);
  else console.log(`  YT_VIDEO_ID=${video}`);
  if (args.refresh) {
    console.log(`  YT_OAUTH_CLIENT_ID=${args['client-id']}`);
    console.log('  YT_OAUTH_CLIENT_SECRET=(いま渡した値)');
    console.log('  YT_OAUTH_REFRESH_TOKEN=(いま渡した値)');
  }
  console.log('  YT_CHAT_MODE=auto     # streamList(push) を試し、駄目ならポーリング');
  console.log('  YT_CHAT_POLL_SEC=45   # ポーリングに落ちた場合だけ効く (10,000 units/日の制限)\n');
}

// streamList (push 方式) が使えるか。使えれば遅延ほぼゼロ・ポーリング不要。
async function probeStream(liveChatId, token) {
  console.log('\n[4/4] streamList (push 方式) が使えるか');
  const su = new URL(`${API}/liveChat/messages/stream`);
  su.searchParams.set('liveChatId', liveChatId);
  su.searchParams.set('part', 'snippet,authorDetails');
  if (args.key) su.searchParams.set('key', args.key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const sr = await fetch(su, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ac.signal });
    if (!sr.ok) {
      const sj = await sr.json().catch(() => ({}));
      console.log(`      使えない (${sr.status} ${(sj.error && sj.error.message) || ''}) → ポーリングで動きます`);
    } else {
      const rd = sr.body.getReader();
      const first = await rd.read();
      console.log(`      ✓ 使える (最初のデータ ${first.value ? first.value.length : 0} bytes)`);
      console.log('        → server.js は自動でこちらを使います (YT_CHAT_MODE=auto)');
      try { await rd.cancel(); } catch (_) {}
    }
  } catch (e) {
    console.log(`      判定できず (${e.name === 'AbortError' ? '8秒待っても応答なし' : e.message}) → ポーリングで動きます`);
  } finally { clearTimeout(timer); }
}

// ── auth: TV/限定入力デバイス方式でリフレッシュトークンを取る ────────────────
async function auth() {
  const id = args['client-id'], secret = args['client-secret'];
  if (!id || !secret) die('--client-id と --client-secret が要る (種類は「テレビとリミット入力デバイス」)\n'
    + '  コマンドラインに置きたくなければ .env に入れておけば省略できる:\n'
    + '    YT_OAUTH_CLIENT_ID=... / YT_OAUTH_CLIENT_SECRET=...');

  const scope = args.reply ? SCOPE_WRITE : SCOPE_READ;
  console.log(`\nスコープ: ${scope}`
    + (args.reply ? '  (読み取り + チャットへの投稿)' : '  (読み取りのみ。返信するなら --reply を付け直す)'));
  const r = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, scope }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = d.error_description || d.error || r.status;
    // 「テレビとリミット入力デバイス」以外のクライアント (デスクトップアプリ /
    // ウェブアプリケーション) は device フローを使えない。作り直さなくても、
    // ループバック方式なら同じクライアントでトークンを取れる。
    const invalidType = /invalid.?client.?type/i.test(String(why));
    die(`device/code 失敗: ${why}\n`
      + (invalidType
        ? '  このクライアントは「テレビとリミット入力デバイス」型ではありません。\n'
        + '  → **--local を付けて実行し直す**とループバック方式で取れます (種類を変えなくてよい):\n'
        + `      node tools/yt-chat-setup.js auth --local${args.reply ? ' --reply' : ''}\n`
        + '    ブラウザのある端末で実行すること (取れたトークンは別のサーバに持って行けます)。'
        : '  (OAuth クライアントの種類が「テレビとリミット入力デバイス」か確認)'));
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  1. ブラウザで開く: ${d.verification_url}`);
  console.log(`  2. このコードを入力: ${d.user_code}`);
  console.log(`  3. 配信しているチャンネルの Google アカウントで許可する`);
  console.log('────────────────────────────────────────');
  console.log(`\n許可されるまで ${d.interval || 5} 秒ごとに確認します (期限 ${Math.round((d.expires_in || 1800) / 60)}分)…`);

  const started = Date.now();
  for (;;) {
    await new Promise(s => setTimeout(s, (d.interval || 5) * 1000));
    if (Date.now() - started > (d.expires_in || 1800) * 1000) die('時間切れ。もう一度実行する');
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret,
        device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    const j = await t.json().catch(() => ({}));
    if (j.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (j.error === 'slow_down') { await new Promise(s => setTimeout(s, 5000)); continue; }
    if (j.error) die(`認可に失敗: ${j.error_description || j.error}`);
    console.log('\n\n✓ 取得できました。**この値は秘密**なので .env に入れて共有しないこと:\n');
    console.log(`  YT_OAUTH_CLIENT_ID=${id}`);
    console.log('  YT_OAUTH_CLIENT_SECRET=(いま渡した値)');
    console.log(`  YT_OAUTH_REFRESH_TOKEN=${j.refresh_token}`);   // ここだけは実値 (取得の唯一の機会のため)
    if (args.reply) console.log('\n  → 返信も使えるスコープです。サーバ側は YT_CHAT_REPLY=dry で文面を確認してから =1 に。');
    else console.log('\n  → 読み取り専用です。チャットに返信させるなら --reply を付けて取り直すこと。');
    console.log('\n確認:');
    console.log(`  node tools/yt-chat-setup.js check --video=VIDEO_ID \\`);
    console.log(`       --client-id=${id} --client-secret=… --refresh=…\n`);
    return;
  }
}

// ── auth --local: ループバック方式 (デスクトップアプリ型のクライアント向け) ──
//   device フローは「テレビとリミット入力デバイス」型でしか使えない。ふつうに作られる
//   「デスクトップアプリ」型では Invalid client type で弾かれる。そちらはこの方式で取る。
//   127.0.0.1 の一時サーバで認可コードを受けるので、**ブラウザのある端末**で動かすこと。
//   取れたリフレッシュトークンは端末に紐づかないので、本番サーバの .env に写して使える。
// 同意URLと、後で使う値をまとめて作る (--local と --paste で共通)
function buildAuthUrl() {
  const id = args['client-id'], secret = args['client-secret'];
  if (!id || !secret) die('--client-id と --client-secret が要る (.env の YT_OAUTH_CLIENT_ID / _SECRET でもよい)');
  const crypto = require('crypto');
  const scope = args.reply ? SCOPE_WRITE : SCOPE_READ;
  const port = Number(args.port) || 8788;
  const redirect = `http://127.0.0.1:${port}`;
  const state = crypto.randomBytes(16).toString('hex');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('access_type', 'offline');   // リフレッシュトークンをもらう
  u.searchParams.set('prompt', 'consent');        // 2回目以降も確実にもらう
  u.searchParams.set('state', state);
  console.log(`\nスコープ: ${scope}`
    + (args.reply ? '  (読み取り + チャットへの投稿)' : '  (読み取りのみ。返信するなら --reply)'));
  return { id, secret, redirect, state, url: u, port };
}

// 認可コードをリフレッシュトークンに交換して表示する (--local と --paste で共通)
async function exchangeAndPrint(code, id, secret, redirect) {
  const t = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret,
      redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await t.json().catch(() => ({}));
  if (!j.refresh_token) die(`トークンの交換に失敗: ${j.error_description || j.error || t.status}`
    + (/invalid_grant/i.test(String(j.error)) ? '\n  (code は1回きり・数分で切れます。取り直してください)' : ''));
  console.log('\n✓ 取得できました。**この値は秘密**なので .env に入れて共有しないこと:\n');
  console.log(`  YT_OAUTH_CLIENT_ID=${id}`);
  console.log('  YT_OAUTH_CLIENT_SECRET=(いま渡した値)');
  console.log(`  YT_OAUTH_REFRESH_TOKEN=${j.refresh_token}`);
  if (args.reply) console.log('\n  → 返信も使えるスコープです。サーバ側は YT_CHAT_REPLY=dry で文面を確認してから =1 に。');
  else console.log('\n  → 読み取り専用です。チャットに返信させるなら --reply を付けて取り直すこと。');
  console.log('\n  (本番が別のサーバなら、この3つをそちらの .env に写せばそのまま使えます)\n');
}

// ── auth --paste: ブラウザの無いサーバ (VPS) 向け ────────────────────────────
//   --local は 127.0.0.1 に戻ってくるのを待つので、**そのマシンにブラウザが要る**。
//   VPS では開けない。ただし戻り先の URL には認可コードがそのまま入っているので、
//   手元の PC のブラウザで許可 → 「接続できません」になった URL を丸ごと貼れば済む。
//   (Google は 2022 年に手入力用の OOB を廃止したので、この形が現実的な代替)
async function authPaste() {
  const { id, secret, redirect, state, url } = buildAuthUrl();
  console.log('────────────────────────────────────────');
  console.log('  1. **手元のPCの**ブラウザで、このURLを開く:\n');
  console.log(`     ${url}\n`);
  console.log('  2. 配信しているチャンネルの Google アカウントで許可する');
  console.log(`  3. 許可すると ${redirect}/?code=… に飛ばされ、`);
  console.log('     「このサイトにアクセスできません」になります。**それで正常です**。');
  console.log('  4. そのときの **アドレスバーの URL を丸ごとコピー** して下に貼り付ける');
  console.log('────────────────────────────────────────\n');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const line = await new Promise(r => rl.question('飛ばされた URL (または code の値) を貼り付けて Enter: ', a => { rl.close(); r(a); }));

  let code = String(line || '').trim();
  // URL の形 (または key=value の並び) なら必ず分解する。
  //   ★ 以前は 'code=' を含むときだけ分解していたので、code の無い URL
  //     (?state=… だけ) を貼ると **URL 全体を認可コードとして送って**しまい、
  //     「OAuth client was not found」という無関係なエラーになっていた。
  if (/^https?:\/\//i.test(code) || /[?&]?(code|state|error|scope)=/.test(code)) {
    const q = new URL(code.startsWith('http') ? code : `http://127.0.0.1/?${code.replace(/^\?/, '')}`).searchParams;
    if (q.get('error')) die(`許可されませんでした: ${q.get('error')}`);
    if (q.get('state') && q.get('state') !== state)
      die('state が一致しません。このスクリプトが出した URL を開いたか確認してください');
    code = q.get('code') || '';
  }
  if (!code) die('URL に code が入っていません。?code=… の付いた URL を貼り付けてください');
  await exchangeAndPrint(code, id, secret, redirect);
}

async function authLocal() {
  const { id, secret, redirect, state, url: u, port } = buildAuthUrl();
  const http = require('http');
  console.log('────────────────────────────────────────');
  console.log('  1. このURLを **このマシンの** ブラウザで開く:\n');
  console.log(`     ${u}\n`);
  console.log(`  2. 配信しているチャンネルの Google アカウントで許可する`);
  console.log(`  3. 許可すると ${redirect} に戻ってくる (このスクリプトが受け取ります)`);
  console.log('────────────────────────────────────────');
  console.log('\n  ※ ここでブラウザを開けないマシン (VPS など) では待っても戻ってきません。');
  console.log('     その場合は Ctrl+C で止めて --paste を使ってください。');
  console.log('\n待っています… (Ctrl+C で中止)');

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      const done = (msg) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
                              res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:2em">${msg}</body>`); };
      if (q.get('error')) { done('✗ 拒否されました。ターミナルに戻ってください。');
                            srv.close(); return reject(new Error(`認可を拒否: ${q.get('error')}`)); }
      if (!q.get('code')) { done('...'); return; }
      if (q.get('state') !== state) { done('✗ state が一致しません。もう一度実行してください。');
                                      srv.close(); return reject(new Error('state 不一致 (取り違え防止)')); }
      done('✓ 受け取りました。ターミナルに戻ってください。このタブは閉じて構いません。');
      srv.close(); resolve(q.get('code'));
    });
    srv.on('error', e => reject(new Error(`127.0.0.1:${port} を開けません: ${e.message} (--port=別の番号 で変えられます)`)));
    srv.listen(port, '127.0.0.1');     // 外からは繋がらない
  });

  await exchangeAndPrint(code, id, secret, redirect);
}

// ── find: いま配信中の動画IDを探す ─────────────────────────────────────────
//   server.js の ytcFindLiveVideo と同じ手順。search.list (100 units) を避けて
//   アップロード一覧をたどる (合計 3 units)。見つからないときだけ search に落とす。
async function find() {
  if (!args.key && !args.refresh) die('--key か (--client-id --client-secret --refresh) のどちらかが要る');
  const token = await accessTokenFromRefresh();
  let channel = args.channel || '';

  if (!channel) {
    if (!args.video) die('--channel か --video のどちらかが要る');
    const v = await call('videos', { part: 'snippet', id: args.video }, token);
    if (!v.ok) die(`videos.list に失敗: ${v.status} ${v.reason} ${v.error}`);
    channel = (((v.json.items || [])[0] || {}).snippet || {}).channelId || '';
    if (!channel) die(`動画 ${args.video} からチャンネルIDを引けなかった`);
    console.log(`  チャンネルID: ${channel}  (動画 ${args.video} から取得 / 1 unit)`);
  }

  const c = await call('channels', { part: 'contentDetails', id: channel }, token);
  if (!c.ok) die(`channels.list に失敗: ${c.status} ${c.reason} ${c.error}`);
  const up = ((((c.json.items || [])[0] || {}).contentDetails || {}).relatedPlaylists || {}).uploads;
  if (!up) die(`チャンネル ${channel} のアップロード一覧が取れない`);

  const pl = await call('playlistItems', { part: 'contentDetails', playlistId: up, maxResults: 5 }, token);
  if (!pl.ok) die(`playlistItems.list に失敗: ${pl.status} ${pl.reason} ${pl.error}`);
  const ids = (pl.json.items || []).map(it => (it.contentDetails || {}).videoId).filter(Boolean);
  console.log(`  直近の動画: ${ids.join(', ') || '(なし)'}`);

  let live = null;
  if (ids.length) {
    const v = await call('videos', { part: 'liveStreamingDetails', id: ids.join(',') }, token);
    if (!v.ok) die(`videos.list に失敗: ${v.status} ${v.reason} ${v.error}`);
    live = (v.json.items || []).find(it => (it.liveStreamingDetails || {}).activeLiveChatId) || null;
  }

  if (!live) {
    console.log('  アップロード一覧に配信中のものが無い → search.list を試す (100 units)');
    const sr = await call('search', { part: 'id', channelId: channel, eventType: 'live', type: 'video', maxResults: 1 }, token);
    if (!sr.ok) die(`search.list に失敗: ${sr.status} ${sr.reason} ${sr.error}`);
    const id = (((sr.json.items || [])[0] || {}).id || {}).videoId;
    if (!id) die('配信中の動画が見つからない (いま配信していない可能性)');
    const v = await call('videos', { part: 'liveStreamingDetails', id }, token);
    live = (v.json.items || [])[0] || null;
    if (!live || !(live.liveStreamingDetails || {}).activeLiveChatId)
      die(`動画 ${id} は見つかったが activeLiveChatId が無い`);
  }

  console.log('\n✓ 配信中の動画が見つかりました:\n');
  console.log(`  YT_VIDEO_ID=${live.id}`);
  console.log(`  YT_CHANNEL_ID=${channel}`);
  console.log(`  liveChatId: ${mask(live.liveStreamingDetails.activeLiveChatId)}`);
  console.log(`  https://www.youtube.com/watch?v=${live.id}`);
  console.log('\n  ※ サーバ側は YT_AUTO_FIND (既定で有効) が同じことを自動でやるので、');
  console.log('     .env を書き換えなくても次の配信に追従します。');
  console.log('     いますぐ探し直させたいときは: curl "http://localhost:8080/yt?refind=1"\n');
}

(async () => {
  if (cmd === 'auth') await (args.paste ? authPaste() : args.local ? authLocal() : auth());
  else if (cmd === 'find') await find();
  else await check();
})().catch(e => die(e.message));
