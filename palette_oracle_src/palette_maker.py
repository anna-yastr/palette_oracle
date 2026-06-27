#the first version
"""Generate a palette card from an input image.

Usage: put an image in `Palette_input/` and run this script.
It saves a PNG into `Palette_output/`.
"""
import os
import sys
from pathlib import Path
from PIL import Image, ImageFilter, ImageDraw, ImageFont
import math
import random
import numpy as np
try:
    import webcolors
except Exception:
    webcolors = None

ROOT = Path(__file__).parent
IN_DIR = ROOT / 'Palette_input'
OUT_DIR = ROOT / 'Palette_output'
OUT_DIR.mkdir(exist_ok=True)

PAPER_TYPES = {
    "moonbone": {
        "hex": "#CFCBC2",
        "description": "Soft moonlit bone paper. Neutral with slight cold tint."
    },
    "fogsheet": {
        "hex": "#C2C6C4",
        "description": "Cold mist-grey paper. Best for warm palettes and earth tones."
    },
    "blue_ash": {
        "hex": "#B6BBB8",
        "description": "Faded blue-grey parchment. Best universal cold paper."
    },
    "storm_silk": {
        "hex": "#9FA8A8",
        "description": "Dusty desaturated blue-green paper. Best for pale palettes."
    },
    "deep_tide": {
        "hex": "#6F787C",
        "description": "Dark oceanic archive paper. Best for bright and washed palettes."
    },
}

WITCH_OVERLAYS = {
    "dark":  ["Dead", "Hollow", "Forgotten"],
    "cold":  ["Moon", "Frost", "Silent"],
    "warm":  ["Burnt", "Cinder", "Ashen"],
    "wet":   ["Drowned", "Salt", "Brine"],
    "decay": ["Rotten", "Wilted", "Mold"],
}

# Contextual prefixes to replace "Crayola" suffix based on color character
COLOR_PREFIXES = {
    'vivid':    ['Sharp', 'Raw', 'Feral', 'Sour', 'Bitter'],
    'muted':    ['Dead', 'Wilted', 'Rotten', 'Drowned', 'Hollow',
                 'Forgotten', 'Bruised', 'Mold', 'Ashen', 'Dusty', 'Stale', 'Bleached'],
    'material': ['Bone', 'Rust', 'Clay', 'Moss', 'Smoke', 'Salt',
                 'Frost', 'Mud', 'Slate', 'Tarnished', 'Cinder', 'Murky'],
}

# Primary color name source: loaded from shoko_colors.csv
SHOKO_COLORS_RGB = {}   # rgb → name
_SHOKO_LAB_CACHE = {}   # lazily populated rgb → CIELab for fast ΔE lookup


def load_external_color_db():
    """Load shoko_colors.csv (or fallback CSVs) into SHOKO_COLORS_RGB."""
    candidates = [ROOT / 'shoko_colors.csv', ROOT / 'color_db.csv', ROOT / 'external_colors.csv']
    for p in candidates:
        if not p.exists():
            continue
        try:
            import csv
            with open(p, newline='', encoding='utf-8-sig') as fh:
                reader = csv.DictReader(fh)
                for r in reader:
                    name = (r.get('name') or r.get('Name') or '').strip()
                    en_name = (r.get('name_en') or r.get('Name_en') or r.get('nameEN') or '').strip()
                    if en_name:
                        name = en_name
                    if not name:
                        continue
                    if 'hex' in r and r.get('hex'):
                        h = r.get('hex').strip().lstrip('#')
                        try:
                            rr, gg, bb = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
                        except Exception:
                            continue
                    else:
                        try:
                            rr = int(r.get('r') or r.get('R'))
                            gg = int(r.get('g') or r.get('G'))
                            bb = int(r.get('b') or r.get('B'))
                        except Exception:
                            continue
                    SHOKO_COLORS_RGB[(rr, gg, bb)] = name
            break
        except Exception:
            continue

load_external_color_db()


