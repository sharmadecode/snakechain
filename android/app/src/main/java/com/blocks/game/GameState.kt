package com.blocks.game

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.sin

data class PlayerState(
    val id: Int,
    var name: String,
    var colorIdx: Int,
    var patternIdx: Int,
    var isBot: Boolean,
    var kills: Int,
    var boost: Boolean,
    var tx: Float,
    var ty: Float,
    var ta: Float,
    var tlen: Float,
    var thick: Float,
    var x: Float,
    var y: Float,
    var a: Float,
    var len: Float,
    val px: MutableList<Float> = mutableListOf(),
    val py: MutableList<Float> = mutableListOf(),
    var total: Float = 0f,
    var vx: Float = 0f,
    var vy: Float = 0f,
    var lastRowT: Long = System.currentTimeMillis(),
    var body: FloatArray? = null,
)

data class DeadStats(
    val kills: Int,
    val timeMs: Long,
    val maxLen: Int,
    val rank: Int,
    val killerName: String? = null,
    val wall: Boolean = false,
)

private const val SPACING = 10f

class GameState {
    var myId = 0
    var halfW = 2400f
    var halfH = 2400f
    var ping = -1L
    var alive = false
    var myKills = 0
    val players = LinkedHashMap<Int, PlayerState>()
    val food = HashMap<Int, FloatArray>()
    var leaderboard = listOf<JSONArray>()
    var dead: DeadStats? = null

    val deathFx = mutableListOf<FloatArray>() // [x, y, colorIdx, thick]
    val eatenFx = mutableListOf<FloatArray>() // [x, y, colorIdx]

    fun getSelf(): PlayerState? = players[myId]

    fun reset() {
        myId = 0
        halfW = 2400f
        halfH = 2400f
        ping = -1L
        alive = false
        myKills = 0
        players.clear()
        food.clear()
        leaderboard = emptyList()
        dead = null
        deathFx.clear()
        eatenFx.clear()
    }

    fun applyState(json: JSONObject) {
        val w = json.optJSONArray("w")
        if (w != null) {
            halfW = w.optDouble(0, 2400.0).toFloat()
            halfH = w.optDouble(1, 2400.0).toFloat()
        }
        val rows = json.optJSONArray("p") ?: return
        val now = System.currentTimeMillis()

        for (i in 0 until rows.length()) {
            val r = rows.getJSONArray(i)
            val id = r.getInt(0)
            val tx = r.getDouble(1).toFloat()
            val ty = r.getDouble(2).toFloat()
            val ta = r.getDouble(3).toFloat()
            val tlen = r.getDouble(4).toFloat()
            val thick = r.getDouble(5).toFloat()
            val existing = players[id]

            if (existing != null) {
                // Respawn teleport check
                if (hypot(tx - existing.x, ty - existing.y) > 800f) {
                    players[id] = makePlayer(r, now)
                    continue
                }
                val dt = (now - existing.lastRowT).coerceIn(16, 250) / 1000f
                existing.vx = (tx - existing.tx) / dt
                existing.vy = (ty - existing.ty) / dt
                existing.tx = tx
                existing.ty = ty
                existing.ta = ta
                existing.tlen = tlen
                existing.thick = thick
                existing.kills = r.getInt(10)
                existing.name = r.getString(11)
                existing.lastRowT = now
            } else {
                players[id] = makePlayer(r, now)
            }
            if (id == myId) myKills = r.getInt(10)
        }

        // NOTE: absence is NOT death (server interest-filters per client).
        // Players age out via TTL in update().
        if (players.containsKey(myId)) alive = true
    }

    private fun makePlayer(r: JSONArray, now: Long): PlayerState {
        val id = r.getInt(0)
        val tx = r.getDouble(1).toFloat()
        val ty = r.getDouble(2).toFloat()
        val ta = r.getDouble(3).toFloat()
        val tlen = r.getDouble(4).toFloat()
        val thick = r.getDouble(5).toFloat()
        val p = PlayerState(
            id = id,
            name = r.getString(11),
            colorIdx = r.getInt(6),
            patternIdx = r.getInt(7),
            isBot = r.getInt(8) == 1,
            kills = r.getInt(10),
            boost = r.getInt(9) == 1,
            tx = tx, ty = ty, ta = ta, tlen = tlen, thick = thick,
            x = tx, y = ty, a = ta, len = tlen,
            lastRowT = now,
        )
        // Seed tail points behind head
        val seedCount = 8
        val cx = cos(ta)
        val cy = sin(ta)
        for (k in 1..seedCount) {
            p.px.add(tx - cx * SPACING * k)
            p.py.add(ty - cy * SPACING * k)
        }
        p.total = seedCount * SPACING
        return p
    }

