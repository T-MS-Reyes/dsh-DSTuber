Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SnapChatTest {
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
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$proc = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'no shell'; exit 1 }
$target = [uint32]$proc.Id
$script:chat = [IntPtr]::Zero
$script:sub = [IntPtr]::Zero
$find = [SnapChatTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SnapChatTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [SnapChatTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [SnapChatTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [SnapChatTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $rect = New-Object SnapChatTest+RECT
    [SnapChatTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($class.ToString() -eq 'Tauri Window' -and $title.ToString().StartsWith('DS Tuber')) {
      if ($w -ge 540 -and $w -lt 600 -and $h -ge 90 -and $h -lt 140) { $script:chat = $hWnd }
      if ($w -ge 600 -and $title.ToString() -notlike '*对话输入*') { $script:sub = $hWnd }
    }
  }
  return $true
}
[SnapChatTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:chat -eq [IntPtr]::Zero) { 'chat not found'; exit 1 }
$before = New-Object SnapChatTest+RECT
[SnapChatTest]::GetWindowRect($script:chat, [ref]$before) | Out-Null
$sub = New-Object SnapChatTest+RECT
if ($script:sub -ne [IntPtr]::Zero) { [SnapChatTest]::GetWindowRect($script:sub, [ref]$sub) | Out-Null }
"before chat=$($before.Left),$($before.Top) $($before.Right-$before.Left)x$($before.Bottom-$before.Top) sub=$($sub.Left),$($sub.Top) $($sub.Right-$sub.Left)x$($sub.Bottom-$sub.Top)"

[SnapChatTest]::ShowWindow($script:chat, 5) | Out-Null
[SnapChatTest]::SetForegroundWindow($script:chat) | Out-Null
$cx = [int](($before.Left + $before.Right) / 2)
$cy = [int](($before.Top + $before.Bottom) / 2)
[SnapChatTest]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 200
[SnapChatTest]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[SnapChatTest]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
# Native menu: first Down selects the first item; second Down moves to 吸附桌宠.
[SnapChatTest]::keybd_event(0x28, 0, 0, [UIntPtr]::Zero)
[SnapChatTest]::keybd_event(0x28, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[SnapChatTest]::keybd_event(0x28, 0, 0, [UIntPtr]::Zero)
[SnapChatTest]::keybd_event(0x28, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[SnapChatTest]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
[SnapChatTest]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 800

$after = New-Object SnapChatTest+RECT
[SnapChatTest]::GetWindowRect($script:chat, [ref]$after) | Out-Null
"after  chat=$($after.Left),$($after.Top) $($after.Right-$after.Left)x$($after.Bottom-$after.Top)"
$overlap = ($after.Left -lt $sub.Right -and $sub.Left -lt $after.Right -and $after.Top -lt $sub.Bottom -and $sub.Top -lt $after.Bottom)
"subtitle overlap=$overlap"
