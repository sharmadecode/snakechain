package com.blocks.game

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Color as AColor
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.TextPaint
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

private class Particle(
    var x: Float, var y: Float, var vx: Float, var vy: Float,
    var life: Float, var max: Float, var size: Float, var color: Int,
)

private data class Joystick(val base: Offset = Offset.Unspecified, val vec: Offset = Offset.Zero, val active: Boolean = false)

data class KfEntry(val text: String, val ts: Long)

@Composable
fun GameScreen(
    state: GameState,
    net: NetClient,
    killfeed: androidx.compose.runtime.snapshots.SnapshotStateList<KfEntry>,
    onQuit: () -> Unit,
    onRespawn: () -> Unit,
    onReconnect: () -> Unit,
    connLost: Boolean,
    champion: String? = null,
    pbBanner: String? = null,
    pbBest: Int = 0,
) {
    var frame by remember { mutableIntStateOf(0) }
    // ~4Hz refresh signal for the HUD subtree: recomposing every Text at
    // 60Hz (via `frame`) was wasted work — only the Canvas needs per-frame.
    var hudTick by remember { mutableIntStateOf(0) }
    var rawTicks = 0
    var joystick by remember { mutableStateOf(Joystick()) }
    var boostActive by remember { mutableStateOf(false) }
    var lastInputNanos by remember { mutableLongStateOf(0L) }
    var lastAngle by remember { mutableFloatStateOf(0f) }
    val particles = remember { mutableStateListOf<Particle>() }
    val density = LocalDensity.current
    val context = LocalContext.current
    val vibrator = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? android.os.VibratorManager
            vm?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    // Joystick metrics in px derived from dp — raw px made the stick ~half
    // size on xxhdpi screens. Insets read live via safeDrawing so the ring
    // clears the navigation bar and any display cutout instead of freezing
    // at first composition.
    val safeInsets = WindowInsets.safeDrawing
    val layoutDir = LocalLayoutDirection.current
    val bottomInsetPx = { safeInsets.getBottom(density) }
    val leftInsetPx = { safeInsets.getLeft(density, layoutDir) }
    val joyMaxR = { with(density) { 70.dp.toPx() } }
    val joyThumbR = { with(density) { 32.dp.toPx() } }

    val ground = remember { makeGround() }
    val groundPaint = remember { Paint().apply { shader = BitmapShader(ground, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT) } }
    val groundMatrix = remember { android.graphics.Matrix() }
    var vignetteDims by remember { mutableFloatStateOf(0f) }
    val vignettePaint = remember { Paint() }

    // Reused per-frame draw buffers (no steady-state allocation).
    val sortBuf = remember { ArrayList<PlayerState>(64) }

    // Smoothed camera (exp follow) with spectate fallback: SELF → killer → frozen.
    var camX by remember { mutableFloatStateOf(0f) }
    var camY by remember { mutableFloatStateOf(0f) }
    var camZoom by remember { mutableFloatStateOf(1f) }
    var camInit by remember { mutableStateOf(false) }

    // Pre-rendered additive boost-glow blooms (one per palette color).
    val boostGlows = remember { Array(12) { i -> glowBmpFor(Palette.COLORS[i]) } }

    val namePaint = remember {
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textSize = 26f
            style = Paint.Style.FILL
        }
    }
    val nameStroke = remember {
        TextPaint(namePaint).apply {
            style = Paint.Style.STROKE
            strokeWidth = 6f
            color = 0xE6080B18.toInt()
        }
    }

    val sharedPaint = remember { Paint(Paint.ANTI_ALIAS_FLAG) }

    LaunchedEffect(Unit) {
        var lastNs = 0L
        while (true) {
            withFrameNanos { ns ->
                val dt = if (lastNs == 0L) 0.016f else ((ns - lastNs) / 1_000_000_000f).coerceIn(0f, 0.1f)
                lastNs = ns

                // The world keeps simulating while dead/joining: other snakes
                // stay live behind the overlays and the TTL sweep keeps
                // running (gating on `alive` froze the whole arena).
                state.update(dt)

                // Camera: SELF → spectate target (death-cam) → frozen last view.
                // Exponential follow (same feel as the web client); snaps on
                // teleports >3000u so respawns never pan across the arena.
                val selfCam = state.getSelf()
                val spec = if (!state.alive && state.spectateId != 0) {
                    state.players[state.spectateId]
                } else null
                val fx: Float
                val fy: Float
                val flen: Float
                when {
                    selfCam != null -> { fx = selfCam.x; fy = selfCam.y; flen = selfCam.len }
                    spec != null -> { fx = spec.x; fy = spec.y; flen = spec.len }
                    else -> { fx = Float.NaN; fy = Float.NaN; flen = 0f }
                }
                if (!fx.isNaN()) {
                    val tz = max(0.62f, min(1.55f, 1.55f - flen / 3200f))
                    if (!camInit || hypot(fx - camX, fy - camY) > 3000f) {
                        camX = fx; camY = fy; camZoom = tz; camInit = true
                    } else {
                        val cf = 1f - exp(-dt * 8f)
                        camX += (fx - camX) * cf
                        camY += (fy - camY) * cf
                        camZoom += (tz - camZoom) * (1f - exp(-dt * 4f))
                    }
                }

                // Consume death FX to particles
                if (state.deathFx.isNotEmpty()) {
                    for (df in state.deathFx) {
                        val col = Palette.base(df[2].toInt())
                        for (i in 0 until 24) {
                            val a = (i / 24f) * (2 * PI).toFloat() + (Random.nextFloat() - 0.5f) * 0.5f
                            val sp = 60f + Random.nextFloat() * 240f
                            if (particles.size < 350) {
                                particles.add(
                                    Particle(
                                        x = df[0], y = df[1],
                                        vx = cos(a) * sp, vy = sin(a) * sp,
                                        life = 0f, max = 0.6f + Random.nextFloat() * 0.4f,
                                        size = 3f + Random.nextFloat() * 4f, color = col,
                                    )
                                )
                            }
                        }
                    }
                    state.deathFx.clear()
                }

                // Consume eat FX to particles
                if (state.eatenFx.isNotEmpty()) {
                    for (ef in state.eatenFx) {
                        val col = Palette.base(ef[2].toInt())
                        if (particles.size < 350) {
                            particles.add(
                                Particle(
                                    x = ef[0], y = ef[1],
                                    vx = (Random.nextFloat() - 0.5f) * 80f,
                                    vy = -60f - Random.nextFloat() * 80f,
                                    life = 0f, max = 0.35f,
                                    size = 2.5f + Random.nextFloat() * 2f, color = col,
                                )
                            )
                        }
                    }
                    state.eatenFx.clear()
                }

                if (state.alive) {
                    val ang = if (joystick.active && joystick.vec.getDistance() > 14f) {
                        kotlin.math.atan2(joystick.vec.y, joystick.vec.x).toFloat()
                    } else null

                    if (ang != null) {
                        val self = state.getSelf()
                        val turnFalloff = 800f
                        val f = (self?.len ?: 100f) / turnFalloff
                        val maxTurnRate = 6.0f - (6.0f - 2.8f) * f.coerceIn(0f, 1f)
                        var d = ang - lastAngle
                        val twoPi = (2 * PI).toFloat()
                        while (d > PI.toFloat()) d -= twoPi
                        while (d < -PI.toFloat()) d += twoPi
                        val maxD = maxTurnRate * dt
                        lastAngle += d.coerceIn(-maxD, maxD)
                    }

                    if (ns - lastInputNanos >= 33_000_000L) {
                        lastInputNanos = ns
                        val a = ((lastAngle * 1000).toInt()) / 1000f
                        net.send(JSONObject().put("t", "input").put("a", a.toDouble()).put("b", boostActive))
                    }

                    // Exact boost state for SELF (remotes infer via velocity
                    // hysteresis in GameState.applyState). Server truth: boost
                    // only works above BOOST_MIN_LENGTH (45).
                    val selfNow = state.getSelf()
                    selfNow?.let { it.boostVis = boostActive && it.len > 45f }
                } else {
                    boostActive = false
                }
                updateParticles(particles, dt)
                frame++
                rawTicks++
                if (rawTicks % 15 == 0) hudTick++
            }
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(5000)
            net.send(JSONObject().put("t", "ping").put("n", System.currentTimeMillis()))
        }
    }

    BackHandler(onBack = onQuit)

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF080B18))
            .pointerInput(Unit) {
                val joyX = with(density) { 100.dp.toPx() } + leftInsetPx()
                val joyY = size.height - with(density) { 96.dp.toPx() } - bottomInsetPx()
                val maxR = joyMaxR()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (state.alive && down.position.x < size.width * 0.75f) {
                        val base = Offset(joyX, joyY)
                        joystick = Joystick(base = base, vec = Offset.Zero, active = true)
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            val dx = change.position.x - joyX
                            val dy = change.position.y - joyY
                            val len = hypot(dx, dy)
                            joystick = if (len > maxR) {
                                Joystick(base, Offset(dx / len * maxR, dy / len * maxR), true)
                            } else {
                                Joystick(base, Offset(dx, dy), true)
                            }
                        }
                        joystick = Joystick()
                    }
                }
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val tick = frame
            if (tick < 0) return@Canvas
            val zoom = camZoom
            val w = size.width
            val h = size.height

            val sx = { wx: Float -> (wx - camX) * zoom + w / 2 }
            val sy = { wy: Float -> (wy - camY) * zoom + h / 2 }

            // 1. Arena Ground Grid (reused Matrix — one object per frame was churn)
            groundMatrix.reset()
            groundMatrix.setTranslate(-(camX * zoom % 256f), -(camY * zoom % 256f))
            groundPaint.shader?.setLocalMatrix(groundMatrix)
            drawContext.canvas.nativeCanvas.drawRect(0f, 0f, w, h, groundPaint)

            val viewR = hypot(w, h) / (2f * zoom) + 120f

            // 2. Circular Arena Boundary
            drawCircularWall(state, sx, sy, zoom)

            // 3. Glowing Food Orbs
            drawFood(state, viewR, camX, camY, sx, sy, zoom, sharedPaint)

            // 4. Snake Bodies (depth sorted by length; reused buffer)
            sortBuf.clear()
            sortBuf.addAll(state.players.values)
            sortBuf.sortBy { it.len }
            val viewR2 = viewR * viewR
            for (pl in sortBuf) {
                if (!snakeInView(pl, camX, camY, viewR2)) continue
                drawSlitherBody(pl, sx, sy, zoom, sharedPaint)
            }

            // 5. Snake Heads & Googly Eyes
            val leaderId = if (state.leaderboard.isNotEmpty()) state.leaderboard[0].optInt(0, -1) else -1
            for (pl in sortBuf) {
                if (!snakeInView(pl, camX, camY, viewR2)) continue
                drawSlitherHead(pl, sx, sy, zoom, pl.id == state.myId, pl.id == leaderId, namePaint, nameStroke, sharedPaint)

                // Boost spark trail
                if (pl.boostVis && particles.size < 350) {
                    val back = pl.a + PI.toFloat()
                    val c = Palette.base(pl.colorIdx)
                    val spread = (Random.nextFloat() - 0.5f) * 1.4f
                    val d = back + spread
                    particles.add(
                        Particle(
                            x = pl.x + cos(d) * pl.thick * 0.5f,
                            y = pl.y + sin(d) * pl.thick * 0.5f,
                            vx = cos(d) * -60f,
                            vy = sin(d) * -60f,
                            life = 0f,
                            max = 0.3f + Random.nextFloat() * 0.2f,
                            size = 2.5f + Random.nextFloat() * 3f,
                            color = Palette.shade(c, 0.4f),
                        )
                    )
                }
            }

            // 6. Particles
            drawParticles(particles, sx, sy, zoom, sharedPaint)

            // 7. Ambient Vignette
            if (vignetteDims != w * h) {
                vignetteDims = w * h
                vignettePaint.shader = RadialGradient(
                    w / 2f, h / 2f, max(w, h) * 0.78f,
                    intArrayOf(0x00000000, 0xA604060E.toInt()),
                    floatArrayOf(0.4f, 1f),
                    Shader.TileMode.CLAMP,
                )
            }
            drawContext.canvas.nativeCanvas.drawRect(0f, 0f, w, h, vignettePaint)

            // 8. Virtual Joystick
            val joyX = with(density) { 100.dp.toPx() } + leftInsetPx()
            val joyY = h - with(density) { 96.dp.toPx() } - bottomInsetPx()
            val jR = joyMaxR()
            val tR = joyThumbR()
            drawCircle(Color(0x59FFF8E7), jR, Offset(joyX, joyY), style = androidx.compose.ui.graphics.drawscope.Stroke(3f))
            if (joystick.active) {
                drawCircle(Color(0xD9FFD93D), tR, Offset(joyX, joyY) + joystick.vec)
                drawCircle(Color(0xD9FFFFFF), tR, Offset(joyX, joyY) + joystick.vec, style = androidx.compose.ui.graphics.drawscope.Stroke(2f))
            }
        }

        HUD(
            state = state,
            killfeed = killfeed,
            refresh = hudTick,
            boostActive = boostActive,
            champion = champion,
            onBoostChange = {
                if (state.alive) {
                    boostActive = it
                    if (it) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                vibrator?.vibrate(VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE))
                            } else {
                                @Suppress("DEPRECATION")
                                vibrator?.vibrate(20)
                            }
                        } catch (_: Exception) {}
                    }
                }
            },
            onQuit = onQuit,
        )

        if (state.dead != null && !state.alive) {
            val spectating = (state.dead?.killerId ?: 0) > 0
            DeathOverlay(state.dead!!, onRespawn, pbBanner, pbBest, spectating)
        }
        if (connLost) {
            ConnLostOverlay(onReconnect, onQuit)
        }
        if (!state.alive && state.dead == null && !connLost) {
            JoiningOverlay()
        }
    }
}

