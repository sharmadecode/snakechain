package com.blocks.game

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class MenuPrefs(
    val name: String,
    val color: Int,
    val pattern: Int,
    val mode: String = "classic",
    val server: String,
)

@Composable
fun MenuScreen(
    initial: MenuPrefs,
    serverStatus: String,
    menuStats: String = "",
    onPlay: (MenuPrefs) -> Unit,
) {
    var name by remember { mutableStateOf(initial.name) }
    var server by remember { mutableStateOf(initial.server) }
    var colorIdx by remember { mutableStateOf(initial.color) }
    var patternIdx by remember { mutableStateOf(initial.pattern) }
    var mode by remember { mutableStateOf(initial.mode) }
    var nameError by remember { mutableStateOf(false) }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xFF080B18)),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(420.dp)
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(Color(0xEE0C1020))
                .border(1.dp, Color(0x3300D2FF), RoundedCornerShape(20.dp))
                .padding(24.dp),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = 200.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "SNAKECHAIN",
                    color = Color.White,
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 2.sp,
                )

                Spacer(Modifier.height(4.dp))
                Text(
                    "eat energy · slither long · conquer",
                    color = Color(0x99FFFFFF),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.5.sp,
                )
                Spacer(Modifier.height(14.dp))

                FieldLabel("SNAKE NAME")
                SlitherField(value = name, onChange = { if (it.length <= 14) name = it }, placeholder = "Enter nickname")
                if (nameError) {
                    Text(
                        "ENTER A NICKNAME TO PLAY",
                        color = Color(0xFFFF5C7A),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Black,
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))

                FieldLabel("SKIN COLOR")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Palette.COLORS.take(6).forEachIndexed { i, c ->
                        Swatch(color = c, selected = colorIdx == i, onClick = { colorIdx = i })
                    }
                }
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Palette.COLORS.drop(6).forEachIndexed { j, c ->
                        val i = j + 6
                        Swatch(color = c, selected = colorIdx == i, onClick = { colorIdx = i })
                    }
                }
                Spacer(Modifier.height(10.dp))

                FieldLabel("SKIN PATTERN")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (p in 0 until 6) {
                        PatternCard(selected = patternIdx == p, onClick = { patternIdx = p }, colorIdx = colorIdx, patternIdx = p)
                    }
                }
                Spacer(Modifier.height(10.dp))

                FieldLabel("SERVER")
                SlitherField(value = server, onChange = { server = it }, placeholder = "ws://host:8787/ws")
                Spacer(Modifier.height(10.dp))

                FieldLabel("ARENA")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ModePill(label = "CLASSIC", icon = "🗺️", selected = mode == "classic", onClick = { mode = "classic" })
                    ModePill(label = "COLLAPSE", icon = "🌀", selected = mode == "br", onClick = { mode = "br" })
                }
                Spacer(Modifier.height(16.dp))

                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color(0xFF00E676))
                        .clickable {
                            val n = name.trim()
                            if (n.isNotEmpty()) {
                                nameError = false
                                onPlay(MenuPrefs(n, colorIdx, patternIdx, mode, server.trim()))
                            } else {
                                nameError = true
                            }
                        }
                        .padding(vertical = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "PLAY NOW",
                        color = Color(0xFF080B18),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 1.5.sp,
                    )
                }

                Spacer(Modifier.height(10.dp))
                Text(
                    serverStatus,
                    color = Color(0x66FFFFFF),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                if (menuStats.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        menuStats,
                        color = Color(0xB3FFF8E7),
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 0.5.sp,
                        textAlign = TextAlign.Center,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "touch left = steer · tap BOOST = speed burst",
                    color = Color(0x99FFFFFF),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun ModePill(label: String, icon: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) Color(0x29FFD93D) else Color(0x14FFFFFF))
            .border(
                if (selected) 2.dp else 1.dp,
                if (selected) Color(0xFFFFD93D) else Color(0x33FFFFFF),
                RoundedCornerShape(8.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, fontSize = 11.sp)
        Text(
            label,
            color = if (selected) Color(0xFFFFD93D) else Color(0xCCFFFFFF),
            fontSize = 10.sp,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text,
        color = Color(0xFF00D2FF),
        fontSize = 10.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 2.sp,
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
    )
}

@Composable
private fun SlitherField(value: String, onChange: (String) -> Unit, placeholder: String) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = androidx.compose.ui.text.TextStyle(
            color = Color.White,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
        ),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0x22FFFFFF))
                    .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(8.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                if (value.isEmpty()) {
                    Text(placeholder, color = Color(0x44FFFFFF), fontSize = 15.sp)
                }
                inner()
            }
        },
    )
}

@Composable
private fun Swatch(color: Int, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(38.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(color))
            .border(if (selected) 2.dp else 1.dp, if (selected) Color.White else Color(0x33FFFFFF), RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .then(if (selected) Modifier.offset(y = (-2).dp) else Modifier),
    )
}

@Composable
private fun PatternCard(selected: Boolean, onClick: () -> Unit, colorIdx: Int, patternIdx: Int) {
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0x22000000))
            .border(if (selected) 2.dp else 1.dp, if (selected) Color(0xFF00D2FF) else Color(0x22FFFFFF), RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(2.dp),
    ) {
        Canvas(Modifier.width(42.dp).height(24.dp)) {
            val bands = 24
            val bw = size.width / bands
            for (i in 0 until bands) {
                drawRect(
                    color = Color(Palette.segmentColor(colorIdx, patternIdx, i, bands)),
                    topLeft = androidx.compose.ui.geometry.Offset(i * bw, 0f),
                    size = androidx.compose.ui.geometry.Size(bw + 1f, size.height),
                )
            }
        }
    }
}
