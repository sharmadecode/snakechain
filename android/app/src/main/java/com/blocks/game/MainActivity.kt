package com.blocks.game

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import org.json.JSONObject
import kotlin.math.hypot

private enum class Screen { Menu, Game }

class MainActivity : ComponentActivity() {

    private val state = GameState()
    private val killfeed = mutableStateListOf<KfEntry>()
    private var net: NetClient? = null
    private var screen by mutableStateOf(Screen.Menu)
    private var connLost by mutableStateOf(false)
    private var serverStatus by mutableStateOf("server: offline")
    private var pendingJoin = false
    private var quitting = false
    private var prefs = MenuPrefs("Player", 0, 0, "classic", "ws://10.0.2.2:8787/ws")

    // Lifetime progression (personal bests) + champion announcement
    private var menuStats by mutableStateOf("")
    private var pbBanner by mutableStateOf<String?>(null)
    private var pbBest by mutableIntStateOf(0)
    private var champion by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sp = getSharedPreferences("blocks", MODE_PRIVATE)
        val savedMode = if (sp.getString("mode", "classic") == "br") "br" else "classic"
        prefs = MenuPrefs(
            name = sp.getString("name", "Player") ?: "Player",
            color = sp.getInt("color", 0),
            pattern = sp.getInt("pattern", 0),
            mode = savedMode,
            server = sp.getString("server", "ws://10.0.2.2:8787/ws") ?: "ws://10.0.2.2:8787/ws",
        )
        // Lifetime stats load (strict numeric guards)
        val bestLen = sp.getInt("bestLen", 0).coerceAtLeast(0)
        val mostKills = sp.getInt("mostKills", 0).coerceAtLeast(0)
        val games = sp.getInt("games", 0).coerceAtLeast(0)
        menuStats = if (games > 0)
            "PERSONAL BEST $bestLen · TOP KILLS $mostKills · GAMES $games" else ""
        pbBest = bestLen

