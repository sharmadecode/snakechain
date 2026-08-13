package com.blocks.game

import android.os.Handler
import android.os.Looper
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
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(6, TimeUnit.SECONDS)
        .build()

    private var ws: WebSocket? = null
    private val main = Handler(Looper.getMainLooper())
    private var closedByUs = false

    fun connect() {
        closedByUs = false
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post { onOpen() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    main.post { onMessage(json) }
                } catch (_: Exception) {
                    // malformed frame: ignore
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { onClose() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { onClose() }
            }
        })
    }

    fun send(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    fun close() {
        closedByUs = true
        ws?.close(1000, "bye")
        ws = null
    }
}
