# screenshot.ps1 — 按窗口截图（Windows 自带 .NET，无第三方依赖）
#
# 优先 PrintWindow（窗口被遮挡/不在前台也能截，Qt 自绘窗口一般也行）；
# 截出来是纯色就判空白，改用 flags=2（PW_RENDERFULLCONTENT）再试；
# 还空白就报 blank（调用方先 desktop_window focus 到前台再截，BitBlt 只能截可见的）。
#
# 用法: screenshot.ps1 [-Title ..] [-Process ..] [-Hwnd ..] [-MaxWidth 1280] [-Out path]
# 输出: UTF-8 JSON { ok, method, x, y, w, h, imgW, imgH, bytes, variance, blank, out }
# x,y = 窗口左上角屏幕坐标（物理像素，与 UIA 矩形同一坐标系）；imgW/imgH = 下发图的尺寸；
# 屏幕坐标 = (x + 图X * w / imgW, y + 图Y * h / imgH)。

param(
  [string]$Title = "",
  [string]$Process = "",
  [long]$Hwnd = 0,
  [int]$MaxWidth = 1280,
  [string]$Out = "",
  [int]$Ocr = 1
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Shot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO {
    public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO {
    public bool fIcon; public int xHotspot; public int yHotspot;
    public IntPtr hbmMask; public IntPtr hbmColor;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr flicker, int flags);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
}
"@

function Out-Json($o) { $o | ConvertTo-Json -Compress | Write-Output }

# OCR 辅助：WinRT Windows.Media.Ocr 原生离线识别图内文字与坐标
function Run-Ocr($filePath) {
  $items = @()
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod } | Select-Object -First 1
    if ($null -eq $asTaskGeneric) { return $items }

    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]

    $fullPath = [System.IO.Path]::GetFullPath($filePath)
    $fileTask = $asTaskGeneric.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)))
    $fileTask.Wait(-1) | Out-Null
    $sFile = $fileTask.Result

    $streamTask = $asTaskGeneric.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStream]).Invoke($null, @($sFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)))
    $streamTask.Wait(-1) | Out-Null
    $stream = $streamTask.Result

    $decTask = $asTaskGeneric.MakeGenericMethod([Windows.Graphics.Imaging.BitmapDecoder]).Invoke($null, @([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)))
    $decTask.Wait(-1) | Out-Null
    $decoder = $decTask.Result

    $bmpTask = $asTaskGeneric.MakeGenericMethod([Windows.Graphics.Imaging.SoftwareBitmap]).Invoke($null, @($decoder.GetSoftwareBitmapAsync()))
    $bmpTask.Wait(-1) | Out-Null
    $sbmp = $bmpTask.Result

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
    }
    if ($null -eq $engine) {
      $avail = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
      if ($avail.Count -gt 0) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($avail[0])
      }
    }
    if ($null -eq $engine) {
      $stream.Dispose()
      return $items
    }

    $ocrTask = $asTaskGeneric.MakeGenericMethod([Windows.Media.Ocr.OcrResult]).Invoke($null, @($engine.RecognizeAsync($sbmp)))
    $ocrTask.Wait(-1) | Out-Null
    $ocrResult = $ocrTask.Result
    $stream.Dispose()

    foreach ($line in $ocrResult.Lines) {
      if ($null -eq $line.Words -or $line.Words.Count -eq 0) { continue }
      $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = 0; $maxY = 0
      $wordsList = @()
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        $rx = [int]$r.X; $ry = [int]$r.Y; $rw = [int]$r.Width; $rh = [int]$r.Height
        if ($rx -lt $minX) { $minX = $rx }
        if ($ry -lt $minY) { $minY = $ry }
        if (($rx + $rw) -gt $maxX) { $maxX = ($rx + $rw) }
        if (($ry + $rh) -gt $maxY) { $maxY = ($ry + $rh) }
        $wClean = $w.Text.Trim()
        if ($wClean.Length -gt 0) {
          $wordsList += [ordered]@{
            text = $wClean
            x = $rx; y = $ry; w = $rw; h = $rh
            cx = $rx + [int]($rw / 2)
            cy = $ry + [int]($rh / 2)
          }
        }
      }
      $lineW = $maxX - $minX
      $lineH = $maxY - $minY
      $rawText = [string]$line.Text
      $cleanText = [System.Text.RegularExpressions.Regex]::Replace($rawText, '(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])', '').Trim()
      if ($cleanText.Length -gt 0) {
        $items += [ordered]@{
          text = $cleanText
          x = $minX; y = $minY; w = $lineW; h = $lineH
          cx = $minX + [int]($lineW / 2)
          cy = $minY + [int]($lineH / 2)
        }
      }
      if ($wordsList.Count -gt 1) {
        foreach ($wItem in $wordsList) {
          if ($wItem.text.Length -ge 2 -and $wItem.text -ne $cleanText) {
            $items += $wItem
          }
        }
      }
    }
  } catch {}
  return $items
}

