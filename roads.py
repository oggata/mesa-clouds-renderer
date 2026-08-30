# roads.py — roads.js の Python ミラー。
#
# ── なぜ 2 つあるか ──
# 学習 (このリポジトリの build_pro_onnx_by_persona.ipynb) は Python、本番
# (server.js) は JavaScript で動く。観測に床を入れると、**同じ判定を両方が
# 持つ**ことになる。world.js / world.py が既に同じ関係にあり、その二重実装で
# 「道路削除率が学習 0.25〜0.50 / 本番 0.30〜0.55」というズレが実際に起きた。
# マップはデータとして渡せるので golden vector で検出できなかった、というのが
# world.js 冒頭の反省。今回は最初から突き合わせられるようにする:
#
#     node tools/make-road-golden.js     # roads.js の答えを書き出す
#     python3 tools/check-roads-py.py    # この実装と 1 件ずつ照合する
#
# **roads.js を変えたら、ここも直してゴールデンを焼き直すこと。**
#
# 依存は標準ライブラリだけ。numpy/torch は学習側のベクトル化で使うが、
# 判定そのものはスカラーで書いてある (照合しやすさを優先)。

import math

# ── 道路クラス ──────────────────────────────────────────────────────────────
PATH, ONEWAY, TWOLANE = 0, 1, 2

# ── アトラスの枠割り ────────────────────────────────────────────────────────
TILE = 128
GUT = 8
CONTENT = TILE - GUT * 2
COLS = ROWS = 8
ATLAS = TILE * COLS
SLOT_BASE = {TWOLANE: 0, ONEWAY: 16, PATH: 32}
SLOT_USED = 33

D4 = ((-1, 0), (1, 0), (0, -1), (0, 1))


def road_mask(grid, r, c, road_val):
    """mask = N|E<<1|S<<2|W<<3。grid は [row][col] で添字できるもの。"""
    n = len(grid)
    def R(rr, cc):
        return 0 <= rr < n and 0 <= cc < n and grid[rr][cc] == road_val
    return ((1 if R(r - 1, c) else 0) | (2 if R(r, c + 1) else 0)
            | (4 if R(r + 1, c) else 0) | (8 if R(r, c - 1) else 0))


def mask_degree(m):
    return (1 if m & 1 else 0) + (1 if m & 2 else 0) + (1 if m & 4 else 0) + (1 if m & 8 else 0)


def atlas_slot(cls, mask):
    return SLOT_BASE[PATH] if cls == PATH else SLOT_BASE[cls] + mask


# ── クラス分け ──────────────────────────────────────────────────────────────
CLASS_HI, CLASS_LO = 2.0, 0.25
PATH_MAX_DEGREE = 2


def classify_roads(grid, road_use, prev, road_val):
    """roads.js classifyRoads と同じ。road_use は長さ n*n の列。戻り値も同じ形。"""
    n = len(grid)
    out = [0] * (n * n)
    u = [road_use[r * n + c] for r in range(n) for c in range(n) if grid[r][c] == road_val]
    if not u:
        return out
    u.sort()
    med = u[len(u) >> 1]

    want = [0] * (n * n)
    for r in range(n):
        for c in range(n):
            i = r * n + c
            if grid[r][c] != road_val:
                continue
            deg = mask_degree(road_mask(grid, r, c, road_val))
            if deg <= 1:
                want[i] = PATH; continue
            if med <= 0:
                want[i] = ONEWAY; continue
            v = road_use[i]
            if v >= med * CLASS_HI:
                want[i] = TWOLANE; continue
            want[i] = PATH if (v < med * CLASS_LO and deg <= PATH_MAX_DEGREE) else ONEWAY

    smooth = [0] * (n * n)
    for r in range(n):
        for c in range(n):
            i = r * n + c
            if grid[r][c] != road_val:
                continue
            vs = [want[i]]
            for dr, dc in D4:
                nr, nc = r + dr, c + dc
                if 0 <= nr < n and 0 <= nc < n and grid[nr][nc] == road_val:
                    vs.append(want[nr * n + nc])
            vs.sort()
            smooth[i] = vs[len(vs) >> 1]
            if smooth[i] == PATH and mask_degree(road_mask(grid, r, c, road_val)) > PATH_MAX_DEGREE:
                smooth[i] = ONEWAY

    for i in range(len(out)):
        if not prev or len(prev) != len(out):
            out[i] = smooth[i]; continue
        p, s = prev[i], smooth[i]
        out[i] = min(s, p + 1) if s > p else (max(s, p - 1) if s < p else s)
    return out


