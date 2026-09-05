package com.blocks.game

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

data class PlayerState(
    val id: Int,
    var name: String,
    var colorIdx: Int,
    var patternIdx: Int,
    var isBot: Boolean,
    var kills: Int,
    /** Fresh-spawn shield (broadcast row slot 9). Display-only shimmer. */
    var shield: Boolean,
    /** Render-side boost with hysteresis (velocity-inferred for remotes;
        exact input override for self). Drives the boost glow + spark trail. */
    var boostVis: Boolean,
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
    val killerId: Int = 0,
    val wall: Boolean = false,
)

/** Link spacing — MUST match POINT_SPACING in server/src/config.ts. */
private const val SPACING = 10f
/** Local chain segment cap — mirrors MAX_POINTS on the server (+headroom). */
private const val MAX_LOCAL_SEGS = 900

class GameState {
    var myId = 0
    var halfW = 2400f
    var halfH = 2400f
    var ping = -1L
    var alive = false
    var myKills = 0
    /** Spectate-on-death: camera + interest follow this player while dead. */
    var spectateId = 0
    val players = LinkedHashMap<Int, PlayerState>()
    // Food row: [x, y, colorIdx, isDrop, golden]
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
        spectateId = 0
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
            val r = rows.optJSONArray(i) ?: continue
            val id = r.optInt(0)
            val tx = r.optDouble(1).toFloat()
            val ty = r.optDouble(2).toFloat()
            val ta = r.optDouble(3).toFloat()
            val tlen = r.optDouble(4).toFloat()
            val thick = r.optDouble(5).toFloat()
            val existing = players[id]