def _levenshtein(a, b):
    a, b = a.lower(), b.lower()
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0: return lb
    if lb == 0: return la
    dp = list(range(lb + 1))
    for i in range(1, la + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, lb + 1):
            cur = dp[j]
            cost = 0 if a[i-1] == b[j-1] else 1
            dp[j] = min(dp[j] + 1, dp[j-1] + 1, prev + cost)
            prev = cur
    return dp[lb]


def is_similar_name(a, b):
    """Return True if names share a token or have small edit distance."""
    if not a or not b:
        return False
    la, lb = a.lower(), b.lower()
    wa = set(w for w in la.replace('-', ' ').split() if w)
    wb = set(w for w in lb.replace('-', ' ').split() if w)
    if wa & wb:
        return True
    return _levenshtein(la, lb) <= 2


def rgb_to_hsv(rgb):
    r, g, b = [x / 255.0 for x in rgb]
    max_c, min_c = max(r, g, b), min(r, g, b)
    delta = max_c - min_c
    if delta == 0:
        h = 0
    elif max_c == r:
        h = 60 * (((g - b) / delta) % 6)
    elif max_c == g:
        h = 60 * ((b - r) / delta + 2)
    else:
        h = 60 * ((r - g) / delta + 4)
    s = 0 if max_c == 0 else (delta / max_c) * 100
    v = max_c * 100
    return (h % 360, s, v)


def format_title_from_filename(filename):
    stem = Path(filename).stem.replace('_', ' ').replace('-', ' ')
    return ' '.join(w.capitalize() for w in stem.split() if w.strip())


def _clean_name_for_overlay(name):
    """Strip vendor suffixes and trim to ≤2 words for clean overlay composition."""
    name = name.replace(' Crayola', '').replace(' crayola', '').strip()
    words = name.split()
    return ' '.join(words[-2:] if len(words) > 2 else words)


def _crayola_to_prefix(name, rgb):
    """Replace ' Crayola' suffix with a category-appropriate prefix based on HSV."""
    if ' Crayola' not in name and ' crayola' not in name:
        return name
    base = name.replace(' Crayola', '').replace(' crayola', '').strip()
    _, s, v = rgb_to_hsv(rgb)
    if s > 55 and v > 60:
        pool = COLOR_PREFIXES['vivid']
    elif v < 35 or s < 15:
        pool = COLOR_PREFIXES['muted']
    else:
        pool = COLOR_PREFIXES['material']
    prefix = pool[(rgb[0] + rgb[1] + rgb[2]) % len(pool)]
    return f"{prefix} {base}"


def _apply_witch_overlay(name, rgb, rng):
    """Prepend a contextual witch token to a (cleaned) color name."""
    clean = _clean_name_for_overlay(name)
    h, _s, v = rgb_to_hsv(rgb)
    if v < 30:
        cats = ['dark', 'decay']
    elif v > 75:
        cats = ['cold']
    elif h < 60 or h > 300:
        cats = ['warm', 'dark']
    else:
        cats = ['wet', 'cold']
    cat = rng.choice(cats)
    tokens = WITCH_OVERLAYS.get(cat, [])
    if not tokens:
        return clean
    return f"{rng.choice(tokens)} {clean}"


def find_nearest_shoko(rgb, exclude=None):
    """Return (name, delta_e) of nearest shoko color by LAB ΔE.
    Skips names that exactly match or share tokens with any entry in `exclude`.
    Returns (None, inf) if the DB is empty or all candidates are excluded.
    """
    if not SHOKO_COLORS_RGB:
        return None, float('inf')
    lab = rgb_to_lab(rgb)
    for s_rgb in SHOKO_COLORS_RGB:
        if s_rgb not in _SHOKO_LAB_CACHE:
            _SHOKO_LAB_CACHE[s_rgb] = rgb_to_lab(s_rgb)
    excl_tokens = []
    if exclude:
        for ex in exclude:
            toks = frozenset(ex.lower().replace('-', ' ').split())
            excl_tokens.append((ex, toks))
    best_d, best_name = float('inf'), None
    for s_rgb, s_name in SHOKO_COLORS_RGB.items():
        if excl_tokens:
            s_toks = frozenset(s_name.lower().replace('-', ' ').split())
            if any(s_name == ex or bool(s_toks & et) for ex, et in excl_tokens):
                continue
        d = delta_e_lab(lab, _SHOKO_LAB_CACHE[s_rgb])
        if d < best_d:
            best_d, best_name = d, s_name
    return (best_name, best_d) if best_name is not None else (None, float('inf'))