# ════════════════════════════════════════════════════════════════════════════
# 道路の断面 (roads.js の同名関数と同じ式)
# ════════════════════════════════════════════════════════════════════════════
RW2 = 0.33          # 二車線: 車道の半幅
RW1 = 0.24          # 一通
RIN_K = 0.85        # 曲がり角の内側の縁石の半径 = RIN_K * 歩道幅


def r_in(rw):
    return RIN_K * (0.5 - rw)


XW_A, XW_B = 0.012, 0.012        # 横断歩道の帯の前後マージン
XW_PITCH, XW_DUTY = 0.116, 0.52  # 縞の周期 (0.9m) と duty


def sd_box(px, py, x0, y0, x1, y1):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2, (y1 - y0) / 2
    dx, dy = abs(px - cx) - hx, abs(py - cy) - hy
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0)


def _quadrants(lo, hi):
    # (a, b, box, pu, pv, su, sv)。roads.js quadrants と同じ並び。
    return (
        (0, 1, (hi, 0.0, 1.0, lo), hi, lo, +1, -1),
        (1, 2, (hi, hi, 1.0, 1.0), hi, hi, +1, +1),
        (2, 3, (0.0, hi, lo, 1.0), lo, hi, -1, +1),
        (3, 0, (0.0, 0.0, lo, lo), lo, lo, -1, -1),
    )


def sd_rounded_quad(a, b, r):
    ax, bx = max(a + r, 0), max(b + r, 0)
    return math.hypot(ax, bx) + min(max(a + r, b + r), 0) - r


def corner_center(mask, rw):
    lo, hi, r = 0.5 - rw, 0.5 + rw, r_in(rw)
    return ((hi + r) if (mask & 2) else (lo - r),
            (hi + r) if (mask & 4) else (lo - r))


def corner_sdf(u, v, mask, rw):
    cu, cv = corner_center(mask, rw)
    r = r_in(rw)
    d = math.hypot(u - cu, v - cv)
    return max(d - (2 * rw + r), r - d)


def road_sdf(u, v, mask, rw):
    """負 = 車道の内側。roads.js roadSDF と同じ (歩道領域の補集合の交わり)。"""
    lo, hi = 0.5 - rw, 0.5 + rw
    n = mask_degree(mask)
    if n == 0:
        return 1e9
    if n == 2 and mask != 5 and mask != 10:
        return corner_sdf(u, v, mask, rw)
    r = r_in(rw)
    d = sd_box(u, v,
               -0.5 if (mask & 8) else lo, -0.5 if (mask & 1) else lo,
               1.5 if (mask & 2) else hi, 1.5 if (mask & 4) else hi)
    for (qa, qb, _box, _pu, _pv, su, sv) in _quadrants(lo, hi):
        if not ((mask & (1 << qa)) and (mask & (1 << qb))):
            continue
        a = (hi - u) if su > 0 else (u - lo)
        b = (hi - v) if sv > 0 else (v - lo)
        d = max(d, -sd_rounded_quad(a, b, r))
    return d


def crosswalk(u, v, mask, rw):
    """縞は進行方向に沿って伸び、道幅の方向に繰り返す (日本の横断歩道)。"""
    lo, hi = 0.5 - rw, 0.5 + rw
    w_road = hi - lo
    n = max(4, round(w_road / XW_PITCH))
    p = w_road / n
    for bit, s, w in ((1, v, u), (2, 1 - u, v), (4, 1 - v, u), (8, u, v)):
        if not (mask & bit):
            continue
        if w < lo or w > hi:
            continue
        if s < XW_A or s > lo - XW_B:
            continue
        if (((w - lo) / p) % 1) * p < p * XW_DUTY:
            return True
    return False