@Composable
private fun HUD(
    state: GameState,
    killfeed: List<KfEntry>,
    refresh: Int,
    boostActive: Boolean,
    onBoostChange: (Boolean) -> Unit,
    onQuit: () -> Unit,
    champion: String?,
) {
    Box(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        val f = refresh
        if (f < 0) return@Box

        // Top Left: Translucent Minimap & Minimal Length (+ping)
        val self = state.getSelf()
        Column(
            Modifier
                .align(Alignment.TopStart)
                .padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(Modifier.size(96.dp).clip(CircleShape)) {
                Minimap(state, refresh)
            }
            if (self != null) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0x73050B16))
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                ) {
                    Text("${self.len.toInt()}", color = Color(0xFFFFD93D), fontSize = 11.sp, fontWeight = FontWeight.Black)
                }
            }
            if (state.ping > 0) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0x73050B16))
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                ) {
                    Text("${state.ping}ms", color = Color(0xCCFFF8E7), fontSize = 8.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Top Right: back-to-lobby + compact transparent leaderboard
        Row(
            Modifier
                .align(Alignment.TopEnd)
                // NOTE: root HUD Box already applies safeDrawing insets — do NOT
                // re-apply here or content double-offsets on notched phones.
                .padding(start = 8.dp, top = 2.dp, end = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            // Back-to-lobby (mobile parity with the web HUD ✕)
            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(Color(0x66050B16))
                    .clickable(onClick = onQuit),
                contentAlignment = Alignment.Center,
            ) {
                Text("✕", color = Color(0xD9FFF8E7), fontSize = 13.sp, fontWeight = FontWeight.Black)
            }

            if (state.leaderboard.isNotEmpty()) {
                Column(
                    Modifier
                        .widthIn(min = 104.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color(0x61050B16))
                        .padding(horizontal = 9.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    state.leaderboard.take(3).forEach { row ->
                        val id = row.optInt(0)
                        val name = row.optString(1, "...")
                        val len = row.optDouble(2, 0.0).toInt()
                        val colorIdx = row.optInt(4, 0)
                        val isMe = id == state.myId
                        val nameCol = if (isMe) Color(0xFFFFD93D) else Color(0xFFFFF8E7)
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.weight(1f),
                            ) {
                                Box(
                                    Modifier
                                        .size(5.dp)
                                        .clip(CircleShape)
                                        .background(Color(Palette.base(colorIdx))),
                                )
                                Text(
                                    name,
                                    color = nameCol,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Text(
                                "$len",
                                color = if (isMe) Color(0xFFFFD93D) else Color(0xBFFFFFFF),
                                fontSize = 9.sp,
                                fontWeight = FontWeight.Black,
                            )
                        }
                    }
                }
            }
        }

        // Bottom Right: Boost Button
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 20.dp, bottom = 20.dp),
        ) {
            BoostButton(active = boostActive, onBoostChange = onBoostChange)
        }

        // Killfeed (Center Top - User Only)
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .padding(top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            killfeed.take(2).forEach { kf ->
                Box(
                    Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color(0xFFFFD93D))
                        .border(2.dp, Color(Palette.INK), RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(kf.text, color = Color(Palette.INK), fontSize = 11.sp, fontWeight = FontWeight.Black)
                }
            }
        }

        // BR Collapse Champion Banner (below killfeed, auto-clears from MainActivity)
        val champName = champion
        if (champName != null) {
            Box(
                Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 96.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color(0xFF86EF2E))
                    .border(2.dp, Color(Palette.INK), RoundedCornerShape(10.dp))
                    .padding(horizontal = 18.dp, vertical = 6.dp),
            ) {
                Text(
                    "👑 ${champName.uppercase()} CONQUERED THE COLLAPSE",
                    color = Color(0xFF080B18),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Black,
                )
            }
        }
    }
}

