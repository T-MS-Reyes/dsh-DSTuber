Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DragChatTest {
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
$script:chat = [IntPtr]::Zero
$find = [DragChatTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [DragChatTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [DragChatTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [DragChatTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [DragChatTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $rect = New-Object DragChatTest+RECT
    [DragChatTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($class.ToString() -eq 'Tauri Window' -and $title.ToString().StartsWith('DS Tuber') -and $w -ge 540 -and $w -lt 600 -and $h -ge 90 -and $h -lt 140) {
      $script:chat = $hWnd
    }
  }
  return $true
}
[DragChatTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:chat -eq [IntPtr]::Zero) { 'chat not found'; exit 1 }

$before = New-Object DragChatTest+RECT
[DragChatTest]::GetWindowRect($script:chat, [ref]$before) | Out-Null
"before $($before.Left),$($before.Top) $($before.Right-$before.Left)x$($before.Bottom-$before.Top)"
[DragChatTest]::ShowWindow($script:chat, 5) | Out-Null
[DragChatTest]::SetForegroundWindow($script:chat) | Out-Null
Start-Sleep -Milliseconds 300

$startX = [int](($before.Left + $before.Right) / 2)
$startY = $before.Top + 7
[DragChatTest]::SetCursorPos($startX, $startY) | Out-Null
Start-Sleep -Milliseconds 150
[DragChatTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le 12; $i++) {
  [DragChatTest]::SetCursorPos($startX + [int](120 * $i / 12), $startY - [int](80 * $i / 12)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[DragChatTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700
$after = New-Object DragChatTest+RECT
[DragChatTest]::GetWindowRect($script:chat, [ref]$after) | Out-Null
"after $($after.Left),$($after.Top) $($after.Right-$after.Left)x$($after.Bottom-$after.Top)"