def choose_curated_names_for_card(colors, rng=None, title=None):
    """Select unique names for a palette card.
    - Nearest-by-LAB match from shoko_colors.csv
    - Positions 0 and 1 always receive a witch overlay token
    - Growing local-exclude per slot guarantees no token-overlap duplicates
    """
    if rng is None:
        rng = random

    n = len(colors)

    class _RNGProxy:
        def __init__(self, base):
            self._base = base
        def random(self):   return self._base.random()
        def choice(self, s): return self._base.choice(s)
        def randint(self, a, b): return self._base.randint(a, b)
        def sample(self, s, k):  return self._base.sample(s, k)
    rngp = _RNGProxy(rng)

    overlay_indices = set() if n == 0 else ({0} if n == 1 else {0, 1})

    selected_names = []
    used_names = set()

    for i, rgb in enumerate(colors):
        allow_overlay = (i in overlay_indices)
        chosen = None
        local_exclude = set(used_names)

        for _ in range(6):
            shoko_name, _ = find_nearest_shoko(rgb, exclude=local_exclude)
            if shoko_name is None:
                break
            cand = _apply_witch_overlay(shoko_name, rgb, rngp) if allow_overlay else _crayola_to_prefix(shoko_name, rgb)
            if cand not in used_names and not any(is_similar_name(cand, u) for u in used_names):
                chosen = cand
                break
            local_exclude.add(cand)

        selected_names.append(chosen or 'Color')
        used_names.add(chosen or 'Color')

    return selected_names


def check_luminance_contrast(paper_lab, colors_lab, min_difference=45):
    paper_L = paper_lab[0]
    failing = [i for i, c in enumerate(colors_lab) if abs(c[0] - paper_L) < min_difference]
    return (len(failing) == 0, failing)


def adjust_color_luminance_lab(lab, shift_percent):
    L, a, b = lab
    return (max(0, min(100, L + L * shift_percent)), a, b)


def rgb_to_xyz(rgb):
    r, g, b = [v / 255.0 for v in rgb]
    def to_linear(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = to_linear(r), to_linear(g), to_linear(b)
    x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
    y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
    z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041
    return (x, y, z)


def xyz_to_lab(xyz):
    x, y, z = xyz
    xr, yr, zr = x / 0.95047, y / 1.00000, z / 1.08883
    def f(t):
        return t ** (1/3) if t > 0.008856 else 7.787 * t + 16/116
    fx, fy, fz = f(xr), f(yr), f(zr)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def rgb_to_lab(rgb):
    return xyz_to_lab(rgb_to_xyz(rgb))


def delta_e_lab(lab1, lab2):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(lab1, lab2)))


def lab_to_rgb(lab):
    L, a, b = lab
    fy = (L + 16) / 116
    fx = a / 500 + fy
    fz = fy - b / 200
    def f_inv(t):
        t3 = t ** 3
        return t3 if t3 > 0.008856 else (116 * t - 16) / 7.787
    x = f_inv(fx) * 0.95047
    y = f_inv(fy) * 1.00000
    z = f_inv(fz) * 1.08883
    r = x *  3.2406 + y * -1.5372 + z * -0.4986
    g = x * -0.9689 + y *  1.8758 + z *  0.0415
    b = x *  0.0557 + y * -0.2040 + z *  1.0570
    def to_srgb(c):
        c = max(0.0, min(1.0, c))
        return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1/2.4)) - 0.055
    return (int(round(to_srgb(r) * 255)), int(round(to_srgb(g) * 255)), int(round(to_srgb(b) * 255)))