@Composable
private fun Minimap(state: GameState, refresh: Int) {
    Canvas(Modifier.fillMaxSize()) {
        if (refresh < 0) return@Canvas // keep the refresh param read live
        val cx = size.width / 2f
        val cy = size.height / 2f
        val radarR = size.width / 2f - 3f

        drawCircle(Color(0xFF070A16), radarR, Offset(cx, cy))
        drawCircle(Color(0xFFFF3366), radarR, Offset(cx, cy), style = androidx.compose.ui.graphics.drawscope.Stroke(2f))

        val radScale = radarR / state.halfW.coerceAtLeast(1f)
        val mapX = { wx: Float -> cx + wx * radScale }
        val mapY = { wy: Float -> cy + wy * radScale }

        for (pl in state.players.values) {
            if (pl.id == state.myId) continue
            val x = mapX(pl.x)
            val y = mapY(pl.y)
            drawCircle(Color(Palette.base(pl.colorIdx)), 2.5f, Offset(x, y))
        }

        val me = state.getSelf()
        if (me != null) {
            val mx = mapX(me.x)
            val my = mapY(me.y)
            drawCircle(Color(0xFFFFD700), 4.5f, Offset(mx, my))
            drawCircle(Color.White, 6.5f, Offset(mx, my), style = androidx.compose.ui.graphics.drawscope.Stroke(1.5f))
        }
    }
}

