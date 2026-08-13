"""Generate extension icons (pure stdlib, no PIL).

Draws a rounded-square badge with a violet-to-cyan gradient and a white
magnifier "lens" ring, at 16/48/128 px.
"""
import math
import os
import struct
import zlib


def write_png(path, size, pixels):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b""
    for y in range(size):
        raw += b"\x00" + bytes(v for x in range(size) for v in pixels[y][x])
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def lerp(a, b, t):
    return a + (b - a) * t


def render(size):
    c1 = (124, 92, 255)   # violet
    c2 = (33, 196, 255)   # cyan
    s = size
    radius = s * 0.22
    # lens ring geometry (relative to size)
    lens_cx, lens_cy, lens_r = s * 0.44, s * 0.44, s * 0.26
    ring_w = max(1.2, s * 0.075)
    # handle from ring edge toward bottom-right corner
    hx0 = lens_cx + lens_r * math.cos(math.pi / 4)
    hy0 = lens_cy + lens_r * math.sin(math.pi / 4)
    hx1, hy1 = s * 0.78, s * 0.78
    handle_w = ring_w * 1.1

    px = [[(0, 0, 0, 0)] * s for _ in range(s)]
    for y in range(s):
        for x in range(s):
            fx, fy = x + 0.5, y + 0.5
            # rounded-square alpha
            dx = max(radius - fx, fx - (s - radius), 0)
            dy = max(radius - fy, fy - (s - radius), 0)
            d = math.hypot(dx, dy)
            bg_a = max(0.0, min(1.0, radius - d + 0.5)) if (dx > 0 and dy > 0) else 1.0
            if bg_a <= 0:
                continue
            t = (fx + fy) / (2 * s)
            r, g, b = (int(lerp(c1[i], c2[i], t)) for i in range(3))

            # white lens ring
            dist = math.hypot(fx - lens_cx, fy - lens_cy)
            ring = max(0.0, min(1.0, ring_w / 2 - abs(dist - lens_r) + 0.5))
            # handle segment
            vx, vy = hx1 - hx0, hy1 - hy0
            seg_len2 = vx * vx + vy * vy
            u = max(0.0, min(1.0, ((fx - hx0) * vx + (fy - hy0) * vy) / seg_len2))
            seg_d = math.hypot(fx - (hx0 + u * vx), fy - (hy0 + u * vy))
            handle = max(0.0, min(1.0, handle_w / 2 - seg_d + 0.5))
            white = min(1.0, ring + handle)

            r = int(lerp(r, 255, white))
            g = int(lerp(g, 255, white))
            b = int(lerp(b, 255, white))
            px[y][x] = (r, g, b, int(bg_a * 255))
    return px


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(out, f"icon{size}.png"), size, render(size))
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
