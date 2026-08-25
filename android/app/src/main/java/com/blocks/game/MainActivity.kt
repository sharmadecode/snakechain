package com.blocks.game

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import org.json.JSONObject

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
    private var prefs = MenuPrefs("Player", 0, 0, "ws://10.0.2.2:8787/ws")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sp = getSharedPreferences("blocks", MODE_PRIVATE)
        prefs = MenuPrefs(
            name = sp.getString("name", "Player") ?: "Player",
            color = sp.getInt("color", 0),
            pattern = sp.getInt("pattern", 0),
            server = sp.getString("server", "ws://10.0.2.2:8787/ws") ?: "ws://10.0.2.2:8787/ws",
        )

        setContent {
            when (screen) {
                Screen.Menu -> {
                    MenuScreen(initial = prefs, serverStatus = serverStatus, onPlay = { startGame(it) })
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
                        GameScreen(
                            state = state,
                            net = n,
                            killfeed = killfeed,
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

    override fun onDestroy() {
        net?.close()
        super.onDestroy()
    }

    private fun startGame(p: MenuPrefs) {
        prefs = p
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        getSharedPreferences("blocks", MODE_PRIVATE).edit()
            .putString("name", p.name)
            .putInt("color", p.color)
            .putInt("pattern", p.pattern)
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
        net?.send(
            JSONObject()
                .put("t", "join")
                .put("n", prefs.name)
                .put("c", prefs.color)
                .put("p", prefs.pattern),
        )
    }

    private fun reconnect() {
        connLost = false
        pendingJoin = true
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
                val st = msg.optJSONObject("st")
                if (st != null) {
                    state.dead = DeadStats(
                        kills = st.optInt("kills"),
                        timeMs = st.optLong("timeMs"),
                        maxLen = st.optInt("maxLen"),
                        rank = st.optInt("rank"),
                        killerName = st.optString("killerName", "").ifBlank { null },
                        wall = st.optBoolean("wall", false),
                    )
                    state.alive = false
                }
            }
        }
    }
}