@Composable
private fun BoostButton(active: Boolean, onBoostChange: (Boolean) -> Unit) {
    Box(
        Modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(if (active) Color(0xFFFF3B30) else Color(0xE2FF5722))
            .border(2.dp, Color(0xFF141414), CircleShape)
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    onBoostChange(true)
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                    }
                    onBoostChange(false)
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (active) "BOOST" else "BOOST",
            color = Color.White,
            fontSize = 14.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 1.sp,
        )
    }
}

@Composable
private fun DeathOverlay(
    st: DeadStats,
    onRespawn: () -> Unit,
    pbText: String? = null,
    pbBest: Int = 0,
    spectating: Boolean = false,
) {
    // Spectating: translucent overlay so the killer-cam action stays watchable
    Box(Modifier.fillMaxSize().background(Color(if (spectating) 0x5904060E else 0xB304060E)), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .width(320.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xEE0C1020))
                .border(1.dp, Color(0xFFFF3366), RoundedCornerShape(16.dp))
                .padding(24.dp),
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "SNAKE ELIMINATED",
                    color = Color(0xFFFF3366),
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 1.5.sp,
                )
                Spacer(Modifier.height(6.dp))
                if (pbText != null) {
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color(0xFF86EF2E))
                            .border(1.dp, Color(0xFF141414), RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    ) {
                        Text(pbText, color = Color(0xFF080B18), fontSize = 10.sp, fontWeight = FontWeight.Black)
                    }
                }
                val killerText = if (st.wall) "CRASHED INTO ARENA BOUNDARY"
                                 else if (!st.killerName.isNullOrBlank()) "ELIMINATED BY ${st.killerName.uppercase()}"
                                 else "ELIMINATED IN COMBAT"
                Box(
                    Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color(0xFFFFD93D))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                ) {
                    Text(killerText, color = Color(0xFF141414), fontSize = 11.sp, fontWeight = FontWeight.Black)
                }
                Spacer(Modifier.height(14.dp))
                val mins = st.timeMs / 60000
                val secs = (st.timeMs % 60000) / 1000
                StatRow("Time Alive", "$mins m ${secs}s")
                StatRow("Kills", "${st.kills}")
                if (pbBest > 0) {
                    StatRow("Max Length · PB $pbBest", "${st.maxLen}")
                } else {
                    StatRow("Max Length", "${st.maxLen}")
                }
                StatRow("Final Rank", "#${st.rank}")
                Spacer(Modifier.height(18.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xFF00E676))
                        .clickable(onClick = onRespawn)
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("RESPAWN", color = Color(0xFF080B18), fontSize = 16.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                }
            }
        }
    }
}

