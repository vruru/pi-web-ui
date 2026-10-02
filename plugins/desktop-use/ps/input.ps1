# input.ps1 — 兜底输入后端（Windows 自带 user32 SendInput + 剪贴板，无第三方依赖）
#
# 主用是 @nut-tree/nut-js（插件自动安装）；本脚本在 nut-js 缺失/安装失败时顶上，
# 保证离线机器也能点、能敲 ASCII、能粘贴中文。
#
# 用法: input.ps1 -Op move|click|key|paste|focus [-X ..] [-Y ..] [-Button left|right|middle]
#       [-Double 0|1] [-Keys "ctrl+c"] [-Text ..] [-Title 窗口标题子串]
# 输出: UTF-8 JSON { ok, ... } / { ok:false, error }

param(
  [string]$Op = "",
  [int]$X = 0, [int]$Y = 0,
  [string]$Button = "left",
  [int]$Double = 0,
  [string]$Keys = "",
  [string]$Text = "",
  [string]$Title = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Inp {
  // 注：键盘不用 SendInput——INPUT 结构体在 x64 下必须是 32 字节，
  // .NET 默认 Pack 会封成 40 字节导致发送失败且无报错；keybd_event 无结构体，稳妥。
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public const int MOUSEEVENTF_MOVE = 0x0001;
  public const int MOUSEEVENTF_LEFTDOWN = 0x02, MOUSEEVENTF_LEFTUP = 0x04;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x08, MOUSEEVENTF_RIGHTUP = 0x10;
  public const int MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40;
  public const int MOUSEEVENTF_ABSOLUTE = 0x8000;
  public const int MOUSEEVENTF_VIRTUALDESK = 0x4000;
  public const int KEYEVENTF_KEYUP = 0x02;
}
"@

try { [void][Inp]::SetProcessDpiAwareness(2) } catch { try { [void][Inp]::SetProcessDPIAware() } catch {} }

function Move-Cursor($x, $y) {
  [void][Inp]::SetCursorPos($x, $y)
  $vL = [Inp]::GetSystemMetrics(76); $vT = [Inp]::GetSystemMetrics(77)
  $vW = [Inp]::GetSystemMetrics(78); $vH = [Inp]::GetSystemMetrics(79)
  if ($vW -gt 0 -and $vH -gt 0) {
    $normX = [int]((($x - $vL) * 65535.0 / ($vW - 1)) + 0.5)
    $normY = [int]((($y - $vT) * 65535.0 / ($vH - 1)) + 0.5)
    [Inp]::mouse_event([Inp]::MOUSEEVENTF_MOVE -bor [Inp]::MOUSEEVENTF_ABSOLUTE -bor [Inp]::MOUSEEVENTF_VIRTUALDESK, $normX, $normY, 0, [UIntPtr]::Zero)
  }
}

function Out-Ok($extra) {
  $o = [ordered]@{ ok = $true; op = $Op }
  # 注：不能用 $extra.Keys——键名恰好叫 keys/values/count 时会被键遮蔽（取到键值而非集合），用 GetEnumerator 稳妥
  if ($extra) { foreach ($e in $extra.GetEnumerator()) { $o[$e.Key] = $e.Value } }
  $o | ConvertTo-Json -Compress | Write-Output
}
function Out-Err($msg) {
  [ordered]@{ ok = $false; op = $Op; error = [string]$msg } | ConvertTo-Json -Compress | Write-Output
}

$VK = @{
  enter = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20
  backspace = 0x08; delete = 0x2E; up = 0x26; down = 0x28; left = 0x25; right = 0x27
  home = 0x24; end = 0x23; pgup = 0x21; pgdn = 0x22; insert = 0x2D
}
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }
foreach ($c in "abcdefghijklmnopqrstuvwxyz".ToCharArray()) { $VK[[string]$c] = [int][char]([string]$c).ToUpper() }
foreach ($c in "0123456789".ToCharArray()) { $VK[[string]$c] = [int][char][string]$c }
$MODMAP = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; win = 0x5B }

