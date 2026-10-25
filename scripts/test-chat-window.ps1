Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ChatTest {
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
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$proc = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'no shell'; exit 1 }
$target = [uint32]$proc.Id
$script:chat = [IntPtr]::Zero
$find = [ChatTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [ChatTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [ChatTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [ChatTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [ChatTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $probe = New-Object ChatTest+RECT
    [ChatTest]::GetWindowRect($hWnd, [ref]$probe) | Out-Null
    $w = $probe.Right - $probe.Left
    $h = $probe.Bottom - $probe.Top
    if ($class.ToString() -eq 'Tauri Window' -and $title.ToString().StartsWith('DS Tuber') -and $w -ge 470 -and $h -ge 600 -and $h -lt 700) {
      $script:chat = $hWnd
    }
  }
  return $true
}
[ChatTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:chat -eq [IntPtr]::Zero) { 'chat not found'; exit 1 }

function Get-Rect([IntPtr]$h) {
  $r = New-Object ChatTest+RECT
  [ChatTest]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}

$rect = Get-Rect $script:chat
$cx = [int](($rect.Left + $rect.Right) / 2)
$cy = [int](($rect.Top + $rect.Bottom) / 2)
"chat: $($rect.Left),$($rect.Top) $($rect.Right-$rect.Left)x$($rect.Bottom-$rect.Top)"

[ChatTest]::ShowWindow($script:chat, 5) | Out-Null
[ChatTest]::SetForegroundWindow($script:chat) | Out-Null
Start-Sleep -Milliseconds 300

# Right click for the native chat menu.
[ChatTest]::SetCursorPos($cx, $cy) | Out-Null
[ChatTest]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[ChatTest]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600
$script:menu = [IntPtr]::Zero
$findMenu = [ChatTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [ChatTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target) {
    $class = New-Object System.Text.StringBuilder 128
    [ChatTest]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq '#32768' -and [ChatTest]::IsWindowVisible($hWnd)) { $script:menu = $hWnd }
  }
  return $true
}
[ChatTest]::EnumWindows($findMenu, [IntPtr]::Zero) | Out-Null
"menuFound=$($script:menu -ne [IntPtr]::Zero)"
# Close the menu.
[ChatTest]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
[ChatTest]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 300

# Resize from the left edge inward by 80px.
$before = Get-Rect $script:chat
$leftX = $before.Left + 3
$midY = [int](($before.Top + $before.Bottom) / 2)
[ChatTest]::SetCursorPos($leftX, $midY) | Out-Null
Start-Sleep -Milliseconds 150
[ChatTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le 10; $i++) {
  [ChatTest]::SetCursorPos($leftX + [int](80 * $i / 10), $midY) | Out-Null
  Start-Sleep -Milliseconds 35
}
[ChatTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600
$after = Get-Rect $script:chat
"after resize: $($after.Left),$($after.Top) $($after.Right-$after.Left)x$($after.Bottom-$after.Top)"