@Composable
private fun StatRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = Color(0x99FFFFFF), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(value, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun ConnLostOverlay(onReconnect: () -> Unit, onQuit: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0xB304060E)), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .width(300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(Color(0xEE0C1020))
                .border(1.dp, Color(0xFFFF3366), RoundedCornerShape(16.dp))
                .padding(24.dp),
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("CONNECTION LOST", color = Color(0xFFFF3366), fontSize = 20.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                Spacer(Modifier.height(16.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xFF00D2FF))
                        .clickable(onClick = onReconnect)
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("RECONNECT", color = Color(0xFF080B18), fontSize = 15.sp, fontWeight = FontWeight.Black)
                }
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .border(1.dp, Color(0x66FFFFFF), RoundedCornerShape(10.dp))
                        .clickable(onClick = onQuit)
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("QUIT TO MENU", color = Color(0xCCFFFFFF), fontSize = 13.sp, fontWeight = FontWeight.Black)
                }
            }
        }
    }
}

@Composable
private fun JoiningOverlay() {
    Box(Modifier.fillMaxSize().background(Color(0xB304060E)), contentAlignment = Alignment.Center) {
        Text(
            "entering arena…",
            color = Color(0xFF00D2FF),
            fontSize = 18.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 2.sp,
        )
    }
}

private fun makeGround(): Bitmap {
    val s = 256
    val bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
    val c = android.graphics.Canvas(bmp)
    c.drawColor(AColor.rgb(5, 11, 24)) // Deep dark navy playfield (matches web #050B18)
    // Faint grid — matches the web floor pattern (alpha ~2.5%)
    val gp = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
        color = AColor.argb(7, 148, 163, 255)
    }
    var i = 0f
    while (i <= s) {
        c.drawLine(i, 0f, i, s.toFloat(), gp)
        c.drawLine(0f, i, s.toFloat(), i, gp)
        i += 64f
    }
    return bmp
}

/** Additive boost-glow bloom bitmap for a palette color (cached per color). */
private val glowBmps = HashMap<Int, Bitmap>()
private val glowAddPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply {
    xfermode = PorterDuffXfermode(PorterDuff.Mode.ADD)
}

private fun glowBmpFor(color: Int): Bitmap =
    glowBmps.getOrPut(color) {
        val s = 128
        val bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
        val g = android.graphics.Canvas(bmp)
        val rg = RadialGradient(
            s / 2f, s / 2f, s / 2f,
                intArrayOf(Palette.shade(color, 0.35f), Palette.shade(color, -0.15f), 0x00000000),
            floatArrayOf(0f, 0.45f, 1f),
            Shader.TileMode.CLAMP,
        )
        g.drawCircle(s / 2f, s / 2f, s / 2f, Paint().apply { shader = rg })
        bmp
    }

/**
 * View test covering the snake's FULL extent: head, local path, and the
 * authoritative body samples. A long snake whose head is off-screen can
 * still have its body crossing the view — and that body is lethal
 * (server collision is authoritative). Culling by head alone rendered
 * such snakes invisible while they could still kill you.
 */
private fun snakeInView(pl: PlayerState, camX: Float, camY: Float, viewR2: Float): Boolean {
    val dxh = pl.x - camX
    val dyh = pl.y - camY
    if (dxh * dxh + dyh * dyh <= viewR2) return true
    var i = 0
    while (i < pl.px.size) {
        val dx = pl.px[i] - camX
        val dy = pl.py[i] - camY
        if (dx * dx + dy * dy <= viewR2) return true
        i += 6
    }
    val b = pl.body ?: return false
    i = 0
    while (i + 1 < b.size) {
        val dx = b[i] - camX
        val dy = b[i + 1] - camY
        if (dx * dx + dy * dy <= viewR2) return true
        i += 12
    }
    return false
}