        setContent {
            when (screen) {
                Screen.Menu -> {
                    LaunchedEffect(Unit) {
                        while (true) {
                            delay(15000)
                            refreshOnlineCount()
                        }
                    }
                    LaunchedEffect(Unit) { refreshOnlineCount() }
                    MenuScreen(initial = prefs, serverStatus = serverStatus, menuStats = menuStats, onPlay = { startGame(it) })
                }
                Screen.Game -> {
                    val n = net
                    if (n != null) {
                        LaunchedEffect(Unit) {
                            while (true) {
                                delay(1000)
                                val now = System.currentTimeMillis()
                                killfeed.removeAll { now - it.ts > 5000 }
                            }
                        }
                        LaunchedEffect(champion) {
                            if (champion != null) {
                                delay(4500)
                                champion = null
                            }
                        }
                        GameScreen(
                            state = state,
                            net = n,
                            killfeed = killfeed,
                            champion = champion,
                            pbBanner = pbBanner,
                            pbBest = pbBest,
                            onQuit = { quitGame() },
                            onRespawn = { sendJoin() },
                            onReconnect = { reconnect() },
                            connLost = connLost,
                        )
                    }
                }
            }
        }
    }

    /** Live arena count from /health (same origin as the game socket host). */
    private fun refreshOnlineCount() {
        val wsUrl = prefs.server.ifBlank { "ws://10.0.2.2:8787/ws" }
        val httpUrl = wsUrl.replace("ws://", "http://").replace("/ws", "/health").replace(":8787/health", ":8787/health")
        NetClient.fetchHealth(httpUrl) { alive ->
            if (alive >= 0) {
                serverStatus = "$alive IN ARENA"
            } else {
                serverStatus = "server: offline"
            }
        }
    }

    override fun onDestroy() {
        net?.close()
        super.onDestroy()
    }

    /** Viewport radius for interest filtering — same formula as the web client
        at the renderer zoom floor (0.62): half-diagonal of the display. */
    private fun viewRadius(): Int {
        val dm = resources.displayMetrics
        return (hypot(dm.widthPixels.toFloat(), dm.heightPixels.toFloat()) / 2f / 0.62f).toInt().coerceIn(800, 3600)
    }

    private fun startGame(p: MenuPrefs) {
        prefs = p
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        getSharedPreferences("blocks", MODE_PRIVATE).edit()
            .putString("name", p.name)
            .putInt("color", p.color)
            .putInt("pattern", p.pattern)
            .putString("mode", p.mode)
            .putString("server", p.server)
            .apply()

        state.reset()
        killfeed.clear()
        connLost = false
        pendingJoin = true
        quitting = false
        screen = Screen.Game

        val n = NetClient(
            url = p.server.ifBlank { "ws://10.0.2.2:8787/ws" },
            onMessage = { handleMessage(it) },
            onOpen = {
                serverStatus = "server: connected"
                if (pendingJoin) sendJoin()
            },
            onClose = {
                pendingJoin = false
                serverStatus = "server: offline"
                if (screen == Screen.Game && !quitting) connLost = true
            },
        )
        net = n
        n.connect()
    }

    private fun sendJoin() {
        pendingJoin = false
        state.dead = null
        state.spectateId = 0
        net?.send(
            JSONObject()
                .put("t", "join")
                .put("n", prefs.name)
                .put("c", prefs.color)
                .put("p", prefs.pattern)
                .put("v", viewRadius())
                .put("mo", prefs.mode),
        )
    }

    private fun reconnect() {
        connLost = false
        pendingJoin = true
        state.spectateId = 0
        net?.connect()
    }

    private fun quitGame() {
        quitting = true
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        net?.close()
        net = null
        screen = Screen.Menu
    }

    private fun handleMessage(msg: JSONObject) {
        when (msg.optString("t")) {
            "hi" -> {
                state.myId = msg.optInt("id")
                val w = msg.optJSONArray("w")
                if (w != null) {
                    state.halfW = w.optDouble(0, 2400.0).toFloat()
                    state.halfH = w.optDouble(1, 2400.0).toFloat()
                }
                connLost = false
                // Report our viewport once so interest filtering matches the screen
                net?.send(JSONObject().put("t", "view").put("r", viewRadius()))
            }
            "foods" -> {
                val f = msg.optJSONArray("f") ?: return
                state.applyFullFood(f)
            }
            "f" -> state.applyFoodEvents(msg)
            "s" -> state.applyState(msg)
            "b" -> state.applyBody(msg)
            "df" -> state.applyDeaths(msg)
            "lb" -> {
                val l = msg.optJSONArray("l") ?: return
                state.leaderboard = (0 until l.length()).mapNotNull { l.optJSONArray(it) }
            }
            "champ" -> {
                val n = msg.optString("n", "").take(20)
                if (n.isNotBlank()) champion = n
            }
            "kf" -> {
                val k = msg.optJSONArray("k") ?: return
                for (i in 0 until k.length()) {
                    val e = k.optJSONArray(i) ?: continue
                    val killerId = e.optInt(0, -1)
                    val victimName = e.optString(2, "")
                    if (killerId == state.myId && victimName.isNotBlank()) {
                        val text = "⚔ YOU ELIMINATED ${victimName.uppercase()}"
                        killfeed.add(0, KfEntry(text, System.currentTimeMillis()))
                    }
                }
            }
            "pong" -> {
                val n = msg.optLong("n", 0L)
                if (n > 0) state.ping = System.currentTimeMillis() - n
            }
            "dead" -> {
                val st = msg.optJSONObject("st") ?: return
                val killerId = st.optInt("killerId", 0)
                state.dead = DeadStats(
                    kills = st.optInt("kills"),
                    timeMs = st.optLong("timeMs"),
                    maxLen = st.optInt("maxLen"),
                    rank = st.optInt("rank"),
                    killerName = st.optString("killerName", "").ifBlank { null },
                    killerId = killerId,
                    wall = st.optBoolean("wall", false),
                )
                state.alive = false
                // Spectate-on-death: camera follows the killer; tell the server
                // to center interest streaming on it (else it stops after ~3s).
                state.spectateId = killerId
                if (killerId > 0) {
                    net?.send(JSONObject().put("t", "view").put("r", viewRadius()).put("tg", killerId))
                }
                val ds = state.dead
                if (ds != null) recordDeath(ds)
            }
        }
    }

    /** Merge a finished game into lifetime stats and raise PB banners. */
    private fun recordDeath(st: DeadStats) {
        val sp = getSharedPreferences("blocks", MODE_PRIVATE)
        val games = (sp.getInt("games", 0)) + 1
        var bestLen = sp.getInt("bestLen", 0)
        var mostKills = sp.getInt("mostKills", 0)
        val newBest = st.maxLen > bestLen && st.maxLen > 0
        val newKills = st.kills > mostKills && st.kills > 0
        if (newBest) bestLen = st.maxLen
        if (newKills) mostKills = st.kills
        sp.edit()
            .putInt("games", games)
            .putInt("bestLen", bestLen)
            .putInt("mostKills", mostKills)
            .apply()

        pbBest = bestLen
        pbBanner = when {
            newBest -> "🏆 NEW PERSONAL BEST LENGTH — ${st.maxLen}"
            newKills -> "⚔ NEW MOST-KILLS RECORD — ${st.kills}"
            else -> null
        }
        menuStats = if (games > 0)
            "PERSONAL BEST $bestLen · TOP KILLS $mostKills · GAMES $games" else ""
    }
}
