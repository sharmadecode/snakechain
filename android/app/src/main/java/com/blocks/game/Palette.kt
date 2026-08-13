package com.blocks.game

import android.graphics.Color

/** Neo-Brutalism Color Palette and 5-Block Repeating Chain Engine */
object Palette {
    val COLORS = intArrayOf(
        Color.rgb(0xFF, 0xD9, 0x3D), // 0: Punchy Yellow
        Color.rgb(0xFF, 0x57, 0x22), // 1: Fiery Orange
        Color.rgb(0x00, 0xC2, 0xD1), // 2: Electric Cyan
        Color.rgb(0xA8, 0xE1, 0x0C), // 3: Bright Lime
        Color.rgb(0xFF, 0x5C, 0xA8), // 4: Bubblegum Pink
        Color.rgb(0x7C, 0x5C, 0xFF), // 5: Electric Violet
        Color.rgb(0x00, 0xD1, 0xC0), // 6: Mint Teal
        Color.rgb(0xFF, 0x3B, 0x30), // 7: Vivid Red
        Color.rgb(0xFF, 0x9A, 0x9E), // 8: Pastel Coral
        Color.rgb(0xC0, 0xC0, 0xFF), // 9: Lavender
        Color.rgb(0xFF, 0xAA, 0x00), // 10: Amber Gold
        Color.rgb(0xFF, 0xFF, 0xFF), // 11: Crisp White
    )

    const val INK = 0xFF141414.toInt()
    const val CREAM = 0xFFFFF8E7.toInt()

    fun base(idx: Int): Int {
        val i = ((idx % COLORS.size) + COLORS.size) % COLORS.size
        return COLORS[i]
    }

    fun unpack(packed: Int): IntArray {
        if (packed < 12) {
            return intArrayOf(packed)
        }
        val count = packed % 16
        if (count in 1..8) {
            val out = IntArray(count)
            var rem = (packed ushr 4)
            for (i in 0 until count) {
                out[i] = (rem % 16) % 12
                rem = (rem ushr 4)
            }
            return out
        }
        val c0 = packed % 16
        val c1 = (packed / 16) % 16
        val c2 = (packed / 256) % 16
        val c3 = (packed / 4096) % 16
        val c4 = (packed / 65536) % 16
        return intArrayOf(c0 % 12, c1 % 12, c2 % 12, c3 % 12, c4 % 12)
    }

    fun pack(c: IntArray): Int {
        val count = c.size.coerceIn(1, 8)
        var p = count
        for (i in 0 until count) {
            val ci = ((c[i] % 12) + 12) % 12
            p += (ci shl ((i + 1) * 4))
        }
        return p
    }

    fun getBlockColor(packed: Int, blockIdx: Int): Int {
        val colors = unpack(packed)
        val n = if (colors.isNotEmpty()) colors.size else 1
        val slot = ((blockIdx % n) + n) % n
        return base(colors[slot])
    }

    /** Blend toward white (t>0) or black (t<0). */
    fun shade(color: Int, t: Float): Int {
        val r = Color.red(color).toFloat()
        val g = Color.green(color).toFloat()
        val b = Color.blue(color).toFloat()
        val f: (Float) -> Int = { c ->
            if (t >= 0) (c + (255f - c) * t).toInt().coerceIn(0, 255)
            else (c * (1f + t)).toInt().coerceIn(0, 255)
        }
        return Color.rgb(f(r), f(g), f(b))
    }

    fun segmentColor(colorIdx: Int, patternIdx: Int, i: Int, n: Int): Int {
        return getBlockColor(colorIdx, i)
    }
}