private fun updateParticles(list: MutableList<Particle>, dt: Float) {
    for (i in list.size - 1 downTo 0) {
        val p = list[i]
        p.life += dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.life >= p.max) list.removeAt(i)
    }
}

private fun DrawScope.drawCircularWall(
    state: GameState, sx: (Float) -> Float, sy: (Float) -> Float, zoom: Float,
) {
    val cx = sx(0f)
    val cy = sy(0f)
    val rad = state.halfW * zoom

    drawCircle(
        Color(0x33FF3366), rad + 40f * zoom, Offset(cx, cy),
        style = androidx.compose.ui.graphics.drawscope.Stroke(20f * zoom),
    )
    drawCircle(
        Color(0xFFFF3366), rad, Offset(cx, cy),
        style = androidx.compose.ui.graphics.drawscope.Stroke(4f * max(1f, zoom)),
    )
}

private fun DrawScope.drawFood(
    state: GameState, viewR: Float, camX: Float, camY: Float,
    sx: (Float) -> Float, sy: (Float) -> Float, zoom: Float,
    paint: Paint,
) {
    val baseScale = max(0.65f, min(1.4f, zoom))
    val native = drawContext.canvas.nativeCanvas
    // Eat-magnetism anchor (cosmetic): pellets near OUR head lean toward the
    // mouth as we approach. Render offset only — never touches server truth.
    val me = state.getSelf()
    val magRange = 90f
    val magPull = 22f
    val nowMs = System.currentTimeMillis()

    for ((id, f) in state.food) {
        if (kotlin.math.abs(f[0] - camX) > viewR || kotlin.math.abs(f[1] - camY) > viewR) continue
        var fxw = f[0]
        var fyw = f[1]
        if (me != null) {
            val dxm = me.x - fxw
            val dym = me.y - fyw
            val dm = hypot(dxm, dym)
            if (dm < magRange && dm > 1f) {
                val pull = (1f - dm / magRange).pow(1.4f) * magPull
                fxw += dxm / dm * pull
                fyw += dym / dm * pull
            }
        }
        val x = sx(fxw); val y = sy(fyw)
        val colorIdx = f.getOrNull(2)?.toInt() ?: 0
        val isDrop = f.getOrNull(3)?.toInt() == 1
        val gold = f.getOrNull(4)?.toInt() == 1
        val s = 11f * baseScale * (if (gold) 1.35f else 1f)
        val halfS = s / 2f
        val col = Palette.base(colorIdx)

        // Golden pellet: pulsing halo ring (always on)
        if (gold) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = max(1.5f, 2f * zoom)
            paint.alpha = 128
            paint.color = 0xFFFFD93D.toInt()
            native.drawCircle(x, y, s * 2.4f * (0.85f + 0.15f * sin(nowMs * 0.005f + id)), paint)
            paint.style = Paint.Style.FILL
            paint.alpha = 255
        }

        // 4s Death Drop Radiant Glow Halo
        if (isDrop) {
            paint.color = Palette.shade(col, 0.5f)
            paint.alpha = 140
            native.drawCircle(x, y, s * 2.2f, paint)
            paint.alpha = 255
        }

        // Cube Face Fill
        paint.color = col
        native.drawRect(x - halfS, y - halfS, x + halfS, y + halfS, paint)

        // Ink Outline
        paint.color = Palette.INK
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(2f, 2.2f * zoom)
        native.drawRect(x - halfS, y - halfS, x + halfS, y + halfS, paint)
        paint.style = Paint.Style.FILL

        // Top-left shiny bevel
        paint.color = Palette.shade(col, 0.45f)
        native.drawRect(x - halfS + 1.5f * zoom, y - halfS + 1.5f * zoom, x + halfS - 1.5f * zoom, y - halfS + 3f * zoom, paint)

        // Golden glints: two orbiting white sparks
        if (gold) {
            val tw = nowMs * 0.003f + id
            val d = s * 1.05f
            val r2 = max(1.5f, s * 0.16f)
            paint.color = AColor.WHITE
            native.drawRect(x + cos(tw) * d - r2, y + sin(tw) * d - r2, x + cos(tw) * d + r2, y + sin(tw) * d + r2, paint)
            native.drawRect(x - cos(tw) * d - r2, y - sin(tw) * d - r2, x - cos(tw) * d + r2, y - sin(tw) * d + r2, paint)
        }
    }
}

private val spinePtsX = FloatArray(2000)
private val spinePtsY = FloatArray(2000)
private val spineCum = FloatArray(2000)