def get_dominant_colors(img, n=5, thumb_size=300, min_L=15, max_L=85, min_delta=15, min_L_diff=8, use_kmeans=True):
    img_small = img.copy().convert('RGB')
    img_small.thumbnail((thumb_size, thumb_size))
    img_small = img_small.filter(ImageFilter.GaussianBlur(radius=2))
    arr = np.array(img_small).reshape(-1, 3)
    lab_array = np.array([rgb_to_lab(tuple(rgb)) for rgb in arr])
    valid_mask = (lab_array[:, 0] >= min_L) & (lab_array[:, 0] <= max_L)
    lab_filtered = lab_array[valid_mask]
    arr_filtered = arr[valid_mask]
    if len(lab_filtered) == 0:
        unique_colors, counts = np.unique(arr.reshape(-1, 3), axis=0, return_counts=True)
        idx = np.argsort(counts)[::-1][:n]
        return [tuple(map(int, unique_colors[i])) for i in idx]
    if use_kmeans and len(lab_filtered) > n:
        try:
            from sklearn.cluster import KMeans
            n_clusters = min(n, len(lab_filtered))
            kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            kmeans.fit(lab_filtered)
            result = []
            for cid in range(n_clusters):
                mask = kmeans.labels_ == cid
                if not np.any(mask):
                    continue
                cl = lab_filtered[mask]
                rgb_c = arr_filtered[mask]
                center = kmeans.cluster_centers_[cid]
                if center[0] > 40:
                    chroma = np.sqrt(cl[:, 1] ** 2 + cl[:, 2] ** 2)
                    threshold = np.percentile(chroma, 75)
                    vivid = chroma >= threshold
                    if not np.any(vivid):
                        vivid = np.ones(len(cl), dtype=bool)
                    cl_v, rgb_v = cl[vivid], rgb_c[vivid]
                    nearest_rgb = rgb_v[np.argmin(np.sum((cl_v - center) ** 2, axis=1))]
                else:
                    nearest_rgb = rgb_c[np.argmin(np.sum((cl - center) ** 2, axis=1))]
                result.append(tuple(map(int, nearest_rgb)))
            # Post-filter: prefer colors with L differing by at least min_L_diff
            result_with_L = sorted([(rgb, rgb_to_lab(rgb)[0]) for rgb in result], key=lambda x: x[1])
            diverse, remainder, diverse_L = [], [], []
            for rgb, L in result_with_L:
                if not diverse_L or all(abs(L - sel_L) >= min_L_diff for sel_L in diverse_L):
                    diverse.append(rgb)
                    diverse_L.append(L)
                else:
                    remainder.append(rgb)
            if len(diverse) < n:
                diverse.extend(remainder[:n - len(diverse)])
            result = diverse
            return result[:n]
        except Exception:
            pass
    cols_rgb = [tuple(map(int, c)) for c in arr_filtered]
    cols_lab = [tuple(lab_filtered[i]) for i in range(len(arr_filtered))]
    unique_colors = {}
    for rgb, lab in zip(cols_rgb, cols_lab):
        unique_colors[rgb] = (lab, unique_colors[rgb][1] + 1) if rgb in unique_colors else (lab, 1)
    selected = []
    candidates = [(rgb, lab, count) for rgb, (lab, count) in unique_colors.items()]
    candidates.sort(key=lambda x: x[2], reverse=True)
    if candidates:
        selected.append(candidates.pop(0))
    while len(selected) < n and candidates:
        best_idx, best_score = None, -1
        for i, (rgb_c, lab_c, cnt_c) in enumerate(candidates):
            dmin = min(delta_e_lab(lab_c, s[1]) for s in selected) if selected else float('inf')
            if dmin < min_delta:
                continue
            L_dmin = min(abs(lab_c[0] - s[1][0]) for s in selected) if selected else float('inf')
            if L_dmin < min_L_diff:
                continue
            score = cnt_c * dmin
            if score > best_score:
                best_score, best_idx = score, i
        if best_idx is None:
            best_idx = 0
        selected.append(candidates.pop(best_idx))
    selected.sort(key=lambda x: x[1][0])
    return [s[0] for s in selected[:n]]


def rgb_to_hex(rgb):
    return '#%02x%02x%02x' % rgb