            if (existing != null) {
                // Respawn teleport check
                if (hypot(tx - existing.x, ty - existing.y) > 800f) {
                    players[id] = makePlayer(r, now)
                    continue
                }
                val dt = (now - existing.lastRowT).coerceIn(16, 250) / 1000f
                // Velocity EMA (smoothed — drives remote boost-glow inference)
                val rawVx = (tx - existing.tx) / dt
                val rawVy = (ty - existing.ty) / dt
                existing.vx = existing.vx * 0.5f + rawVx * 0.5f
                existing.vy = existing.vy * 0.5f + rawVy * 0.5f
                existing.tx = tx
                existing.ty = ty
                existing.ta = ta
                existing.tlen = tlen
                existing.thick = thick
                existing.kills = r.optInt(10)
                existing.name = r.optString(11, "snake")
                existing.shield = r.optInt(9) == 1
                existing.lastRowT = now
                // Boost hysteresis (band 215–255 vs speeds 170/320)
                val spd = hypot(existing.vx, existing.vy)
                if (!existing.boostVis && spd > 255f) existing.boostVis = true
                else if (existing.boostVis && spd < 215f) existing.boostVis = false
            } else {
                players[id] = makePlayer(r, now)
            }
            if (id == myId) myKills = r.optInt(10)
        }

        // NOTE: absence is NOT death (server interest-filters per client).
        // Players age out via TTL in update().
        if (players.containsKey(myId)) alive = true
    }

    private fun makePlayer(r: JSONArray, now: Long): PlayerState {
        val id = r.optInt(0)
        val tx = r.optDouble(1).toFloat()
        val ty = r.optDouble(2).toFloat()
        val ta = r.optDouble(3).toFloat()
        val tlen = r.optDouble(4).toFloat()
        val thick = r.optDouble(5).toFloat()
        val p = PlayerState(
            id = id,
            name = r.optString(11, "snake"),
            colorIdx = r.optInt(6),
            patternIdx = r.optInt(7),
            isBot = r.optInt(8) == 1,
            kills = r.optInt(10),
            shield = r.optInt(9) == 1,
            boostVis = false,
            tx = tx, ty = ty, ta = ta, tlen = tlen, thick = thick,
            x = tx, y = ty, a = ta, len = tlen,
            lastRowT = now,
        )
        // FULL-length straight seed (mirrors web/state.ts): correct-length body
        // immediately; the follow-sim bends it toward truth as history replays.
        val n = minOf(MAX_LOCAL_SEGS, maxOf(4, (tlen / SPACING).roundToInt()))
        val cx = cos(ta)
        val cy = sin(ta)
        for (k in 0 until n) {
            p.px.add(tx - cx * SPACING * k)
            p.py.add(ty - cy * SPACING * k)
        }
        p.total = (n - 1) * SPACING
        return p
    }

    fun applyBody(json: JSONObject) {
        val rows = json.optJSONArray("p") ?: return
        for (i in 0 until rows.length()) {
            val r = rows.optJSONArray(i) ?: continue
            val id = r.optInt(0)
            val pl = players[id] ?: continue
            val count = r.length() - 1
            if (count >= 4 && count % 2 == 0) {
                val coords = FloatArray(count)
                for (j in 0 until count) {
                    coords[j] = r.optDouble(j + 1).toFloat()
                }
                pl.body = coords
            }
        }
    }

    fun applyDeaths(json: JSONObject) {
        val rows = json.optJSONArray("d") ?: return
        for (i in 0 until rows.length()) {
            val r = rows.optJSONArray(i) ?: continue
            val id = r.optInt(0)
            val pl = players[id]
            if (pl != null) {
                deathFx.add(floatArrayOf(r.optDouble(1).toFloat(), r.optDouble(2).toFloat(), pl.colorIdx.toFloat(), pl.thick))
                players.remove(id)
            }
        }
    }

    fun applyFullFood(json: JSONArray) {
        food.clear()
        for (i in 0 until json.length()) {
            val r = json.optJSONArray(i) ?: continue
            // Row: [id, x, y, colorIdx, isDrop, golden?]
            food[r.optInt(0)] = floatArrayOf(
                r.optDouble(1).toFloat(), r.optDouble(2).toFloat(),
                r.optInt(3).toFloat(), if (r.optInt(4) == 1) 1f else 0f,
                if (r.optInt(5) == 1) 1f else 0f,
            )
        }
    }

    fun applyFoodEvents(json: JSONObject) {
        val keep = json.optJSONArray("k")
        if (keep != null) {
            val next = HashMap<Int, FloatArray>()
            for (i in 0 until keep.length()) {
                val r = keep.optJSONArray(i) ?: continue
                next[r.optInt(0)] = floatArrayOf(
                    r.optDouble(1).toFloat(), r.optDouble(2).toFloat(),
                    r.optInt(3).toFloat(), if (r.optInt(4) == 1) 1f else 0f,
                    if (r.optInt(5) == 1) 1f else 0f,
                )
            }
            food.clear()
            food.putAll(next)
            return
        }
        val spawned = json.optJSONArray("s")
        if (spawned != null) {
            for (i in 0 until spawned.length()) {
                val r = spawned.optJSONArray(i) ?: continue
                food[r.optInt(0)] = floatArrayOf(
                    r.optDouble(1).toFloat(), r.optDouble(2).toFloat(),
                    r.optInt(3).toFloat(), if (r.optInt(4) == 1) 1f else 0f,
                    if (r.optInt(5) == 1) 1f else 0f,
                )
            }
        }
        val removed = json.optJSONArray("r")
        if (removed != null) {
            val me = getSelf()
            for (i in 0 until removed.length()) {
                val id = removed.optInt(i)
                val f = food.remove(id)
                // Only sparkle for food near US (BR purges must not spray FX)
                if (f != null && eatenFx.size < 40) {
                    if (me == null || hypot(f[0] - me.x, f[1] - me.y) < 900f) {
                        eatenFx.add(floatArrayOf(f[0], f[1], f[2]))
                    }
                }
            }
        }
    }

    /**
     * Follow-the-leader chain simulation — IDENTICAL math to the server
     * (server/src/player.ts) and the web mirror (web/src/state.ts):
     * head IS segment 0; each trailing segment is pulled onto the ring of
     * radius SPACING around its predecessor whenever it trails farther.
     * Segments CLOSER than spacing stay bunched — that asymmetry compacts
     * loops exactly like the authority does.
     */
    fun update(dt: Float) {
        val k = 1f - exp(-dt * 22f)
        val now = System.currentTimeMillis()
        val toRemove = mutableListOf<Int>()

        for ((_, pl) in players) {
            // TTL sweep for out-of-view snakes (3 seconds)
            if (now - pl.lastRowT > 3000L) {
                toRemove.add(pl.id)
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

            // Head IS segment 0.
            if (pl.px.isEmpty()) {
                pl.px.add(pl.x)
                pl.py.add(pl.y)
            }
            pl.px[0] = pl.x
            pl.py[0] = pl.y

            val spacingSq = SPACING * SPACING
            for (i in 1 until pl.px.size) {
                val ax = pl.px[i - 1]
                val ay = pl.py[i - 1]
                val dx = pl.px[i] - ax
                val dy = pl.py[i] - ay
                val d2 = dx * dx + dy * dy
                if (d2 > spacingSq) {
                    val dd = sqrt(d2)
                    val kk = SPACING / dd
                    pl.px[i] = ax + dx * kk
                    pl.py[i] = ay + dy * kk
                    pl.total += SPACING - dd
                }
            }

            // Segment-count management toward pl.len — bounded growth keeps
            // big eats organic (new segments slide outward from the tail);
            // shrink follows boost drain. Mirrors web exactly.
            val desired = minOf(MAX_LOCAL_SEGS, maxOf(4, (pl.len / SPACING).roundToInt()))
            var grown = 0
            while (pl.px.size < desired && grown < 2) {
                val m = pl.px.size
                val tx = pl.px[m - 1]
                val ty = pl.py[m - 1]
                var dx = tx - pl.px[m - 2]
                var dy = ty - pl.py[m - 2]
                val dl = hypot(dx, dy).coerceAtLeast(0.001f)
                dx /= dl; dy /= dl
                val ext = minOf(SPACING * 0.6f, dl * 0.5f)
                pl.px.add(tx + dx * ext)
                pl.py.add(ty + dy * ext)
                pl.total += ext
                grown++
            }
            while (pl.px.size > desired && pl.px.size > 4) {
                val m = pl.px.size
                pl.total -= hypot(pl.px[m - 1] - pl.px[m - 2], pl.py[m - 1] - pl.py[m - 2])
                pl.px.removeAt(m - 1)
                pl.py.removeAt(m - 1)
            }
        }

        for (id in toRemove) {
            players.remove(id)
        }
    }
}