# 物理像素（与 UIA 同坐标系；powershell 默认 DPI-unaware 会拿到虚拟化坐标）
try { [void][Shot]::SetProcessDpiAwareness(2) } catch {}

function Find-Window($title, $proc) {
  $found = $null
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })) {
    $t = [string]$p.MainWindowTitle
    $okT = ($title -ne "" -and $t -like "*$title*")
    $okP = ($false)
    if ($proc -ne "") { $okP = ([string]$p.ProcessName -like "*$proc*") }
    if ($okT -or $okP) { $found = $p; break }
  }
  return $found
}

# 采样统计：方差（纯色图≈0）+ 近黑比例（Qt 等自绘窗口 PrintWindow 常返回黑底+边框：
# 方差被边框抬高，但黑像素占 97%+，必须判空白，否则下发一张黑图给模型看）
function Test-Stats($bmp) {
  # 只看中央 80%：窗口边框/阴影会抬高整图方差，中央纯黑才是真空白
  $x0 = [int]($bmp.Width * 0.1); $x1 = [int]($bmp.Width * 0.9)
  $y0 = [int]($bmp.Height * 0.1); $y1 = [int]($bmp.Height * 0.9)
  $step = 12
  $n = 0; $sum = 0.0; $sum2 = 0.0; $black = 0
  for ($yy = $y0; $yy -lt $y1; $yy += $step) {
    for ($xx = $x0; $xx -lt $x1; $xx += $step) {
      $c = $bmp.GetPixel($xx, $yy)
      $g = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($g -lt 12) { $black++ }
      $sum += $g; $sum2 += $g * $g; $n++
    }
  }
  if ($n -eq 0) { return @{ variance = 0; blackFrac = 1 } }
  $mean = $sum / $n
  return @{ variance = ($sum2 / $n) - ($mean * $mean); blackFrac = $black / $n }
}
function Test-Blank($stats) { return ($stats.variance -le 25) -or ($stats.blackFrac -gt 0.97) }