private fun DrawScope.drawSlitherBody(
    pl: PlayerState, sx: (Float) -> Float, sy: (Float) -> Float, zoom: Float,
    paint: Paint,
) {
    val n = pl.px.size
    if (n < 2) return

    val thick = pl.thick * zoom
    val blockSize = thick * 0.96f

    var k = 0
    spinePtsX[k] = pl.x
    spinePtsY[k] = pl.y
    k++

    val maxN = min(n, 1900)
    for (i in 0 until maxN) {
        spinePtsX[k] = pl.px[i]
        spinePtsY[k] = pl.py[i]
        k++
    }

    val b = pl.body
    if (b != null && b.size >= 2) {
        for (i in 0 until b.size step 2) {
            if (k >= 1990) break
            spinePtsX[k] = b[i]
            spinePtsY[k] = b[i + 1]
            k++
        }
    }

    spineCum[0] = 0f
    for (i in 1 until k) {
        spineCum[i] = spineCum[i - 1] + hypot(spinePtsX[i] - spinePtsX[i - 1], spinePtsY[i] - spinePtsY[i - 1])
    }
    val totalDist = spineCum[k - 1]
    if (totalDist < 1f) return
    val maxDist = min(totalDist, pl.len)

    // Pre-calculate spine block positions stepping from head to tail with tight overlapping steps
    class SpineBlock(val wx: Float, val wy: Float, val angle: Float, val size: Float, val blockIdx: Int, val distTail: Float)
    val blocks = ArrayList<SpineBlock>(200)
    // Resolve the color cycle once per snake (per-block unpack was hundreds
    // of IntArray allocations per frame).
    val cycle = Palette.unpack(pl.colorIdx)
    val nCol = if (cycle.isNotEmpty()) cycle.size else 1
    var curD = max(4f, blockSize * 0.38f)
    var bIdx = 1
    var j = 0

    while (curD <= maxDist) {
        val distFromTail = maxDist - curD
        var taper = 1.0f
        if (distFromTail < blockSize * 2.8f) {
            taper = 0.52f + 0.48f * (distFromTail / (blockSize * 2.8f))
        }
        val curSize = blockSize * taper

        while (j < k - 2 && spineCum[j + 1] < curD) j++
        while (j > 0 && spineCum[j] > curD) j--
        val segLen = spineCum[j + 1] - spineCum[j]
        if (segLen >= 1e-4f) {
            val t = ((curD - spineCum[j]) / segLen).coerceIn(0f, 1f)
            val wx = spinePtsX[j] + (spinePtsX[j + 1] - spinePtsX[j]) * t
            val wy = spinePtsY[j] + (spinePtsY[j + 1] - spinePtsY[j]) * t
            val angle = kotlin.math.atan2(spinePtsY[j] - spinePtsY[j + 1], spinePtsX[j] - spinePtsX[j + 1])
            blocks.add(SpineBlock(wx, wy, angle, curSize, bIdx, distFromTail))
        }

        val step = max(3.5f, curSize * 0.40f)
        curD += step
        bIdx++
    }

    val native = drawContext.canvas.nativeCanvas

    // Draw from tail to head
    for (idx in blocks.size - 1 downTo 0) {
        val blk = blocks[idx]
        val curHalf = blk.size / 2f
        val discX = sx(blk.wx)
        val discY = sy(blk.wy)
        val col = Palette.base(cycle[((blk.blockIdx % nCol) + nCol) % nCol])
        val pat = pl.patternIdx % 6

        // Pattern face color (mirrors web sprite variants):
        // 2 fade toward tail · 4 dark bands (pairs) · 5 ink accents (every 4th)
        var faceCol = col
        when (pat) {
            2 -> faceCol = Palette.shade(col, -0.45f * (blk.distTail / maxDist).coerceIn(0f, 1f))
            4 -> if ((blk.blockIdx / 2) % 2 == 0) faceCol = Palette.shade(col, -0.30f)
            5 -> if (blk.blockIdx % 4 == 0) faceCol = Palette.shade(col, -0.78f)
            else -> {}
        }

        native.save()
        native.translate(discX, discY)
        native.rotate((blk.angle * 180f / Math.PI.toFloat()))

        // BOOST GLOW: additive bloom in THIS block's own chain color.
        if (pl.boostVis) {
            val gr = blk.size * 1.9f
            glowAddPaint.alpha = (150 + 60 * sin(System.currentTimeMillis() * 0.01 + idx)).toInt().coerceIn(0, 255)
            native.drawBitmap(glowBmpFor(col), null, RectF(-gr, -gr, gr, gr), glowAddPaint)
        }

        // 1. Block Face Fill
        paint.color = faceCol
        native.drawRoundRect(-curHalf, -curHalf, curHalf, curHalf, 6f * zoom, 6f * zoom, paint)

        // 2. Thick Ink Outline
        paint.color = Palette.INK
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(2f, 2.5f * zoom)
        native.drawRoundRect(-curHalf, -curHalf, curHalf, curHalf, 6f * zoom, 6f * zoom, paint)
        paint.style = Paint.Style.FILL

        // 3. Inner Bevel Highlight
        paint.color = Palette.shade(faceCol, 0.4f)
        native.drawRect(-curHalf + 2f * zoom, -curHalf + 2f * zoom, curHalf - 2f * zoom, -curHalf + 4.5f * zoom, paint)

        // Stripes pattern: two ink bands ACROSS the body (local Y direction)
        if (pat == 1) {
            paint.color = 0x4D141414.toInt()
            native.drawRect(-curHalf * 0.55f, -curHalf, -curHalf * 0.20f, curHalf, paint)
            native.drawRect(curHalf * 0.20f, -curHalf, curHalf * 0.55f, curHalf, paint)
        }

        // Spots pattern: centered contrasting square on alternating blocks
        if (pat == 3 && blk.blockIdx % 2 == 0) {
            paint.color = 0x61141414.toInt()
            native.drawRoundRect(
                -curHalf * 0.32f, -curHalf * 0.32f, curHalf * 0.32f, curHalf * 0.32f,
                3f * zoom, 3f * zoom, paint,
            )
        }

        native.restore()
    }
}

