"""把品牌图里的蓝色重染成指定颜色（永远从原始蓝版 *.png.blue.bak 重算，不叠加）

用法：
  python scripts/recolor-brand-green.py --hex 2E7D32

为什么每次都从蓝版重算：
  连续换几版配色时直接改上一版结果会层层叠加色相，越改越脏。
  原始蓝版只在第一次运行时备份一次，之后永远以它为源。
"""
import argparse
import colorsys
import os

from PIL import Image

ROOT = r"E:\DSH项目\ai-canvas"
# 蓝色像素色相区间（青蓝 → 紫蓝）
BLUE_MIN_DEG = 190
BLUE_MAX_DEG = 275
SAT_FLOOR = 0.18


def hex_to_hsv(hx):
    hx = hx.lstrip("#")
    r, g, b = (int(hx[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h, s, v


def recolor(src_path, dst_path, target_hue, target_sat):
    im = Image.open(src_path).convert("RGBA")
    px = im.load()
    w, h = im.size
    touched = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if not (BLUE_MIN_DEG <= hh * 360 <= BLUE_MAX_DEG):
                continue
            if ss < SAT_FLOOR:
                continue
            ns = min(1.0, max(ss, target_sat))
            nr, ng, nb = colorsys.hsv_to_rgb(target_hue, ns, vv)
            px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
            touched += 1
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    im.save(dst_path, "PNG", optimize=True)
    return {"size": "%dx%d" % (w, h), "recolored": touched}


def make_ico(src_png, dst_ico):
    im = Image.open(src_png).convert("RGBA")
    im.save(dst_ico, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hex", default="4E9E00", help="target color, e.g. 2E7D32")
    args = ap.parse_args()
    hue, sat, _v = hex_to_hsv(args.hex)

    targets = [
        os.path.join(ROOT, "public", "brand", "logo-mark.png"),
        os.path.join(ROOT, "public", "brand", "logo.png"),
        os.path.join(ROOT, "build", "icon.png"),
    ]
    for dst in targets:
        src = dst + ".blue.bak"
        if not os.path.exists(src):
            print("  [skip] no blue backup: " + os.path.basename(dst))
            continue
        info = recolor(src, dst, hue, sat)
        print("  [ok] %s %s recolored=%d target=#%s" % (os.path.basename(dst), info["size"], info["recolored"], args.hex))

    icon_png = os.path.join(ROOT, "build", "icon.png")
    if os.path.exists(icon_png):
        make_ico(icon_png, os.path.join(ROOT, "build", "icon.ico"))
        print("  [ok] icon.ico regenerated")


if __name__ == "__main__":
    main()
