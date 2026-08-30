#!/usr/bin/env python3
# check-roads-py.py — roads.py が roads.js と同じ答えを返すか照合する。
#
#   node tools/make-road-golden.js     # 先に JS 側の答えを焼く
#   python3 tools/check-roads-py.py
#
# 観測に床を入れると、同じ判定を学習 (Python) と本番 (JS) の両方が持つ。
# world.js / world.py で「道路削除率が学習と本番でズレていたのに、マップを
# データとして渡していたので golden vector で検出できなかった」という失敗が
# 実際に起きている。今回は判定そのものを突き合わせる。

import json, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import roads as R

HERE = os.path.dirname(__file__)
GOLD = os.path.join(HERE, '..', 'data', 'road_golden.json')
if not os.path.exists(GOLD):
    print('先に node tools/make-road-golden.js を実行してください'); sys.exit(1)
G = json.load(open(GOLD))
OTHER, ROAD, BUILDING, TREE = 0, 1, 2, 3
V = {'OTHER': OTHER, 'ROAD': ROAD, 'BUILDING': BUILDING, 'TREE': TREE}
fails = []


def check(name, ok, detail=''):
    print('  %-22s %s%s' % (name, 'OK' if ok else 'NG', ('  ' + detail) if detail else ''))
    if not ok:
        fails.append(name)


# ── 1) 定数 ────────────────────────────────────────────────────────────────
cs = G['consts']
consts_ok = all([
    abs(R.RW2 - cs['RW2']) < 1e-12, abs(R.RW1 - cs['RW1']) < 1e-12,
    abs(R.RIN_K - cs['RIN_K']) < 1e-12, abs(R.XW_PITCH - cs['XW_PITCH']) < 1e-12,
    abs(R.XW_DUTY - cs['XW_DUTY']) < 1e-12, abs(R.XW_A - cs['XW_A']) < 1e-12,
    abs(R.CLASS_HI - cs['CLASS_HI']) < 1e-12, abs(R.CLASS_LO - cs['CLASS_LO']) < 1e-12,
    R.PATH_MAX_DEGREE == cs['PATH_MAX_DEGREE'], R.TILE == cs['TILE'], R.GUT == cs['GUT'],
    R.ATLAS == cs['ATLAS'], R.RC_FW == cs['RC_FW'],
    abs(R.FLOOR_EYE - cs['FLOOR_EYE']) < 1e-12, R.FLOOR_MAX == cs['FLOOR_MAX'],
])
check('定数', consts_ok)

# ── 2) 近傍マスクとアトラスの枠 ────────────────────────────────────────────
n = G['grid']
grid = [[int(ch) for ch in row] for row in G['map']]
bad_mask = bad_slot = 0
for r in range(n):
    for c in range(n):
        i = r * n + c
        if grid[r][c] != ROAD:
            continue
        if R.road_mask(grid, r, c, ROAD) != G['mask'][i]:
            bad_mask += 1
        if R.atlas_slot(G['roadClass'][i], G['mask'][i]) != G['slot'][i]:
            bad_slot += 1
check('近傍マスク', bad_mask == 0, '不一致 %d' % bad_mask)
check('アトラスの枠', bad_slot == 0, '不一致 %d' % bad_slot)

# ── 3) クラス分け ──────────────────────────────────────────────────────────
cls = R.classify_roads(grid, G['roadUse'], None, ROAD)
bad_cls = sum(1 for i in range(n * n) if cls[i] != G['roadClass'][i])
check('道路クラス分け', bad_cls == 0, '不一致 %d / %d セル' % (bad_cls, n * n))

# ── 4) 足元の判定 ──────────────────────────────────────────────────────────
bad_gk = 0
first = None
for (c_, m, fu, fv, want) in G['groundKind']:
    got = R.ground_kind(ROAD, c_, m, fu, fv, V)
    if got != want:
        bad_gk += 1
        if first is None:
            first = 'cls=%d mask=%d (%.4f,%.4f) py=%d js=%d' % (c_, m, fu, fv, got, want)
check('足元の判定', bad_gk == 0, '不一致 %d / %d 件%s'
      % (bad_gk, len(G['groundKind']), ('  例: ' + first) if first else ''))

# ── 5) 床までの距離 ────────────────────────────────────────────────────────
worst = 0.0
for (y, h, want) in G['floorDist']:
    worst = max(worst, abs(R.floor_dist(y, h) - want))
check('床までの距離', worst < 1e-6, '最大差 %.2e' % worst)

# ── 6) 床テクスチャの焼き方 ────────────────────────────────────────────────
# PNG のデコードに外部パッケージを使いたくないので、アトラスがあるときだけ試す。
try:
    import zlib
    p = os.path.join(HERE, '..', 'textures', 'road', 'road_atlas.png')
    buf = open(p, 'rb').read()
    o, idat, w, h = 8, b'', 0, 0
    while o < len(buf):
        ln = int.from_bytes(buf[o:o+4], 'big'); ty = buf[o+4:o+8]
        if ty == b'IHDR':
            w = int.from_bytes(buf[o+8:o+12], 'big'); h = int.from_bytes(buf[o+12:o+16], 'big')
        if ty == b'IDAT':
            idat += buf[o+8:o+8+ln]
        o += 12 + ln
    raw = zlib.decompress(idat)
    rgba = bytearray(w * h * 4)
    for y in range(h):                       # フィルタ 0 固定 (この repo が書いた PNG)
        s = y * (w * 4 + 1)
        assert raw[s] == 0, 'フィルタ %d の PNG は読めません' % raw[s]
        rgba[y*w*4:(y+1)*w*4] = raw[s+1:s+1+w*4]
    bank = R.bake_floor_bank(rgba, w)
    s_sum = sum(bank)
    ok_len = len(bank) == G['floorBank']['len']
    ok_sum = abs(s_sum - G['floorBank']['sum']) < 0.05
    bad_sp = 0
    for (s_, i, j, wr, wg, wb) in G['floorBank']['samples']:
        k = (s_ * R.RC_FW * R.RC_FW + j * R.RC_FW + i) * 3
        if max(abs(bank[k]-wr), abs(bank[k+1]-wg), abs(bank[k+2]-wb)) > 1e-5:
            bad_sp += 1
    check('床テクスチャの焼き方', ok_len and ok_sum and bad_sp == 0,
          '長さ%s 合計差%.4f 抜き取り不一致%d' % ('OK' if ok_len else 'NG',
          abs(s_sum - G['floorBank']['sum']), bad_sp))
except Exception as e:
    check('床テクスチャの焼き方', False, '確認できず: %s' % e)

print()
if fails:
    print('NG: ' + ', '.join(fails)); sys.exit(1)
print('roads.py は roads.js と一致しています')
