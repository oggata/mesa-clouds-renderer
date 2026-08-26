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
 */
'use strict';

const API = process.env.YT_CHAT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  if (m) args[m[1]] = m[2] || true;
}
const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'check';
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
// 秘密情報は伏せて出す。端末のログやスクショから漏れるのを避けるため。
const mask = (v) => { const s = String(v || ''); return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`; };

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
  if (!id || !secret) die('--client-id と --client-secret が要る (種類は「テレビとリミット入力デバイス」)');

  const r = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, scope: SCOPE }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) die(`device/code 失敗: ${d.error_description || d.error || r.status}\n  (OAuth クライアントの種類が「テレビとリミット入力デバイス」か確認)`);

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
    console.log('\n確認:');
    console.log(`  node tools/yt-chat-setup.js check --video=VIDEO_ID \\`);
    console.log(`       --client-id=${id} --client-secret=… --refresh=…\n`);
    return;
  }
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
  if (cmd === 'auth') await auth();
  else if (cmd === 'find') await find();
  else await check();
})().catch(e => die(e.message));