# ── 足元に何があるか ────────────────────────────────────────────────────────
class GROUND:
    GRASS, DIRT, PAVE, SIDEWALK, CROSSWALK, ROADWAY = 0, 1, 2, 3, 4, 5


WALK_PREF = {GROUND.SIDEWALK: 1.00, GROUND.CROSSWALK: 1.00, GROUND.PAVE: 0.85,
             GROUND.DIRT: 0.55, GROUND.GRASS: 0.50, GROUND.ROADWAY: 0.00}


def ground_kind(cell_type, cls, mask, fu, fv, V=None):
    """fu = +列(東), fv = +行(南)。V は OTHER/ROAD/BUILDING/TREE の値。"""
    T = V or {'OTHER': 0, 'ROAD': 1, 'BUILDING': 2, 'TREE': 3}
    if cell_type == T['BUILDING']:
        return GROUND.PAVE
    if cell_type == T['TREE']:
        return GROUND.GRASS
    if cell_type != T['ROAD']:
        return GROUND.DIRT
    if cls == PATH:
        return GROUND.SIDEWALK
    rw = RW2 if cls >= TWOLANE else RW1
    if road_sdf(fu, fv, mask, rw) >= 0:
        return GROUND.SIDEWALK
    if mask_degree(mask) >= 3 and crosswalk(fu, fv, mask, rw):
        return GROUND.CROSSWALK
    return GROUND.ROADWAY


def sidewalk_offset(cls):
    """セルの中で歩行者が居たい横位置 (中心からのずれ、セル比)。"""
    if cls == PATH:
        return 0.0
    rw = RW2 if cls >= TWOLANE else RW1
    return rw + (0.5 - rw) * 0.5


# ── 観測に映る地面 ──────────────────────────────────────────────────────────
FLOOR_RGB = {
    'ASPHALT': (0.265, 0.275, 0.295),
    'GRASS':   (0.355, 0.485, 0.275),
    'DIRT':    (0.545, 0.530, 0.420),
    'VOID':    (0.095, 0.105, 0.120),
}
FLOOR_MAX = 40
FLOOR_EYE = 0.5
RC_FW = 24


def floor_dist(y, h):
    """画面の行 y が指す地面までの垂直距離。壁の足元の投影を解いたもの。"""
    p = y - h / 2
    return float('inf') if p <= 0 else (h * FLOOR_EYE) / p


def bake_floor_bank(rgba, width):
    """アトラスの RGBA を観測用に縮小し、透明部をアスファルトに合成する。
       戻り値は長さ COLS*ROWS*RC_FW*RC_FW*3 の list。roads.js と同じ規則。"""
    if width != ATLAS:
        raise ValueError('bake_floor_bank: アトラスの幅が %d (期待 %d)' % (width, ATLAS))
    asp = FLOOR_RGB['ASPHALT']
    n_slot = COLS * ROWS
    out = [0.0] * (n_slot * RC_FW * RC_FW * 3)
    for s in range(n_slot):
        ox = (s % COLS) * TILE + GUT
        oy = (s // COLS) * TILE + GUT
        for j in range(RC_FW):
            y0 = (j * CONTENT) // RC_FW
            y1 = max(y0 + 1, ((j + 1) * CONTENT) // RC_FW)
            for i in range(RC_FW):
                x0 = (i * CONTENT) // RC_FW
                x1 = max(x0 + 1, ((i + 1) * CONTENT) // RC_FW)
                r = g = b = 0.0
                n = 0
                for y in range(y0, y1):
                    base = ((oy + y) * ATLAS + ox) * 4
                    for x in range(x0, x1):
                        o = base + x * 4
                        a = rgba[o + 3] / 255
                        r += (rgba[o] / 255) * a + asp[0] * (1 - a)
                        g += (rgba[o + 1] / 255) * a + asp[1] * (1 - a)
                        b += (rgba[o + 2] / 255) * a + asp[2] * (1 - a)
                        n += 1
                k = (s * RC_FW * RC_FW + j * RC_FW + i) * 3
                out[k] = r / n; out[k + 1] = g / n; out[k + 2] = b / n
    return out
