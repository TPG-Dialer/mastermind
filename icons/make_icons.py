"""Generate app icons. Run: python3 icons/make_icons.py (needs Pillow)

- family (The Shoreline): skipped; its icons are rendered from brand/shoreline-logo.svg
- entrepreneur (Flight Club): navy square with the logo in cream, made from
  brand/flight-club-logo-mask.png (alpha = ink). Logo sits inside the
  maskable safe zone (center 80%)."""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def monogram_icon(cfg, size):
    img = Image.new("RGB", (size, size), cfg["colors"]["primary"])
    d = ImageDraw.Draw(img)
    bar_h = size // 24
    d.rectangle([size * 0.3, size * 0.68, size * 0.7, size * 0.68 + bar_h], fill=cfg["colors"]["accent"])
    font = ImageFont.truetype(FONT, int(size * 0.24))
    text = cfg["logoText"]
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], size * 0.46 - h / 2 - box[1]), text, font=font, fill="#FFFFFF")
    return img


def mask_icon(cfg, size, ink="#F4EFE3"):
    # full-resolution master, not the web-sized copy the app loads
    mask = Image.open(os.path.join(ROOT, "brand", "flight-club-logo-mask.png")).getchannel("A")
    # the master has a stray full-width line on its last row; drop it before cropping
    mask.paste(0, (0, mask.height - 3, mask.width, mask.height))
    mask = mask.crop(mask.getbbox())
    target = size * 0.70  # fits inside the maskable safe circle
    scale = target / max(mask.size)
    mask = mask.resize((round(mask.width * scale), round(mask.height * scale)), Image.LANCZOS)
    img = Image.new("RGB", (size, size), cfg["colors"]["primary"])
    img.paste(Image.new("RGB", mask.size, hex_rgb(ink)), ((size - mask.width) // 2, (size - mask.height) // 2), mask)
    return img


for group in ("family", "entrepreneur"):
    cfg = json.load(open(os.path.join(ROOT, "config", f"{group}.json")))
    if cfg.get("logoSvg"):
        # The Shoreline's icons are rendered from brand/shoreline-logo.svg (see README); don't overwrite them.
        continue
    for size in (192, 512):
        img = mask_icon(cfg, size) if cfg.get("logoMask") else monogram_icon(cfg, size)
        img.save(os.path.join(HERE, f"{group}-{size}.png"))
print("icons written")
