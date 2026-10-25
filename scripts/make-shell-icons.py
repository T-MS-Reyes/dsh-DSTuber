"""Generate the shell's original icon (PNG + ICO) without image libraries."""
import struct
import zlib
from pathlib import Path

W = H = 256
out_dir = Path(r"D:\projects\dsh-dstuber\shell\src-tauri\icons")
out_dir.mkdir(parents=True, exist_ok=True)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    if x0 <= x <= x1 and y0 <= y <= y1:
        if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
            return 1.0 if dx * dx + dy * dy <= r * r else 0.0
        return 1.0
    return 0.0


def ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


rows = []
for y in range(H):
    row = bytearray([0])
    for x in range(W):
        a = rounded_rect_alpha(x, y, 8, 8, 247, 247, 56)
        if a == 0:
            row += bytes((0, 0, 0, 0))
            continue
        bg = mix((23, 50, 79), (11, 22, 34), (x + y) / (W + H))
        # Whale body, belly, tail and eye.
        color = bg
        if ellipse(x, y, 118, 132, 84, 52):
            t = (y - 80) / 104
            color = mix((124, 199, 255), (63, 143, 216), max(0.0, min(1.0, t)))
        if ellipse(x, y, 92, 158, 62, 22):
            color = mix(color, (220, 240, 255), 0.35)
        if 190 <= x <= 236 and abs(y - 120) <= (x - 186) * 0.55:
            color = mix((63, 143, 216), (124, 199, 255), 0.5)
        if ellipse(x, y, 96, 118, 7, 7):
            color = (11, 22, 34)
        if 150 <= x <= 168 and 132 <= y <= 138:
            color = (220, 240, 255)
        row += bytes((color[0], color[1], color[2], round(a * 255)))
    rows.append(bytes(row))

raw = b"".join(rows)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)
(out_dir / "icon.png").write_bytes(png)

ico = (
    struct.pack("<HHH", 0, 1, 1)
    + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    + png
)
(out_dir / "icon.ico").write_bytes(ico)
print("wrote", out_dir / "icon.png", len(png), "bytes")
print("wrote", out_dir / "icon.ico", len(ico), "bytes")