try {
  $targetHwnd = [IntPtr]::Zero
  if ($Hwnd -ne 0) {
    $targetHwnd = [IntPtr]$Hwnd
  }
  else {
    $p = Find-Window $Title $Process
    if ($null -eq $p) { Out-Json ([ordered]@{ ok = $false; error = "no window matches (title=$Title process=$Process)" }); exit 0 }
    $targetHwnd = $p.MainWindowHandle
  }
  $rc = New-Object Shot+RECT
  if (-not [Shot]::GetWindowRect($targetHwnd, [ref]$rc)) { Out-Json ([ordered]@{ ok = $false; error = "GetWindowRect failed" }); exit 0 }
  $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
  if ($w -le 0 -or $h -le 0) { Out-Json ([ordered]@{ ok = $false; error = "window has empty rect (minimized?)" }); exit 0 }

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $method = ""
  $stats = @{ variance = 0; blackFrac = 1 }
  try {
    foreach ($flags in @(0, 2)) {
      $hdc = $g.GetHdc()
      try { [void][Shot]::PrintWindow($targetHwnd, $hdc, $flags) } finally { $g.ReleaseHdc($hdc) }
      $stats = Test-Stats $bmp
      if (-not (Test-Blank $stats)) { $method = "printwindow:$flags"; break }
    }
    # 还空白，且窗口正在前台：BitBlt 直接从屏幕拷
    if ($method -eq "") {
      $fg = [Shot]::GetForegroundWindow()
      if ($fg -eq $targetHwnd) {
        $src = [Shot]::GetDC([IntPtr]::Zero)
        try {
          $hdc = $g.GetHdc()
          try { [void][Shot]::BitBlt($hdc, 0, 0, $w, $h, $src, $rc.L, $rc.T, 0x00CC0020) } finally { $g.ReleaseHdc($hdc) }
        } finally { [void][Shot]::ReleaseDC([IntPtr]::Zero, $src) }
        $stats = Test-Stats $bmp
        if (-not (Test-Blank $stats)) { $method = "bitblt" }
      }
    }
  } finally { $g.Dispose() }

  if ($method -eq "") {
    $bmp.Dispose()
    Out-Json ([ordered]@{ ok = $true; blank = $true; x = $rc.L; y = $rc.T; w = $w; h = $h;
      variance = [math]::Round($stats.variance, 1); blackFrac = [math]::Round($stats.blackFrac, 3);
      hint = "截出来是空白/黑图（Qt 自绘不受 PrintWindow 待见？）：先 desktop_window focus 到前台再截（前台可用 BitBlt）" })
    exit 0
  }

  # 鼠标光标：PrintWindow/BitBlt 都不会自带光标（BitBlt 没加 CAPTUREBLT），
  # 而文本插入符（I-beam 的闪烁竖线）本来就是间歇显示的，截图时很可能正好处于熄灭相位。
  # 这里把当前系统鼠标指针画进图里，并把坐标回给调用方，模型可据此确认上一次点击落点。
  $curDrawn = $false; $curX = 0; $curY = 0; $curInWin = $false
  try {
    $ci = New-Object Shot+CURSORINFO
    $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
    if ([Shot]::GetCursorInfo([ref]$ci)) {
      $curX = $ci.ptScreenPos.X; $curY = $ci.ptScreenPos.Y
      if ($ci.flags -eq 1 -and $ci.hCursor -ne [IntPtr]::Zero) {
        $hotX = 0; $hotY = 0
        try {
          $ii = New-Object Shot+ICONINFO
          if ([Shot]::GetIconInfo($ci.hCursor, [ref]$ii)) {
            $hotX = $ii.xHotspot; $hotY = $ii.yHotspot
            if ($ii.hbmMask -ne [IntPtr]::Zero) { [void][Shot]::DeleteObject($ii.hbmMask) }
            if ($ii.hbmColor -ne [IntPtr]::Zero) { [void][Shot]::DeleteObject($ii.hbmColor) }
          }
        } catch {}
        $dx = $curX - $rc.L - $hotX; $dy = $curY - $rc.T - $hotY
        if ($dx -gt -64 -and $dy -gt -64 -and $dx -lt $w -and $dy -lt $h) {
          $curInWin = $true
          $g2 = [System.Drawing.Graphics]::FromImage($bmp)
          try {
            $hdc2 = $g2.GetHdc()
            try { if ([Shot]::DrawIconEx($hdc2, $dx, $dy, $ci.hCursor, 0, 0, 0, [IntPtr]::Zero, 0x0003)) { $curDrawn = $true } }
            finally { $g2.ReleaseHdc($hdc2) }
          } finally { $g2.Dispose() }
        }
      }
    }
  } catch {}
  # 兜底标记：指针隐藏/取不到句柄时（打字中 Windows 会藏指针），在指针位置画红圈+十字，
  # 模型照样能确认上一次点击落点。红白双线保证深色 UI（微信深色模式）下也看得见。
  $curMarker = $false
  if ($curInWin -and -not $curDrawn) {
    try {
      $mx = $curX - $rc.L; $my = $curY - $rc.T
      $rr = [math]::Max(14, [int]($w / 80))
      $penW = [math]::Max(2, [int]($w / 500))
      $g3 = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $penW2 = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($penW + 2))
        $penR = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, $penW)
        try {
          foreach ($pen in @($penW2, $penR)) {
            $g3.DrawEllipse($pen, ($mx - $rr), ($my - $rr), ($rr * 2), ($rr * 2))
            $g3.DrawLine($pen, ($mx - $rr - 6), $my, ($mx - $rr + 6), $my)
            $g3.DrawLine($pen, ($mx + $rr - 6), $my, ($mx + $rr + 6), $my)
            $g3.DrawLine($pen, $mx, ($my - $rr - 6), $mx, ($my - $rr + 6))
            $g3.DrawLine($pen, $mx, ($my + $rr - 6), $mx, ($my + $rr + 6))
          }
          $curMarker = $true
        } finally { $penW2.Dispose(); $penR.Dispose() }
      } finally { $g3.Dispose() }
    } catch {}
  }

  $imgW = $w; $imgH = $h
  $final = $bmp
  if ($w -gt $MaxWidth) {
    $imgW = $MaxWidth; $imgH = [int]($h * $MaxWidth / $w)
    $final = New-Object System.Drawing.Bitmap($imgW, $imgH)
    $gg = [System.Drawing.Graphics]::FromImage($final)
    try {
      $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $gg.DrawImage($bmp, 0, 0, $imgW, $imgH)
    } finally { $gg.Dispose(); $bmp.Dispose() }
  }
  if ($Out -eq "") { $Out = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "shot_$([DateTime]::Now.Ticks).png") }
  $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = (Get-Item $Out).Length
  $final.Dispose()
  # 光标的图内坐标（随下发图缩放换算，模型可直接对照看落点）
  $curImgX = [int](($curX - $rc.L) * $imgW / $w); $curImgY = [int](($curY - $rc.T) * $imgH / $h)

  # WinRT OCR 图内文字与像素坐标识别
  $ocrItems = @()
  if ($Ocr -ne 0) {
    $ocrItems = Run-Ocr $Out
  }

  Out-Json ([ordered]@{ ok = $true; blank = $false; method = $method; x = $rc.L; y = $rc.T; w = $w; h = $h;
    imgW = $imgW; imgH = $imgH; bytes = $bytes; variance = [math]::Round($stats.variance, 1); out = $Out;
    cursorDrawn = $curDrawn; cursorMarker = $curMarker; cursorInWin = $curInWin; cursorX = $curX; cursorY = $curY;
    cursorImgX = $curImgX; cursorImgY = $curImgY; ocr = $ocrItems; ocrCount = $ocrItems.Count })
} catch {
  Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message })
}
