Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SubtitleResizeTest {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$proc = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'no shell'; exit 1 }
$target = [uint32]$proc.Id
$script:subtitle = [IntPtr]::Zero
$find = [SubtitleResizeTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SubtitleResizeTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [SubtitleResizeTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [SubtitleResizeTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [SubtitleResizeTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $rect = New-Object SubtitleResizeTest+RECT
    [SubtitleResizeTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $h = $rect.Bottom - $rect.Top
    $t = $title.ToString()
    if ($class.ToString() -eq 'Tauri Window' -and $t.StartsWith('DS Tuber') -and $t -ne 'DS Tuber' -and $t -ne 'DS Tuber 设置' -and $h -lt 300) {
      $script:subtitle = $hWnd
    }
  }
  return $true
}
[SubtitleResizeTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:subtitle -eq [IntPtr]::Zero) { 'subtitle not found'; exit 1 }

function Get-Rect([IntPtr]$h) {
  $r = New-Object SubtitleResizeTest+RECT
  [SubtitleResizeTest]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}
function Drag-Edge([int]$x, [int]$y, [int]$dx, [int]$dy) {
  [SubtitleResizeTest]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [SubtitleResizeTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
  for ($i = 1; $i -le 12; $i++) {
    [SubtitleResizeTest]::SetCursorPos($x + [int]($dx * $i / 12), $y + [int]($dy * $i / 12)) | Out-Null
    Start-Sleep -Milliseconds 35
  }
  Start-Sleep -Milliseconds 150
  [SubtitleResizeTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
}

[SubtitleResizeTest]::ShowWindow($script:subtitle, 5) | Out-Null
[SubtitleResizeTest]::SetForegroundWindow($script:subtitle) | Out-Null
Start-Sleep -Milliseconds 400

$before = Get-Rect $script:subtitle
"before: $($before.Left),$($before.Top) $($before.Right - $before.Left)x$($before.Bottom - $before.Top)"

# Drag the left edge left by 160: width should grow.
$leftX = $before.Left + 3
$midY = [int](($before.Top + $before.Bottom) / 2)
Drag-Edge $leftX $midY -160 0
$after = Get-Rect $script:subtitle
"after left drag: $($after.Left),$($after.Top) $($after.Right - $after.Left)x$($after.Bottom - $after.Top)"

# Drag the same edge far past the limit: width must stay <= 4/5 screen.
$leftX2 = $after.Left + 3
Drag-Edge $leftX2 $midY -900 0
$clamped = Get-Rect $script:subtitle
"after clamp drag: $($clamped.Left),$($clamped.Top) $($clamped.Right - $clamped.Left)x$($clamped.Bottom - $clamped.Top)"
