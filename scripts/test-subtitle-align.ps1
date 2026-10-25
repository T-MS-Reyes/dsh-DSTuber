Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SubtitleAlignTest {
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
$script:pet = [IntPtr]::Zero
$find = [SubtitleAlignTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SubtitleAlignTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [SubtitleAlignTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [SubtitleAlignTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [SubtitleAlignTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $rect = New-Object SubtitleAlignTest+RECT
    [SubtitleAlignTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $t = $title.ToString()
    if ($class.ToString() -eq 'Tauri Window' -and $t -eq 'DS Tuber' -and $h -eq 500) {
      $script:pet = $hWnd
    }
    if ($class.ToString() -eq 'Tauri Window' -and $t.StartsWith('DS Tuber') -and $t -ne 'DS Tuber' -and $t -ne 'DS Tuber 设置' -and $h -lt 300) {
      $script:subtitle = $hWnd
    }
  }
  return $true
}
[SubtitleAlignTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:subtitle -eq [IntPtr]::Zero -or $script:pet -eq [IntPtr]::Zero) { 'windows not found'; exit 1 }

function Get-Rect([IntPtr]$h) {
  $r = New-Object SubtitleAlignTest+RECT
  [SubtitleAlignTest]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}
$pet = Get-Rect $script:pet
$before = Get-Rect $script:subtitle
"before: subtitle=$($before.Left),$($before.Top) $($before.Right-$before.Left)x$($before.Bottom-$before.Top) pet=$($pet.Left),$($pet.Top)"

[SubtitleAlignTest]::ShowWindow($script:subtitle, 5) | Out-Null
[SubtitleAlignTest]::SetForegroundWindow($script:subtitle) | Out-Null
Start-Sleep -Milliseconds 350

# Drag the right edge inward by 160px, then release.
$rightX = $before.Right - 3
$midY = [int](($before.Top + $before.Bottom) / 2)
[SubtitleAlignTest]::SetCursorPos($rightX, $midY) | Out-Null
Start-Sleep -Milliseconds 150
[SubtitleAlignTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le 12; $i++) {
  [SubtitleAlignTest]::SetCursorPos($rightX - [int](160 * $i / 12), $midY) | Out-Null
  Start-Sleep -Milliseconds 35
}
Start-Sleep -Milliseconds 100
[SubtitleAlignTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
$justReleased = Get-Rect $script:subtitle
"just released: $($justReleased.Left),$($justReleased.Top) $($justReleased.Right-$justReleased.Left)x$($justReleased.Bottom-$justReleased.Top)"
Start-Sleep -Milliseconds 700
$after = Get-Rect $script:subtitle
"after re-snap: $($after.Left),$($after.Top) $($after.Right-$after.Left)x$($after.Bottom-$after.Top)"
