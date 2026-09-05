package com.blocks.game

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Thin OkHttp WebSocket wrapper. All callbacks fire on the main thread. */
class NetClient(
    private val url: String,
    private val onMessage: (JSONObject) -> Unit,
    private val onOpen: () -> Unit,
    private val onClose: () -> Unit,
) {
    private var ws: WebSocket? = null
    private val main = Handler(Looper.getMainLooper())

    /** Bumped on every connect()/close(): callbacks from superseded sockets
        are ignored, so a reconnect can never be clobbered by the old
        socket's late onFailure/onClosed (ghost "connection lost"). */
    private var generation = 0

    fun connect() {
        generation++
        val gen = generation
        // Supersede any previous socket: without cancel() two live sockets
        // would race (double join, duplicate callbacks, leaked connection).
        ws?.cancel()
        ws = null

        val request = Request.Builder().url(url).build()
        ws = sharedClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != generation) return
                main.post { if (gen == generation) onOpen() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation) return
                try {
                    val json = JSONObject(text)
                    main.post { if (gen == generation) dispatchSafely(json) }
                } catch (_: Exception) {
                    // malformed frame: ignore
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen != generation) return
                main.post { if (gen == generation) onClose() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != generation) return
                main.post { if (gen == generation) onClose() }
            }
        })
    }

    private fun dispatchSafely(json: JSONObject) {
        try {
            onMessage(json)
        } catch (e: Exception) {
            // One unexpected frame must never crash the app.
            Log.w("NetClient", "dropped unhandled message: ${e.message}")
        }
    }

    fun send(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    fun close() {
        generation++
        ws?.close(1000, "bye")
        ws = null
    }

    companion object {
        /** One client per process (per OkHttp guidance) — a client per game
            session leaked dispatcher threads and connection pool entries. */
        private val sharedClient = OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(6, TimeUnit.SECONDS)
            .build()

        private val main = Handler(Looper.getMainLooper())

        /** Async GET /health → parses "alive" (−1 on any failure). Used by the
            menu's IN-ARENA counter; runs on OkHttp's dispatcher, posts to main. */
        fun fetchHealth(url: String, onResult: (Int) -> Unit) {
            sharedClient.newCall(Request.Builder().url(url).build()).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    main.post { onResult(-1) }
                }

                override fun onResponse(call: okhttp3.Call, response: Response) {
                    val alive = try {
                        val body = response.body?.string() ?: "{}"
                        JSONObject(body).optInt("alive", -1)
                    } catch (_: Exception) {
                        -1
                    } finally {
                        response.close()
                    }
                    main.post { onResult(alive) }
                }
            })
        }
    }
}
