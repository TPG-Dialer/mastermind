"""Generate realistic filled palm-frond silhouettes as transparent PNGs."""
import math, random
from PIL import Image, ImageDraw, ImageFilter

OUT = "/tmp/claude-0/-home-claude/e1865ca8-9e15-560e-b202-801bb0027c02/scratchpad/board/"
S = 4  # supersample


def bez(p0, p1, p2, t):
    return ((1-t)**2*p0[0] + 2*(1-t)*t*p1[0] + t*t*p2[0],
            (1-t)**2*p0[1] + 2*(1-t)*t*p1[1] + t*t*p2[1])


def frond(draw, p0, p1, p2, n=46, color=(31, 77, 58, 255), seed=1, lmax=170, spread=0.6, side_bias=0.0):
    rnd = random.Random(seed)
    # midrib
    pts = [bez(p0, p1, p2, i/120) for i in range(121)]
    for i in range(len(pts)-1):
        w = max(1, (1 - i/120) * 7 * S)
        draw.line([pts[i], pts[i+1]], fill=color, width=int(w))
    for i in range(n):
        t = 0.05 + 0.93 * i / (n-1)
        x, y = bez(p0, p1, p2, t)
        # tangent
        x2, y2 = bez(p0, p1, p2, min(1, t+0.01))
        ang = math.atan2(y2-y, x2-x)
        # leaflet length tapers toward the tip, longest mid-frond
        L = lmax * S * (0.35 + 0.65*math.sin(math.pi*min(1, t*1.15))) * rnd.uniform(0.82, 1.05)
        for side in (-1, 1):
            if rnd.random() < 0.06:  # occasional missing leaflet for realism
                continue
            # leaflets leave the midrib at ~35 degrees, pointing toward the tip
            a = ang + side * (spread + rnd.uniform(-0.08, 0.08)) + side_bias
            # gravity: bend the leaflet downward (+y) toward its end
            droop = rnd.uniform(0.25, 0.55)
            a_end = a + (math.pi/2 - a) * droop * 0.5 if math.cos(a) >= 0 else a + ((math.pi - math.pi/2) - a) * 0
            tip = (x + L*math.cos(a) * (1-droop*0.25), y + L*math.sin(a) + L*droop*0.9)
            ctrl = (x + L*0.6*math.cos(a), y + L*0.6*math.sin(a) + L*droop*0.15)
            wbase = max(1.6*S, L*0.022)
            left, right = [], []
            for k in range(0, 21):
                u = k/20
                px, py = bez((x, y), ctrl, tip, u)
                w = wbase * (1-u)**0.8
                nx, ny = -math.sin(a), math.cos(a)
                left.append((px+nx*w, py+ny*w)); right.append((px-nx*w, py-ny*w))
            draw.polygon(left + right[::-1], fill=color)


def render(name, W, H, fronds, color, blur=0):
    img = Image.new("RGBA", (W*S, H*S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for f in fronds:
        frond(d, *[(p[0]*S, p[1]*S) for p in f["pts"]], color=color, **f.get("kw", {}))
    img = img.resize((W, H), Image.LANCZOS)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img.save(OUT + name)
    print(name, img.size)


green = (31, 77, 58, 255)
cream = (244, 239, 226, 255)

# One big frond sweeping in from top-right, tip toward lower-left
big = [{"pts": [(760, -60), (520, 90), (200, 330)], "kw": {"n": 52, "lmax": 190, "seed": 3}}]
render("frond-tr-green.png", 750, 520, big, green)
render("frond-tr-cream.png", 750, 520, big, cream)

# Two crossing fronds (top-left and top-right), like the triptych
two = [
    {"pts": [(-40, -80), (180, 60), (420, 300)], "kw": {"n": 48, "lmax": 170, "seed": 7}},
    {"pts": [(790, -40), (540, 110), (300, 340)], "kw": {"n": 52, "lmax": 185, "seed": 11}},
]
render("frond-two-green.png", 750, 560, two, green)
render("frond-two-cream.png", 750, 560, two, cream)

# Bottom frond rising from bottom-left corner
bot = [{"pts": [(-30, 560), (220, 420), (520, 200)], "kw": {"n": 48, "lmax": 170, "seed": 5}}]
render("frond-bl-green.png", 750, 560, bot, green)
render("frond-bl-cream.png", 750, 560, bot, cream)