def create_vignette(size, max_alpha=120):
    w, h = size
    vign = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(vign)
    steps = 80
    for i in range(steps):
        alpha = int(max_alpha * ((i / (steps - 1)) ** 2))
        inset = (1.0 - i / (steps - 1)) * max(w, h) * 0.45
        bbox = [-inset, -inset, w + inset, h + inset]
        draw.ellipse(bbox, fill=alpha)
    return vign.filter(ImageFilter.GaussianBlur(radius=20))


def scale_and_crop_to_size(img, size=(960, 960)):
    target_w, target_h = size
    src_w, src_h = img.size
    if src_w == target_w and src_h == target_h:
        return img.copy()
    scale = max(target_w / src_w, target_h / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def paper_color_from_hex(hex_code):
    return tuple(int(hex_code[i:i+2], 16) for i in (1, 3, 5))


def choose_paper_type(avg_luminance, rng=None):
    if rng is None:
        rng = random
    if avg_luminance > 0.72:
        return "deep_tide"
    elif avg_luminance > 0.60:
        return rng.choice(["blue_ash", "storm_silk"])
    elif avg_luminance < 0.30:
        return rng.choice(["moonbone", "fogsheet"])
    return rng.choice(["moonbone", "blue_ash", "fogsheet", "storm_silk"])


def find_input_images():
    if not IN_DIR.exists():
        raise FileNotFoundError(f"Input folder not found: {IN_DIR}")
    exts = ('.png', '.jpg', '.jpeg', '.webp')
    files = [p for p in IN_DIR.iterdir() if p.suffix.lower() in exts and p.is_file()]
    if not files:
        raise FileNotFoundError(f"No images found in {IN_DIR}")
    files.sort(key=lambda p: p.name)
    return files


def draw_palette_card(bg_image, colors, names, title, width_factors, paper_name, out_path, author=None):
    w, h = bg_image.size
    base = bg_image.copy().convert('RGBA')

    overlay = Image.new('RGBA', (w, h), (20, 16, 12, 100))
    base = Image.alpha_composite(base, overlay)
    vignette = create_vignette((w, h), max_alpha=130)
    base = Image.composite(Image.new('RGBA', (w, h), (0, 0, 0, 0)), base, vignette)

    draw = ImageDraw.Draw(base)

    def text_size(draw_obj, text, font):
        try:
            bbox = draw_obj.textbbox((0, 0), text, font=font)
            return bbox[2] - bbox[0], bbox[3] - bbox[1]
        except Exception:
            try:
                return font.getsize(text)
            except Exception:
                return draw_obj.textsize(text, font=font)

    def load_any_font(names, size):
        for n in names:
            try:
                return ImageFont.truetype(n, size)
            except Exception:
                continue
        return ImageFont.load_default()

    forum_fonts = [
        str(ROOT.parent / 'fonts' / 'Forum-Regular.ttf'),
        '../fonts/Forum-Regular.ttf',
    ]
    try_fonts = [
        str(ROOT / 'Kawoszeh-OE63.ttf'),
        str(ROOT / 'kawoszeh-font' / 'Kawoszeh-OE63.ttf'),
        'C:/Windows/Fonts/Georgia.ttf',
        'Georgia.ttf', 'Garamond.ttf', 'Times New Roman.ttf',
    ]

    def has_cyrillic(text):
        return any('Ѐ' <= c <= 'ӿ' for c in text)

    title_font_size = 72 if len(title) <= 16 else int(72 * 0.85)
    title_fonts = forum_fonts + try_fonts if has_cyrillic(title) else try_fonts
    font_title      = load_any_font(title_fonts, title_font_size)
    font_subtitle   = load_any_font(try_fonts, 30)
    font_label      = load_any_font(try_fonts, 26)
    font_label_small = font_label

    card_margin_x = int(w * 0.08)
    card_margin_y = int(h * 0.08)
    card_x = card_margin_x
    card_y = card_margin_y
    card_w = w - card_margin_x * 2
    card_h = h - card_margin_y * 2
    card_radius = 28
    paper = PAPER_TYPES.get(paper_name, PAPER_TYPES['moonbone'])
    card_fill = paper_color_from_hex(paper['hex']) + (230,)
    border_color = (90, 76, 65, 180)
    paper_rgb = paper_color_from_hex(paper['hex'])
    paper_lum = (0.299 * paper_rgb[0] + 0.587 * paper_rgb[1] + 0.114 * paper_rgb[2]) / 255.0
    if paper_lum < 0.45:
        text_color = (245, 235, 220, 255)
        title_shadow_color = (0, 0, 0, 180)
    else:
        text_color = (40, 36, 32, 255)
        title_shadow_color = (20, 18, 16, 180)

    card_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cdraw = ImageDraw.Draw(card_layer)
    cdraw.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h],
                             radius=card_radius, fill=card_fill, outline=border_color, width=2)

    title_text = title
    title_w, _ = text_size(cdraw, title_text, font_title)
    title_x = card_x + (card_w - title_w) / 2
    title_y = card_y + card_h * 0.06 - 15

    content_x = card_x + int(card_w * 0.08)
    content_w = card_w - int(card_w * 0.16)
    row_h = int(card_h * 0.085)
    row_spacing = int(card_h * 0.045)
    n_colors = len(colors)
    content_bottom_y = card_y + card_h * 0.84 - 15
    content_y = int(content_bottom_y - (n_colors * row_h + (n_colors - 1) * row_spacing))
    label_area = int(content_w * 0.30)
    stripe_area = content_w - label_area - int(card_w * 0.02)

    star_center_x = card_x + card_w / 2
    star_center_y = content_y - card_h * 0.038
    star_radius = int(card_h * 0.018)
    star_fill = (40, 36, 32, 240)
    star_points = []
    for k in range(8):
        angle = math.radians(45 * k)
        r = star_radius if k % 2 == 0 else star_radius * 0.42
        star_points.append((star_center_x + r * math.cos(angle), star_center_y + r * math.sin(angle)))
    cdraw.polygon(star_points, fill=star_fill)

    shadow_offset = 2
    cdraw.text((title_x + shadow_offset, title_y + shadow_offset), title_text,
               font=font_title, fill=title_shadow_color)
    for dx in range(0, 2):
        for dy in range(0, 2):
            cdraw.text((title_x + dx, title_y + dy), title_text, font=font_title, fill=text_color)

    for i, (col, name) in enumerate(zip(colors, names)):
        row_y = content_y + i * (row_h + row_spacing)
        row_x = content_x
        label_x = row_x
        lw, lh = text_size(cdraw, name, font_label)
        words = name.replace('-', ' ').split()
        if lw <= label_area or len(words) <= 1:
            font_to_use, fw, fh = font_label, lw, lh
            if fw > label_area:
                font_to_use = font_label_small
                fw, fh = text_size(cdraw, name, font_label_small)
            label_y = row_y + (row_h - fh) / 2
            cdraw.text((label_x, label_y), name, font=font_to_use, fill=text_color)
        else:
            best_split, best_max_w = 1, float('inf')
            for split in range(1, len(words)):
                w1 = text_size(cdraw, ' '.join(words[:split]), font_label_small)[0]
                w2 = text_size(cdraw, ' '.join(words[split:]), font_label_small)[0]
                if max(w1, w2) < best_max_w:
                    best_max_w, best_split = max(w1, w2), split
            line1 = ' '.join(words[:best_split])
            line2 = ' '.join(words[best_split:])
            lh1 = text_size(cdraw, line1, font_label_small)[1]
            lh2 = text_size(cdraw, line2, font_label_small)[1]
            total_h = lh1 + 2 + lh2
            start_y = int(row_y + (row_h - total_h) / 2)
            cdraw.text((label_x, start_y), line1, font=font_label_small, fill=text_color)
            cdraw.text((label_x, start_y + lh1 + 2), line2, font=font_label_small, fill=text_color)

        factor = width_factors[i]
        stripe_w = max(1, int(stripe_area * factor))
        stripe_x = row_x + label_area + int(card_w * 0.02)
        stripe_y = int(row_y)
        stripe_h = int(row_h)
        stripe_rect = [stripe_x, stripe_y, stripe_x + stripe_w, stripe_y + stripe_h]
        stripe_radius = int(row_h * 0.4)

        ink = Image.new('RGBA', (stripe_w, stripe_h), (0, 0, 0, 0))
        idraw = ImageDraw.Draw(ink)
        idraw.rounded_rectangle([0, 0, stripe_w, stripe_h], radius=stripe_radius, fill=(20, 16, 12, 12))
        card_layer.paste(ink, (stripe_x, stripe_y), ink)

        stripe = Image.new('RGBA', (stripe_w, stripe_h), tuple(col) + (255,))
        mask = Image.new('L', (stripe_w, stripe_h), 0)
        mdraw = ImageDraw.Draw(mask)
        mdraw.rounded_rectangle([0, 0, stripe_rect[2] - stripe_rect[0], stripe_h], radius=stripe_radius, fill=255)
        card_layer.paste(stripe, (stripe_x, stripe_y), mask)

        underline_y = row_y + row_h + 4
        cdraw.line([label_x, underline_y, label_x + int(label_area * 0.8), underline_y],
                   fill=(120, 100, 86, 140), width=1)

    if author:
        author_text = f'Вдохновлено {author}'
        author_font = load_any_font(
            [
                str(ROOT.parent / 'fonts' / 'Forum-Regular.ttf'),
                '../fonts/Forum-Regular.ttf',
            ] + try_fonts,
            22,
        )
        bottom_area_top = card_y + card_h * 0.84 - 15
        bottom_area_bot = card_y + card_h
        author_y = int(bottom_area_top + (bottom_area_bot - bottom_area_top) * 0.40)
        aw, _ = text_size(cdraw, author_text, author_font)
        author_x = card_x + (card_w - aw) / 2
        cdraw.text((int(author_x), author_y), author_text, font=author_font, fill=text_color)

    base = Image.alpha_composite(base, card_layer)

    # ── watermark (mirrors imageRenderer.js drawWatermark) ──────────────────
    wm_draw = ImageDraw.Draw(base)
    # Forum first (same font as imageRenderer.js), then clean system serifs
    wm_font = load_any_font(
        [
            str(ROOT.parent / 'fonts' / 'Forum-Regular.ttf'),
            '../fonts/Forum-Regular.ttf',
            'C:/Windows/Fonts/georgia.ttf',
            'C:/Windows/Fonts/Georgia.ttf',
        ] + try_fonts,
        14,
    )

    WM_Y        = 102
    WM_MID_GAP  = 30
    WM_D_SIDE   = 3
    WM_D_CENTER = 2
    WM_SPACING  = 2
    WM_COLOR    = (28, 20, 14, 112)   # rgba(28,20,14,0.50)

    def _cw(ch):
        try:
            return wm_draw.textlength(ch, font=wm_font)
        except Exception:
            bb = wm_draw.textbbox((0, 0), ch, font=wm_font)
            return max(bb[2] - bb[0], 3)

    def _tw(text):
        return sum(_cw(c) for c in text) + WM_SPACING * max(0, len(text) - 1)

    lw      = _tw('THE PALETTE ORACLE')
    rw      = _tw('AME TANAMI')
    total_w = lw + WM_MID_GAP + rw
    sx      = w / 2 - total_w / 2

    # anchor='lm' centres each glyph vertically on WM_Y → diamonds align exactly
    for text, ox in [('THE PALETTE ORACLE', sx), ('AME TANAMI', sx + lw + WM_MID_GAP)]:
        cx = ox
        for ch in text:
            wm_draw.text((int(cx), WM_Y), ch, font=wm_font, fill=WM_COLOR, anchor='lm')
            cx += _cw(ch) + WM_SPACING

    def _diamond(cx, cy, half):
        wm_draw.polygon(
            [(cx, cy - half), (cx + half, cy), (cx, cy + half), (cx - half, cy)],
            fill=WM_COLOR,
        )

    _diamond(sx + lw + WM_MID_GAP / 2, WM_Y, WM_D_CENTER)
    _diamond(sx - 10,                  WM_Y, WM_D_SIDE)
    _diamond(sx + total_w + 10,        WM_Y, WM_D_SIDE)
    # ────────────────────────────────────────────────────────────────────────

    base.convert('RGB').save(out_path, 'PNG')