function Send-Vk($vk, $up) {
  $flags = 0
  if ($up) { $flags = [Inp]::KEYEVENTF_KEYUP }
  $scan = [byte][Inp]::MapVirtualKey([uint32]$vk, 0)
  [Inp]::keybd_event([byte]$vk, $scan, $flags, [UIntPtr]::Zero)
}

try {
  switch ($Op) {
    "move" {
      Move-Cursor $X $Y
      Out-Ok @{ x = $X; y = $Y }
    }
    "click" {
      Move-Cursor $X $Y
      Start-Sleep -Milliseconds 60
      $n = $(if ($Double -eq 1) { 2 } else { 1 })
      for ($k = 0; $k -lt $n; $k++) {
        if ($k -gt 0) { Start-Sleep -Milliseconds 120 }
        switch ($Button) {
          "right" {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
          }
          "middle" {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero)
          }
          default {
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [Inp]::mouse_event([Inp]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          }
        }
      }
      Out-Ok @{ x = $X; y = $Y; button = $Button; double = $Double }
    }
    "key" {
      # Keys: "enter" / "ctrl+c" / "alt+F4" / "win+r"
      $parts = $Keys -split '\+' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne "" }
      if ($parts.Count -eq 0) { Out-Err "empty keys"; break }
      $modList = @(); $main = $null
      foreach ($p in $parts) {
        if ($MODMAP.ContainsKey($p)) { $modList += $MODMAP[$p] } else { $main = $p }
      }
      if ($null -eq $main -and $modList.Count -gt 0) {
        foreach ($m in $modList) { Send-Vk $m $false }
        Start-Sleep -Milliseconds 40
        foreach ($m in ($modList | Sort-Object -Descending)) { Send-Vk $m $true }
        Out-Ok @{ keys = $Keys }; break
      }
      if (-not $VK.ContainsKey($main)) { Out-Err "unknown key: $main"; break }
      foreach ($m in $modList) { Send-Vk $m $false }
      Start-Sleep -Milliseconds 40
      Send-Vk $VK[$main] $false; Start-Sleep -Milliseconds 30; Send-Vk $VK[$main] $true
      foreach ($m in ($modList | Sort-Object -Descending)) { Send-Vk $m $true }
      Out-Ok @{ keys = $Keys }
    }
    "paste" {
      # 中文/长文本走剪贴板（keybd 发不出 CJK），调用前应已聚焦目标。
      # 先保存原剪贴板内容，粘贴完在 finally 里恢复——不洗掉用户自己复制的东西。
      # （只能保文字：原内容是图片/文件等非文本时 Get-Clipboard 拿不到，放弃恢复）
      $prevText = $null
      try {
        try { $prevText = Get-Clipboard -Raw } catch { $prevText = $null }
        Set-Clipboard -Value $Text
        Start-Sleep -Milliseconds 80
        Send-Vk 0x11 $false
        Start-Sleep -Milliseconds 20
        Send-Vk 0x56 $false
        Start-Sleep -Milliseconds 40
        Send-Vk 0x56 $true
        Start-Sleep -Milliseconds 20
        Send-Vk 0x11 $true
        Out-Ok @{ chars = $Text.Length }
      } finally {
        if ($null -ne $prevText) {
          try { Set-Clipboard -Value $prevText } catch { # 恢复失败不掩盖主流程结果
          }
        }
      }
    }
    "focus" {
      $found = $null
      foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$Title*" -or $_.ProcessName -like "*$Title*") })) {
        $found = $p; break
      }
      if ($null -eq $found) { Out-Err "no window matches title: $Title"; break }
      # 发送空按键绕过 Windows SetForegroundWindow 前台锁定限制
      [Inp]::keybd_event(0, 0, 0, [UIntPtr]::Zero)
      [void][Inp]::ShowWindow($found.MainWindowHandle, 9)
      [void][Inp]::SetForegroundWindow($found.MainWindowHandle)
      Out-Ok @{ title = $found.MainWindowTitle }
    }
    default { Out-Err "unknown op: $Op (move|click|key|paste|focus)" }
  }
} catch {
  Out-Err $_.Exception.Message
}
