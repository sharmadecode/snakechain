package com.blocks.game

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object NeoColors {
    val Cream = Color(0xFFFFF8E7)
    val Ink = Color(0xFF141414)
    val Orange = Color(0xFFFF5722)
    val Yellow = Color(0xFFFFD93D)
    val Cyan = Color(0xFF00C2D1)
    val Lime = Color(0xFFA8E10C)
    val Red = Color(0xFFFF3B30)
}

/** Neo-brutalism card: background color, 4dp ink border, hard 8dp offset shadow. */
@Composable
fun NeoPanel(
    modifier: Modifier = Modifier,
    bg: Color = NeoColors.Cream,
    corner: Dp = 14.dp,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(modifier) {
        Box(
            Modifier
                .matchParentSize()
                .offset(x = 8.dp, y = 8.dp)
                .clip(RoundedCornerShape(corner))
                .background(NeoColors.Ink)
        )
        Box(
            Modifier
                .matchParentSize()
                .clip(RoundedCornerShape(corner))
                .background(bg)
                .border(4.dp, NeoColors.Ink, RoundedCornerShape(corner)),
            content = content,
        )
    }
}

/** Neo-brutalism button: hard border, offset shadow, presses down when tapped. */
@Composable
fun NeoButton(
    text: String,
    modifier: Modifier = Modifier,
    bg: Color = NeoColors.Lime,
    textSize: Int = 20,
    onClick: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    Box(
        modifier
            .offset(x = if (pressed) 5.dp else 0.dp, y = if (pressed) 5.dp else 0.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .border(4.dp, NeoColors.Ink, RoundedCornerShape(12.dp))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 18.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = NeoColors.Ink,
            fontSize = textSize.sp,
            fontFamily = FontFamily.SansSerif,
            fontWeight = FontWeight.Black,
            letterSpacing = 2.sp,
        )
    }
}