def process_single_image(src_path, title=None, author=None, out_path=None):
    src = Path(src_path)
    img = Image.open(src)
    bg  = scale_and_crop_to_size(img, size=(960, 960)).convert('RGB')
    bg  = bg.filter(ImageFilter.GaussianBlur(radius=70))

    colors  = get_dominant_colors(img, n=5, thumb_size=200, min_L=8, max_L=92, min_delta=15, use_kmeans=True)
    avg_lum = sum((0.299 * r + 0.587 * g + 0.114 * b) / 255.0 for r, g, b in colors) / max(1, len(colors))

    paper_seed  = random.Random(src.stem)
    naming_seed = random.Random(src.stem)
    paper_name  = choose_paper_type(avg_lum, rng=paper_seed)

    colors_list = list(colors)
    paper_rgb   = paper_color_from_hex(PAPER_TYPES[paper_name]['hex'])
    paper_lab   = rgb_to_lab(paper_rgb)
    colors_lab  = [rgb_to_lab(tuple(c)) for c in colors_list]

    all_valid, failing_indices = check_luminance_contrast(paper_lab, colors_lab, min_difference=45)
    if not all_valid:
        available_papers = list(PAPER_TYPES.keys())
        paper_seed.shuffle(available_papers)
        found_valid_paper = False
        for try_paper in available_papers:
            if try_paper == paper_name:
                continue
            try_rgb = paper_color_from_hex(PAPER_TYPES[try_paper]['hex'])
            try_lab = rgb_to_lab(try_rgb)
            try_valid, _ = check_luminance_contrast(try_lab, colors_lab, min_difference=45)
            if try_valid:
                paper_name = try_paper
                found_valid_paper = True
                break
        if not found_valid_paper:
            adjusted_colors = []
            for idx, rgb in enumerate(colors_list):
                if idx in failing_indices:
                    # Scale RGB directly to stay in gamut — LAB roundtrip clips
                    # negative linear values and produces wrong hues
                    rgb_pos = tuple(min(255, int(c * 1.15)) for c in rgb)
                    rgb_neg = tuple(max(0,   int(c * 0.85)) for c in rgb)
                    lab_pos = rgb_to_lab(rgb_pos)
                    lab_neg = rgb_to_lab(rgb_neg)
                    contrast_pos = abs(lab_pos[0] - paper_lab[0])
                    contrast_neg = abs(lab_neg[0] - paper_lab[0])
                    if contrast_pos >= contrast_neg:
                        adjusted_colors.append(rgb_pos)
                        colors_lab[idx] = lab_pos
                    else:
                        adjusted_colors.append(rgb_neg)
                        colors_lab[idx] = lab_neg
                else:
                    adjusted_colors.append(rgb)
            colors_list = adjusted_colors

    colors       = tuple(colors_list)
    names        = choose_curated_names_for_card(colors, rng=naming_seed)
    width_seed   = random.Random(src.stem)
    width_factors = [width_seed.uniform(0.55, 0.96) for _ in colors]

    card_title = title if title else format_title_from_filename(src.name)
    dest       = Path(out_path) if out_path else OUT_DIR / f"{src.stem}_palette.png"
    draw_palette_card(bg, colors, names, card_title, width_factors, paper_name, dest, author=author)
    print('Saved palette to', dest)


def main():
    try:
        files = find_input_images()
    except Exception as e:
        print('Error:', e)
        sys.exit(1)

    for src in files:
        process_single_image(src)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--input',  default=None)
    parser.add_argument('--output', default=None)
    parser.add_argument('--title',  default=None)
    parser.add_argument('--author', default=None)
    cli_args, _ = parser.parse_known_args()

    if cli_args.input:
        process_single_image(
            cli_args.input,
            title=cli_args.title,
            author=cli_args.author,
            out_path=cli_args.output,
        )
    else:
        main()