    fun applyBody(json: JSONObject) {
        val rows = json.optJSONArray("p") ?: return
        for (i in 0 until rows.length()) {
            val r = rows.getJSONArray(i)
            val id = r.getInt(0)
            val pl = players[id] ?: continue
            val count = r.length() - 1
            if (count >= 4 && count % 2 == 0) {
                val coords = FloatArray(count)
                for (j in 0 until count) {
                    coords[j] = r.getDouble(j + 1).toFloat()
                }
                pl.body = coords
            }
        }
    }

    fun applyDeaths(json: JSONObject) {
        val rows = json.optJSONArray("d") ?: return
        for (i in 0 until rows.length()) {
            val r = rows.getJSONArray(i)
            val id = r.getInt(0)
            val pl = players[id]
            if (pl != null) {
                deathFx.add(floatArrayOf(r.getDouble(1).toFloat(), r.getDouble(2).toFloat(), pl.colorIdx.toFloat(), pl.thick))
                players.remove(id)
            }
        }
    }

    fun applyFullFood(json: JSONArray) {
        food.clear()
        for (i in 0 until json.length()) {
            val r = json.getJSONArray(i)
            food[r.getInt(0)] = floatArrayOf(
                r.getDouble(1).toFloat(), r.getDouble(2).toFloat(),
                r.getInt(3).toFloat(),
            )
        }
    }

    fun applyFoodEvents(json: JSONObject) {
        val keep = json.optJSONArray("k")
        if (keep != null) {
            val next = HashMap<Int, FloatArray>()
            for (i in 0 until keep.length()) {
                val r = keep.getJSONArray(i)
                next[r.getInt(0)] = floatArrayOf(
                    r.getDouble(1).toFloat(), r.getDouble(2).toFloat(),
                    r.getInt(3).toFloat(),
                )
            }
            food.clear()
            food.putAll(next)
            return
        }
        val spawned = json.optJSONArray("s")
        if (spawned != null) {
            for (i in 0 until spawned.length()) {
                val r = spawned.getJSONArray(i)
                food[r.getInt(0)] = floatArrayOf(
                    r.getDouble(1).toFloat(), r.getDouble(2).toFloat(),
                    r.getInt(3).toFloat(),
                )
            }
        }
        val removed = json.optJSONArray("r")
        if (removed != null) {
            for (i in 0 until removed.length()) {
                val id = removed.getInt(i)
                val f = food.remove(id)
                if (f != null && eatenFx.size < 40) {
                    eatenFx.add(f)
                }
            }
        }
    }

    fun update(dt: Float) {
        val k = 1f - exp(-dt * 22f)
        val now = System.currentTimeMillis()
        val toRemove = mutableListOf<Int>()

        for ((id, pl) in players) {
            // TTL sweep for out-of-view snakes (3 seconds)
            if (now - pl.lastRowT > 3000L) {
                toRemove.add(id)
                continue
            }

            pl.x += (pl.tx - pl.x) * k
            pl.y += (pl.ty - pl.y) * k

            var d = pl.ta - pl.a
            val twoPi = (2 * PI).toFloat()
            while (d > PI.toFloat()) d -= twoPi
            while (d < -PI.toFloat()) d += twoPi
            pl.a += d * k
            pl.len += (pl.tlen - pl.len) * k

            val headX = pl.px.firstOrNull() ?: pl.x
            val headY = pl.py.firstOrNull() ?: pl.y
            val moved = hypot(pl.x - headX, pl.y - headY)
            if (moved >= SPACING) {
                pl.px.add(0, pl.x)
                pl.py.add(0, pl.y)
                pl.total += moved
            }

            var guard = pl.px.size
            while (pl.px.size > 2 && pl.total > pl.len && guard-- > 0) {
                val n = pl.px.size
                pl.total -= hypot(pl.px[n - 2] - pl.px[n - 1], pl.py[n - 2] - pl.py[n - 1])
                pl.px.removeAt(pl.px.size - 1)
                pl.py.removeAt(pl.py.size - 1)
            }
        }

        for (id in toRemove) {
            players.remove(id)
        }
    }
}
