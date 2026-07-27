import numpy as np, json
OTHER,ROAD,BUILDING,TREE=0,1,2,3
def make_map(size, seed):
    s=seed & 0xffffffff
    def rng():
        nonlocal s
        s=(s*1664525+1013904223) & 0xffffffff
        return s/0xffffffff
    ri=lambda n: int(rng()*n)
    pick=lambda a: a[ri(len(a))]
    g=[[OTHER]*size for _ in range(size)]
    step=4; rows=list(range(0,size,step)); cols=list(range(0,size,step))
    for r in rows:
        for c in range(size): g[r][c]=ROAD
    for c in cols:
        for r in range(size): g[r][c]=ROAD
    for ri2 in range(len(rows)-1):
        for ci in range(len(cols)-1):
            r0,r1,c0,c1=rows[ri2]+1,rows[ri2+1],cols[ci]+1,cols[ci+1]
            cells=[(r,c) for r in range(r0,r1) for c in range(c0,c1)]
            if not cells: continue
            patch=None
            if r1-r0>=2 and c1-c0>=2 and rng()<0.42:
                pr=r0 if rng()<0.5 else r1-2
                pc=c0 if rng()<0.5 else c1-2
                for r in range(pr,pr+2):
                    for c in range(pc,pc+2): g[r][c]=BUILDING
                patch=(pr,pc)
            b=pick(cells); g[b[0]][b[1]]=BUILDING
            for (r,c) in cells:
                if r==b[0] and c==b[1]: continue
                if patch and patch[0]<=r<patch[0]+2 and patch[1]<=c<patch[1]+2: continue
                v=rng()
                if v<.25: g[r][c]=TREE
                elif v<.45: g[r][c]=BUILDING
    for r in rows:
        for c in range(size): g[r][c]=ROAD
    for c in cols:
        for r in range(size): g[r][c]=ROAD
    rowset,colset=set(rows),set(cols)
    isX=lambda r,c: (r in rowset) and (c in colset)
    cands=[(r,c) for r in range(size) for c in range(size) if g[r][c]==ROAD and not isX(r,c)]
    for i in range(len(cands)-1,0,-1):
        j=ri(i+1); cands[i],cands[j]=cands[j],cands[i]
    def road_ok(grid):
        sr=sc=-1
        for r in range(size):
            for c in range(size):
                if grid[r][c]==ROAD: sr,sc=r,c; break
            if sr>=0: break
        if sr<0: return True
        vis={sr*size+sc}; q=[(sr,sc)]
        while q:
            r,c=q.pop(0)
            for dr,dc in ((-1,0),(1,0),(0,-1),(0,1)):
                nr,nc=r+dr,c+dc
                if 0<=nr<size and 0<=nc<size:
                    k=nr*size+nc
                    if k not in vis and grid[nr][nc]==ROAD: vis.add(k); q.append((nr,nc))
        for r in range(size):
            for c in range(size):
                if grid[r][c]==ROAD and r*size+c not in vis: return False
        return True
    maxRm=int(len(cands)*(0.30+rng()*0.25)); rm=0
    for (r,c) in cands:
        if rm>=maxRm: break
        g[r][c]=OTHER
        if road_ok(g): g[r][c]=TREE if rng()<0.4 else OTHER; rm+=1
        else: g[r][c]=ROAD
    return g


# ─── 建物タイプ割当 (server.js buildScene と bit-identical。固定seed=42のrng) ───
#   FP1_IDX=1x1建物のタイプindex, FP2_IDX=2x2建物。BLDG_TYPES(server) と同順に用意すること。
FP1_IDX = list(range(0,15))    # footprint=1 の建物タイプ (server BLDG_TYPES の並びに一致)
FP2_IDX = list(range(15,25))   # footprint=2 の建物タイプ
def assign_building_types(m, GRID=30):
    """server.js buildScene の型割当を忠実移植。返り値: 30x30 (非建物=-1, 建物=type index)。"""
    BT={}; assigned=set(); s=42
    def rng():
        nonlocal s; s=(s*1664525+1013904223)&0xffffffff; return s/0xffffffff
    isB=lambda r,c: 0<=r<GRID and 0<=c<GRID and m[r][c]==BUILDING
    for r in range(GRID-1):
        for c in range(GRID-1):
            if f"{r}_{c}" in assigned: continue
            if isB(r,c) and isB(r+1,c) and isB(r,c+1) and isB(r+1,c+1) \
               and f"{r+1}_{c}" not in assigned and f"{r}_{c+1}" not in assigned and f"{r+1}_{c+1}" not in assigned:
                t=FP2_IDX[int(rng()*len(FP2_IDX))]
                for dr in range(2):
                    for dc in range(2):
                        assigned.add(f"{r+dr}_{c+dc}"); BT[f"{r+dr}_{c+dc}"]=t
    for r in range(GRID):
        for c in range(GRID):
            if m[r][c]!=BUILDING or f"{r}_{c}" in assigned: continue
            t=FP1_IDX[int(rng()*len(FP1_IDX))]
            assigned.add(f"{r}_{c}"); BT[f"{r}_{c}"]=t
    return [[BT.get(f"{r}_{c}",-1) for c in range(GRID)] for r in range(GRID)]
