# -*- coding: utf-8 -*-
"""
替换品牌 LOGO（2026-09-26）
用户提供了新 LOGO：黑底，蓝色 K 形图标 + 深灰「跨多多科技」文字。

三件事：
1. 把 K 图标从黑底里抠出来（去黑底 → 透明），出方形 logo-mark.png —— 界面里用的全是它
2. 整版横 logo 也顺手透明化，替换 logo.png 备用
3. 生成 build/icon.ico + build/icon.png —— Electron 窗口图标和打包图标现在还没有

关键算法：黑底图去底不能用「接近黑就设 alpha=0」的硬阈值 —— 抗锯齿边缘会出白边。
用黑底合成公式反推：观察到的颜色 = 前景色 * alpha，所以 alpha = max(r,g,b)，
前景色 = 原色 * 255 / alpha。这样边缘像素自然平滑，蓝色 (59,130,246) 反推后仍是蓝的。

文字是深灰（约 60,60,60），透明化后在亮色界面上会几乎看不见 —— 但检查过引用，
界面里用的全是 logo-mark（K 图标），文字在 HTML 里另画，所以不受影响。
"""
from PIL import Image
import os

SRC = r"C:\Users\Administrator\Desktop\Codex 图像 2026年9月26日 00_15_02.png"
OUT_BRAND = r"C:\Users\Administrator\WorkBuddy\2026-09-08-19-23-01\ai-canvas\public\brand"
OUT_BUILD = r"C:\Users\Administrator\WorkBuddy\2026-09-08-19-23-01\ai-canvas\build"

img = Image.open(SRC).convert("RGBA")
w, h = img.size
print(f"原图 {w}x{h}")

px = img.load()

# ---- 1. 定位 K 图标：蓝色像素的 bbox（文字是灰色，r≈g≈b，不会混进来） ----
# 注意：文字的抗锯齿边缘会冒出零星几个"偏蓝"像素（每列 1 个），
# 直接取 bbox 会把范围拉到文字区。所以按列计数，只认蓝色密集的列，
# 再取最大连续块 —— 密度这关能把杂散像素全滤掉。
step = 3
col_count = [0] * w
for y in range(0, h, step):
    for x in range(w):
        r, g, b, a = px[x, y]
        if b - r > 40 and b > 90:
            col_count[x] += 1

dense = [x for x, c in enumerate(col_count) if c >= 3]
assert dense, "没找到蓝色图标区域"
# 最大连续块（允许 8px 的缝，抗锯齿不会断得太夸张）
blocks = []
start = prev = dense[0]
for x in dense[1:]:
    if x - prev > 8:
        blocks.append((start, prev))
        start = x
    prev = x
blocks.append((start, prev))
min_x, max_x = max(blocks, key=lambda b: b[1] - b[0])
# 行范围在列范围内统计
min_y, max_y = h, -1
for x in range(min_x, max_x + 1):
    for y in range(0, h, step):
        r, g, b, a = px[x, y]
        if b - r > 40 and b > 90:
            if y < min_y: min_y = y
            if y > max_y: max_y = y
print(f"蓝色图标 bbox: x {min_x}-{max_x}, y {min_y}-{max_y}（候选块 {len(blocks)} 个）")
assert max_y > 0, "没找到蓝色图标行范围"

# ---- 2. 黑底透明化（整图，一次做完再裁） ----
def unpremultiply(im):
    out = Image.new("RGBA", im.size)
    po = out.load()
    pi = im.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b, _ = pi[x, y]
            a = max(r, g, b)
            if a == 0:
                po[x, y] = (0, 0, 0, 0)
            else:
                # 反推前景色，避免边缘白边
                po[x, y] = (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), a)
    return out

transparent = unpremultiply(img)

# ---- 3. 裁 K 图标 → 加边距居中成方形 512 ----
mark = transparent.crop((min_x, min_y, max_x + 1, max_y + 1))
mw, mh = mark.size
side = int(max(mw, mh) * 1.12)  # 四周留 6% 呼吸空间
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(mark, ((side - mw) // 2, (side - mh) // 2), mark)
mark512 = canvas.resize((512, 512), Image.LANCZOS)
os.makedirs(OUT_BRAND, exist_ok=True)
mark512.save(os.path.join(OUT_BRAND, "logo-mark.png"))
print("logo-mark.png 512x512 已写")

# ---- 4. 横版整 logo 透明化（裁掉四周纯黑边） ----
# 找非透明 bbox
bbox = transparent.getbbox()
full = transparent.crop(bbox)
full.save(os.path.join(OUT_BRAND, "logo.png"))
print(f"logo.png {full.size[0]}x{full.size[1]} 已写")

# ---- 5. Electron 图标 ----
os.makedirs(OUT_BUILD, exist_ok=True)
icon_base = canvas.resize((256, 256), Image.LANCZOS)
icon_base.save(os.path.join(OUT_BUILD, "icon.png"))
icon_base.save(
    os.path.join(OUT_BUILD, "icon.ico"),
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print("build/icon.png + icon.ico 已写")

# ---- 6. 自检：输出几个采样点，确认透明化没把蓝色弄丢 ----
check = mark512.load()
blue_found = sum(1 for y in range(0, 512, 4) for x in range(0, 512, 4) if check[x, y][3] > 200 and check[x, y][2] > 150 and check[x, y][2] - check[x, y][0] > 40)
print(f"自检：512 采样点中蓝色不透明点 {blue_found} 个")
assert blue_found > 50, "透明化后蓝色像素过少，可能出错了"
print("OK")
