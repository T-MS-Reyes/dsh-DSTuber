Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SubtitleToggle {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$proc = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'no shell'; exit 1 }
$target = [uint32]$proc.Id
$script:pet = [IntPtr]::Zero
$script:subtitle = [IntPtr]::Zero
$find = [SubtitleToggle+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SubtitleToggle]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [SubtitleToggle]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [SubtitleToggle]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [SubtitleToggle]::GetClassName($hWnd, $class, 128) | Out-Null
    $rect = New-Object SubtitleToggle+RECT
    [SubtitleToggle]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($title.ToString() -eq 'DS Tuber' -and $class.ToString() -eq 'Tauri Window' -and $h -eq 500) {
      $script:pet = $hWnd
    }
    if ($title.ToString().StartsWith('DS Tuber') -and $w -eq 380 -and $h -eq 120) {
      $script:subtitle = $hWnd
    }
  }
  return $true
}
[SubtitleToggle]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:pet -eq [IntPtr]::Zero -or $script:subtitle -eq [IntPtr]::Zero) {
  "pet=$($script:pet) subtitle=$($script:subtitle) not found"
  exit 1
}

function Get-Rect([IntPtr]$h) {
  $r = New-Object SubtitleToggle+RECT
  [SubtitleToggle]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}
function Open-SubtitleMenu {
  $r = Get-Rect $script:subtitle
  $x = [int](($r.Left + $r.Right) / 2)
  $y = [int](($r.Top + $r.Bottom) / 2)
  [SubtitleToggle]::ShowWindow($script:subtitle, 5) | Out-Null
  [SubtitleToggle]::SetForegroundWindow($script:subtitle) | Out-Null
  Start-Sleep -Milliseconds 200
  [SubtitleToggle]::SetCursorPos($x, $y) | Out-Null
  [SubtitleToggle]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
  [SubtitleToggle]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}
function Toggle-Snap {
  Open-SubtitleMenu
  # 显示字幕 -> 吸附桌宠 -> Enter
  foreach ($vk in @(0x28, 0x28, 0x0D)) {
    [SubtitleToggle]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [SubtitleToggle]::keybd_event([byte]$vk, 0, 0x0002, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 500
}

$petBefore = Get-Rect $script:pet
$subBefore = Get-Rect $script:subtitle
"before pet=$($petBefore.Left),$($petBefore.Top) subtitle=$($subBefore.Left),$($subBefore.Top)"

# Turn snap off, move the pet, subtitle should stay.
Toggle-Snap
$petNow = Get-Rect $script:pet
[SubtitleToggle]::SetWindowPos($script:pet, [IntPtr]::Zero, $petNow.Left - 80, $petNow.Top, 0, 0, 0x0001 -bor 0x0004) | Out-Null
Start-Sleep -Milliseconds 700
$subAfterMove = Get-Rect $script:subtitle
"snap off: subtitle=$($subAfterMove.Left),$($subAfterMove.Top) (expected same $($subBefore.Left),$($subBefore.Top))"

# Turn snap back on, move the pet, subtitle should follow.
Toggle-Snap
$petNow2 = Get-Rect $script:pet
[SubtitleToggle]::SetWindowPos($script:pet, [IntPtr]::Zero, $petNow2.Left + 80, $petNow2.Top, 0, 0, 0x0001 -bor 0x0004) | Out-Null
Start-Sleep -Milliseconds 700
$subAfterSnap = Get-Rect $script:subtitle
"snap on: subtitle=$($subAfterSnap.Left),$($subAfterSnap.Top) (expected to follow pet)"