private fun DrawScope.drawSlitherHead(
    pl: PlayerState, sx: (Float) -> Float, sy: (Float) -> Float, zoom: Float,
    isSelf: Boolean, isLeader: Boolean,
    namePaint: TextPaint, nameStroke: TextPaint,
    paint: Paint,
) {
    val hx = sx(pl.x)
    val hy = sy(pl.y)
    val headSize = pl.thick * 1.15f * zoom
    val halfHead = headSize / 2f
    val headCol = Palette.base(Palette.unpack(pl.colorIdx).firstOrNull() ?: 0)
    val native = drawContext.canvas.nativeCanvas

    native.save()
    native.translate(hx, hy)
    native.rotate((pl.a * 180f / Math.PI.toFloat()))

    // Boost glow behind the head (matches body bloom — own chain color)
    if (pl.boostVis) {
        val gr = headSize * 1.15f
        glowAddPaint.alpha = (170 + 60 * sin(System.currentTimeMillis() * 0.01)).toInt().coerceIn(0, 255)
        native.drawBitmap(glowBmpFor(headCol), null, RectF(-gr, -gr, gr, gr), glowAddPaint)
    }

    // 1. Head Main Block
    paint.color = headCol
    native.drawRoundRect(-halfHead, -halfHead, halfHead, halfHead, 8f * zoom, 8f * zoom, paint)

    // 2. Thick Ink Border
    paint.color = Palette.INK
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = max(2.5f, 3.2f * zoom)
    native.drawRoundRect(-halfHead, -halfHead, halfHead, halfHead, 8f * zoom, 8f * zoom, paint)
    paint.style = Paint.Style.FILL

    // 4. Googly Eyes
    val eyeSize = headSize * 0.38f
    val halfEye = eyeSize / 2f
    val pupilSize = eyeSize * 0.52f
    val eyeOffsetX = headSize * 0.16f
    val eyeOffsetY = headSize * 0.28f

    val eyeOffsets = floatArrayOf(-eyeOffsetY, eyeOffsetY)

    for (ey in eyeOffsets) {
        val ex = eyeOffsetX

        // Eye White Socket with Ink Border
        paint.color = AColor.WHITE
        native.drawRoundRect(ex - halfEye, ey - halfEye, ex + halfEye, ey + halfEye, 4f * zoom, 4f * zoom, paint)
        paint.color = Palette.INK
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(1.5f, 2f * zoom)
        native.drawRoundRect(ex - halfEye, ey - halfEye, ex + halfEye, ey + halfEye, 4f * zoom, 4f * zoom, paint)
        paint.style = Paint.Style.FILL

        // Black Pupil
        val px = ex + eyeSize * 0.15f
        val py = ey
        paint.color = Palette.INK
        native.drawRoundRect(px - pupilSize / 2f, py - pupilSize / 2f, px + pupilSize / 2f, py + pupilSize / 2f, 2f * zoom, 2f * zoom, paint)

        // Catchlight Glint
        paint.color = AColor.WHITE
        native.drawRect(px - pupilSize * 0.35f, py - pupilSize * 0.35f, px, py, paint)
    }

    native.restore()

    // Fresh-spawn shield shimmer (server flag slot 9) — pulsing cream outline
    if (pl.shield) {
        val pulse = 0.55f + 0.35f * sin(System.currentTimeMillis() * 0.006f)
        paint.color = AColor.argb((pulse * 255).toInt().coerceIn(0, 255), 255, 248, 231)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(2f, 3f * zoom)
        native.save()
        native.translate(hx, hy)
        native.rotate((pl.a * 180f / Math.PI.toFloat()))
        native.drawRoundRect(
            -halfHead - 5f * zoom, -halfHead - 5f * zoom,
            halfHead + 5f * zoom, halfHead + 5f * zoom,
            12f * zoom, 12f * zoom, paint,
        )
        native.restore()
        paint.style = Paint.Style.FILL
    }

    // 5. Crown on #1 Leader
    if (isLeader) {
        val cy = hy - halfHead - 22f * zoom
        paint.color = 0xFFFFD93D.toInt()
        native.drawCircle(hx, cy, 6f * zoom, paint)
    }
}

private fun DrawScope.drawParticles(
    list: List<Particle>, sx: (Float) -> Float, sy: (Float) -> Float, zoom: Float,
    paint: Paint,
) {
    paint.style = Paint.Style.FILL
    val native = drawContext.canvas.nativeCanvas
    for (p in list) {
        val t = 1f - p.life / p.max
        paint.alpha = (t * 220).toInt().coerceIn(0, 255)
        paint.color = p.color
        native.drawCircle(sx(p.x), sy(p.y), p.size * t * zoom, paint)
    }
}
