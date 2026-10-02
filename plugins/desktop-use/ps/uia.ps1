# uia.ps1 — 无截图枚举桌面元素（Windows 自带 .NET UIAutomation，无第三方依赖）
#
# 用法:
#   uia.ps1 -Scope foreground|desktop|window [-Title 窗口标题子串] [-Query 元素名子串]
#           [-MaxNodes 300] [-MaxDepth 5]
# 输出: UTF-8 JSON { ok, scope, root, nodes:[{id,name,type,aid,rect:{x,y,w,h},enabled}], truncated }
# id 是本次 dump 内的索引路径（如 "0.2.1"），desktop_click/desktop_type 凭它定位。

param(
  [string]$Scope = "foreground",
  [string]$Title = "",
  [string]$Process = "",
  [string]$Query = "",
  [int]$MaxNodes = 300,
  [int]$MaxDepth = 5
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int n);
}
"@

$walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
$nodes = New-Object System.Collections.Generic.List[object]
$script:count = 0
$script:truncated = $false

# 进程名缓存（窗口按进程识别用，如微信 Weixin.exe；标题是昵称、每次都变，标题匹配不可靠）
$procCache = @{}
function Get-ProcName($procId) {
  if ($procCache.ContainsKey($procId)) { return $procCache[$procId] }
  $n = ""
  try { $n = [string](Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $procCache[$procId] = $n
  return $n
}

function Test-Match($name, $ctype, $aid) {
  if ($Query -eq "") { return $true }
  $q = "*$Query*"
  return ($name -like $q) -or ($ctype -like $q) -or ($aid -like $q)
}

function Add-Tree($el, $depth, $path) {
  if ($script:count -ge $MaxNodes) { $script:truncated = $true; return }
  if ($depth -gt $MaxDepth) { return }
  try { $cur = $el.Current } catch { return }
  try { $r = $cur.BoundingRectangle } catch { return }
  if ($null -eq $r -or $r.Width -le 0 -or $r.Height -le 0) { return }
  try { if ($cur.IsOffscreen) { return } } catch {}
  $name = ""; try { $name = [string]$cur.Name } catch {}
  $ctype = ""; try { $ctype = [string]$cur.ControlType.ProgrammaticName } catch {}
  $ctype = $ctype -replace '^ControlType\.', ''
  $aid = ""; try { $aid = [string]$cur.AutomationId } catch {}
  $enabled = $true; try { $enabled = [bool]$cur.IsEnabled } catch {}
  $proc = ""; $cls = ""; $hwnd = 0
  try { $proc = Get-ProcName $cur.ProcessId } catch {}
  try { $cls = [string]$cur.ClassName } catch {}
  # 只有顶层窗口取句柄（截图按句柄精确定位到这一扇窗；普通控件读它会抛）
  if ($ctype -eq "Window") {
    try { $hwnd = [long]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty) } catch {}
  }
  if (Test-Match $name $ctype $aid) {
    $script:count++
    $node = [ordered]@{
      id = $path; name = $name; type = $ctype; aid = $aid
      rect = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
      enabled = $enabled; proc = $proc; cls = $cls
    }
    if ($hwnd -ne 0) { $node.hwnd = $hwnd }
    $nodes.Add($node) | Out-Null
  }
  if ($depth -eq $MaxDepth) { return }
  try { $child = $walker.GetFirstChild($el) } catch { return }
  $i = 0
  while ($null -ne $child -and $script:count -lt $MaxNodes -and $i -lt 60) {
    $next = $null; try { $next = $walker.GetNextSibling($child) } catch {}
    Add-Tree $child ($depth + 1) "$path.$i"
    $child = $next; $i++
  }
}

$root = $null; $rootName = ""
if ($Scope -eq "desktop") {
  $root = [System.Windows.Automation.AutomationElement]::RootElement; $rootName = "desktop"
} elseif ($Scope -eq "window" -and ($Title -ne "" -or $Process -ne "")) {
  $desk = [System.Windows.Automation.AutomationElement]::RootElement
  try { $kid = $walker.GetFirstChild($desk) } catch { $kid = $null }
  while ($null -ne $kid) {
    try {
      $c = $kid.Current
      if ($c.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
        $hitTitle = ($Title -ne "" -and [string]$c.Name -like "*$Title*")
        $hitProc = ($false)
        if ($Process -ne "") {
          try { $hitProc = (Get-ProcName $c.ProcessId) -like "*$Process*" } catch {}
        }
        if ($hitTitle -or $hitProc) { $root = $kid; $rootName = [string]$c.Name; break }
      }
    } catch {}
    try { $kid = $walker.GetNextSibling($kid) } catch { $kid = $null }
  }
  if ($null -eq $root) {
    [ordered]@{ ok = $false; error = "no window matches (title=$Title process=$Process)" } | ConvertTo-Json -Compress | Write-Output
    exit 0
  }
} else {
  $hwnd = [Win32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32]::GetWindowText($hwnd, $sb, 512)
  $rootName = $sb.ToString()
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
  catch { $root = [System.Windows.Automation.AutomationElement]::RootElement; $rootName = "desktop" }
}

Add-Tree $root 0 "0"
[ordered]@{
  ok = $true; scope = $Scope; root = $rootName
  count = $script:count; truncated = $script:truncated; nodes = $nodes
} | ConvertTo-Json -Depth 7 -Compress | Write-Output
