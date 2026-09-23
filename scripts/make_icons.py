#!/usr/bin/env python3
"""Нарисовать значки PWA без внешних библиотек."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"

GREEN = (31, 107, 58, 255)
WHITE = (255, 255, 255, 255)
DARK = (14, 61, 34, 255)


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw.extend(pixels[y * size * 4 : (y + 1) * size * 4])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def draw(size: int) -> bytearray:
    pixels = bytearray(size * size * 4)

    def setp(x: int, y: int, color: tuple[int, int, int, int]) -> None:
        if 0 <= x < size and 0 <= y < size:
            index = (y * size + x) * 4
            pixels[index : index + 4] = bytes(color)

    for y in range(size):
        for x in range(size):
            setp(x, y, GREEN)

    margin = int(size * 0.16)
    top = int(size * 0.22)
    left = margin
    right = size - margin
    bottom = size - margin
    radius = int(size * 0.06)

    def inside_round(x: int, y: int) -> bool:
        if not (left <= x < right and top <= y < bottom):
            return False
        cx = min(max(x, left + radius), right - radius - 1)
        cy = min(max(y, top + radius), bottom - radius - 1)
        dx = x - cx
        dy = y - cy
        return dx * dx + dy * dy <= radius * radius

    for y in range(size):
        for x in range(size):
            if inside_round(x, y):
                setp(x, y, WHITE)

    band_bottom = top + int(size * 0.16)
    for y in range(top, band_bottom):
        for x in range(left, right):
            if inside_round(x, y):
                setp(x, y, DARK)

    ring_r = max(2, int(size * 0.035))
    ring_y = top + int(size * 0.02)
    for center in (left + int((right - left) * 0.28), left + int((right - left) * 0.72)):
        for y in range(ring_y - ring_r * 2, ring_y + ring_r):
            for x in range(center - ring_r, center + ring_r + 1):
                dx = x - center
                dy = y - (ring_y - ring_r)
                dist = dx * dx + dy * dy
                if dist <= ring_r * ring_r:
                    setp(x, y, WHITE if dist >= (ring_r - max(2, size // 80)) ** 2 else DARK)

    bar_left = left + int(size * 0.12)
    bar_right = right - int(size * 0.12)
    bar_h = max(4, int(size * 0.045))
    gap = int(size * 0.07)
    first = band_bottom + int(size * 0.1)
    for index in range(3):
        y0 = first + index * (bar_h + gap)
        width = bar_right - bar_left - (index % 2) * int(size * 0.12)
        for y in range(y0, y0 + bar_h):
            for x in range(bar_left, bar_left + width):
                setp(x, y, GREEN)

    return pixels


def main() -> None:
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        path = OUT / name
        write_png(path, size, draw(size))
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
