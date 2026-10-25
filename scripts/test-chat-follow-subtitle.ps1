Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FollowSubtitleTest {
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
$target = [uint32]$proc.Id
$script:subHandle = [IntPtr]::Zero
$script:chatHandle = [IntPtr]::Zero
$script:petHandle = [IntPtr]::Zero
$find = [FollowSubtitleTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [FollowSubtitleTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [FollowSubtitleTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [FollowSubtitleTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [FollowSubtitleTest]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq 'Tauri Window') {
      $rect = New-Object FollowSubtitleTest+RECT
      [FollowSubtitleTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -eq 640 -and $h -eq 120) { $script:subHandle = $hWnd }
      if ($w -ge 540 -and $w -lt 600 -and $h -ge 60 -and $h -lt 140) { $script:chatHandle = $hWnd }
      if ($w -eq 380 -and $h -eq 500) { $script:petHandle = $hWnd }
    }
  }
  return $true
}
[FollowSubtitleTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:subHandle -eq [IntPtr]::Zero -or $script:chatHandle -eq [IntPtr]::Zero) { 'windows not found'; exit 1 }

$subRect = New-Object FollowSubtitleTest+RECT
$chatRect = New-Object FollowSubtitleTest+RECT
[FollowSubtitleTest]::GetWindowRect($script:subHandle, [ref]$subRect) | Out-Null
[FollowSubtitleTest]::GetWindowRect($script:chatHandle, [ref]$chatRect) | Out-Null
"before sub=$($subRect.Left),$($subRect.Top) chat=$($chatRect.Left),$($chatRect.Top)"

# Turn off subtitle snap via its native menu (显示 / 吸附 / 背景).
[FollowSubtitleTest]::ShowWindow($script:subHandle, 5) | Out-Null
[FollowSubtitleTest]::SetForegroundWindow($script:subHandle) | Out-Null
$sx = [int](($subRect.Left + $subRect.Right) / 2)
$sy = [int](($subRect.Top + $subRect.Bottom) / 2)
[FollowSubtitleTest]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 150
[FollowSubtitleTest]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[FollowSubtitleTest]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 450
[FollowSubtitleTest]::keybd_event(0x28, 0, 0, [UIntPtr]::Zero)
[FollowSubtitleTest]::keybd_event(0x28, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[FollowSubtitleTest]::keybd_event(0x28, 0, 0, [UIntPtr]::Zero)
[FollowSubtitleTest]::keybd_event(0x28, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[FollowSubtitleTest]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
[FollowSubtitleTest]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700

$subAfterToggle = New-Object FollowSubtitleTest+RECT
$chatAfterToggle = New-Object FollowSubtitleTest+RECT
[FollowSubtitleTest]::GetWindowRect($script:subHandle, [ref]$subAfterToggle) | Out-Null
[FollowSubtitleTest]::GetWindowRect($script:chatHandle, [ref]$chatAfterToggle) | Out-Null
"toggled sub=$($subAfterToggle.Left),$($subAfterToggle.Top) chat=$($chatAfterToggle.Left),$($chatAfterToggle.Top)"

# Drag the free subtitle; the input bar should follow.
[FollowSubtitleTest]::SetForegroundWindow($script:subHandle) | Out-Null
$sx = [int](($subAfterToggle.Left + $subAfterToggle.Right) / 2)
$sy = [int](($subAfterToggle.Top + $subAfterToggle.Bottom) / 2)
[FollowSubtitleTest]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 150
[FollowSubtitleTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 10; $i++) {
  [FollowSubtitleTest]::SetCursorPos($sx + [int](100 * $i / 10), $sy + [int](70 * $i / 10)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[FollowSubtitleTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900

$subFinal = New-Object FollowSubtitleTest+RECT
$chatFinal = New-Object FollowSubtitleTest+RECT
[FollowSubtitleTest]::GetWindowRect($script:subHandle, [ref]$subFinal) | Out-Null
[FollowSubtitleTest]::GetWindowRect($script:chatHandle, [ref]$chatFinal) | Out-Null
"final sub=$($subFinal.Left),$($subFinal.Top) chat=$($chatFinal.Left),$($chatFinal.Top)"
"subtitle moved: $($subFinal.Left - $subAfterToggle.Left),$($subFinal.Top - $subAfterToggle.Top)"
"chat moved:     $($chatFinal.Left - $chatAfterToggle.Left),$($chatFinal.Top - $chatAfterToggle.Top)"
$overlap = ($chatFinal.Left -lt $subFinal.Right -and $subFinal.Left -lt $chatFinal.Right -and $chatFinal.Top -lt $subFinal.Bottom -and $subFinal.Top -lt $chatFinal.Bottom)
"subtitle overlap=$overlap"
