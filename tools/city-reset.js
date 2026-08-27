#!/usr/bin/env node
/**
 * 街を Day 1 から作り直す (依存パッケージなし / Node 18+)
 *
 *   node tools/city-reset.js              稼働中のサーバに SIGUSR2 を送って作り直す
 *   node tools/city-reset.js --newmap     地形も引き直す (サーバ稼働中でも可)
 *   node tools/city-reset.js --file       サーバを止めている前提で保存ファイルを退避する
 *   node tools/city-reset.js --status     いまの街の状態を見るだけ (何も変えない)
 *
 * 外にポートを開けていなくても使えるように、HTTP ではなく
 * **シグナル**と**ファイル操作**の2通りを用意してある。
 *   ・稼働中     → pid を見つけて SIGUSR2。サーバが自分でリセットして保存し直す。
 *   ・停止中     → data/city_state.json を退避するだけ。次の起動で新しい街が生まれる。
 *
 * pid は data/server.pid から読む (サーバが起動時に書く)。
 * 見つからなければ --pid=1234 で直接指定できる。
 *
 * 【消える前に必ず退避する】どちらの経路でも、実行前に
 * data/city_state.<日時>.bak へコピーを取る。戻したいときは名前を戻すだけ。
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  if (m) args[m[1]] = m[2] || true;
}

const STATE = process.env.CITY_STATE_FILE || path.join(ROOT, 'data', 'city_state.json');
const PIDF  = process.env.PID_FILE        || path.join(ROOT, 'data', 'server.pid');

const die = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const ok  = m => console.log(`✓ ${m}`);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { return null; }
}

function showStatus() {
  const j = readState();
  if (!j) { console.log(`保存ファイルなし (${STATE})`); return; }
  const open = (j.structs || []).filter(s => s.state === 'open').length;
  const ago  = j.savedAt ? Math.round((Date.now() - j.savedAt) / 60000) : null;
  console.log(`  保存ファイル : ${STATE}`);
  console.log(`  Day          : ${(j.day || 0) + 1}`);
  console.log(`  人口         : ${j.pop || 0}`);
  console.log(`  建物         : ${open} 軒 (全 ${(j.structs || []).length})`);
  console.log(`  フィールド   : ${j.size || '?'} / grid ${j.grid || '?'}`);
  console.log(`  最終保存     : ${ago == null ? '?' : ago + ' 分前'}`);
  if (j.stats) console.log(`  累計         : 道${j.stats.roadsBorn || 0} 開業${j.stats.shopsOpened || 0}`
    + ` 閉店${j.stats.shopsClosed || 0} 友人${j.stats.friendships || 0} 犯罪${j.stats.crimes || 0}`);
}

// 消える前に必ず退避する
function backup() {
  if (!fs.existsSync(STATE)) return null;
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const dst = STATE.replace(/\.json$/, '') + `.${t}.bak`;
  fs.copyFileSync(STATE, dst);
  ok(`退避しました: ${path.basename(dst)}`);
  return dst;
}

function findPid() {
  if (args.pid) return parseInt(args.pid, 10);
  try {
    const pid = parseInt(fs.readFileSync(PIDF, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) return pid;
  } catch (e) { /* 無ければ下で null */ }
  return null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

(function main() {
  if (args.status) { showStatus(); return; }

  console.log('\nいまの街:');
  showStatus();
  console.log('');

  // ── サーバを止めている前提: 保存ファイルを退避するだけ ──
  if (args.file) {
    if (!fs.existsSync(STATE)) { ok('保存ファイルはもともとありません。次の起動で新しい街になります'); return; }
    backup();
    fs.unlinkSync(STATE);
    ok('保存ファイルを外しました。サーバを起動すると Day 1 から始まります');
    console.log('  ※ サーバが動いたままだと、次の自動保存で今の街が書き戻されます。');
    console.log('    その場合は先に止めてから実行してください。\n');
    return;
  }

  // ── 稼働中: シグナルで作り直させる ──
  const pid = findPid();
  if (pid == null)
    die(`pid が分かりません (${PIDF} が無い)。\n`
      + `  サーバが動いているなら --pid=1234 で指定するか、\n`
      + `  止まっているなら --file で保存ファイルを外してください。`);
  if (!alive(pid))
    die(`pid ${pid} のプロセスが見つかりません。\n`
      + `  止まっているなら --file を使ってください。`);

  backup();
  const sig = 'SIGUSR2';
  if (args.newmap) {
    console.log('  ※ --newmap は RESET_NEWMAP=1 で起動しているサーバにだけ効きます。');
    console.log('    地形も確実に引き直すなら --file で保存を外して再起動するのが確実です。');
  }
  try { process.kill(pid, sig); }
  catch (e) { die(`シグナルを送れませんでした: ${e.message}`); }
  ok(`pid ${pid} に ${sig} を送りました`);
  console.log('  サーバのログに「街を Day 1 から作り直します」が出れば成功です。\n');
})();
