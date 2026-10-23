"""Generate the Murmur mark: a flock of birds swirling into a vortex.

    python3 tools/murmuration.py          # rewrites the SVGs listed in main()

Birds are scattered along a logarithmic spiral whose band is wide at the
trailing edge and tightens into the curl. Placement is Poisson-disc style so
no two birds touch; birds near the edge of the band are smaller and fainter,
which gives the flock depth. Everything is seeded, so output is stable.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TURNS = 1.25
DECAY = 0.28
SEED = 11


def centre(s: float) -> tuple[float, float]:
    th = s * TURNS * 2 * math.pi
    r = 46 * math.exp(-DECAY * th)
    return 50 + r * math.cos(th + 2.3), 50 + 0.86 * r * math.sin(th + 2.3)


def band(s: float) -> float:
    return 16 * (1 - s) ** 1.1 * min(1.0, s * 6 + 0.3) + 0.6


def flock(n: int = 55, gap: float = 1.1, r_max: float = 2.7, r_min: float = 1.2) -> list[tuple]:
    rng = random.Random(SEED)
    birds: list[tuple] = []
    for _ in range(n * 600):
        if len(birds) >= n:
            break
        s = rng.random()
        x, y = centre(s)
        (x1, y1), (x2, y2) = centre(max(0.0, s - 1e-3)), centre(min(1.0, s + 1e-3))
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy) or 1.0
        u = rng.uniform(-1, 1)
        u = math.copysign(abs(u) ** 1.2, u)  # bias toward the core of the band
        px, py = x - dy / length * u * band(s), y + dx / length * u * band(s)
        depth = 1 - abs(u)
        r = r_min + (r_max - r_min) * depth**0.8
        g = gap * (0.7 + 0.8 * abs(u))  # dense core, airy edges
        if any((px - bx) ** 2 + (py - by) ** 2 < (r + br + g) ** 2 for bx, by, br, *_ in birds):
            continue
        heading = math.degrees(math.atan2(dy, dx)) + rng.gauss(0, 12)
        birds.append((px, py, r, heading, 0.3 + 0.7 * depth**0.6))
    return birds


def render(birds, fill="currentColor", pad=3.0, bg=None, radius=0.22) -> str:
    m = max(b[2] for b in birds) * 1.6 + pad
    x0 = min(b[0] for b in birds) - m
    y0 = min(b[1] for b in birds) - m
    w = max(b[0] for b in birds) + m - x0
    h = max(b[1] for b in birds) + m - y0
    side = max(w, h)  # square viewBox, flock centred
    x0 -= (side - w) / 2
    y0 -= (side - h) / 2
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.1f} {y0:.1f} {side:.1f} {side:.1f}">']
    if bg:
        parts.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{side:.1f}" height="{side:.1f}" rx="{side * radius:.1f}" fill="{bg}"/>')
    parts.append(f'<g fill="{fill}">')
    for x, y, r, a, op in birds:
        parts.append(
            f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{r * 1.6:.1f}" ry="{r * 0.7:.1f}" '
            f'transform="rotate({a:.0f} {x:.1f} {y:.1f})" opacity="{op:.2f}"/>'
        )
    parts.append("</g></svg>\n")
    return "".join(parts)


def main() -> None:
    birds = flock()
    outputs = {
        "app/static/mark.svg": render(birds),  # used as a CSS mask, so colour comes from the theme
        "app/static/icon.svg": render(birds, fill="#f4f5f7", pad=9, bg="#0a0b0d"),
        "docs/logo-dark.svg": render(birds, fill="#f4f5f7"),
        "docs/logo-light.svg": render(birds, fill="#171a20"),
    }
    for rel, text in outputs.items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        print(f"wrote {rel} ({len(text)} bytes, {len(birds)} birds)")


if __name__ == "__main__":
    main()
