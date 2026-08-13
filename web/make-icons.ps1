param(
  [string]$OutDir = "C:\Users\ADITYA SHARMA\Downloads\opencodeapps\slithergame\web\public\icons"
)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-Icon {
  param([string]$Path, [int]$Size, [bool]$Maskable)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0B0E1F'))
  $pad = if ($Maskable) { $Size * 0.18 } else { $Size * 0.08 }
  $d = $Size - 2 * $pad
  $r = $d * 0.22
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($pad, $pad, 2 * $r, 2 * $r, 180, 90)
  $p.AddArc($pad + $d - 2 * $r, $pad, 2 * $r, 2 * $r, 270, 90)
  $p.AddArc($pad + $d - 2 * $r, $pad + $d - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $p.AddArc($pad, $pad + $d - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $p.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#FFD93D'))
  $g.FillPath($brush, $p)
  $fontSize = $Size * 0.52
  $font = New-Object System.Drawing.Font('Arial Black', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $ink = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#141414'))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = [System.Drawing.RectangleF]::new(0, -$Size * 0.02, $Size, $Size)
  $g.DrawString('B', $font, $ink, $rect, $fmt)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon -Path (Join-Path $OutDir 'icon-192.png') -Size 192 -Maskable $false
New-Icon -Path (Join-Path $OutDir 'icon-512.png') -Size 512 -Maskable $false
New-Icon -Path (Join-Path $OutDir 'icon-maskable-512.png') -Size 512 -Maskable $true
Get-ChildItem $OutDir | ForEach-Object { Write-Host ($_.Name + ' ' + $_.Length) }
