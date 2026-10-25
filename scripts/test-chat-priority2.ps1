Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MovePetTest2 {
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
$target = [uint32]$proc.Id
$script:petHandle = [IntPtr]::Zero
$script:chatHandle = [IntPtr]::Zero
$script:subHandle = [IntPtr]::Zero
$find = [MovePetTest2+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [MovePetTest2]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [MovePetTest2]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [MovePetTest2]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [MovePetTest2]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq 'Tauri Window') {
      $rect = New-Object MovePetTest2+RECT
      [MovePetTest2]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -eq 380 -and $h -eq 500) { $script:petHandle = $hWnd }
      if ($w -ge 540 -and $w -lt 600 -and $h -ge 60 -and $h -lt 120) { $script:chatHandle = $hWnd }
      if ($w -eq 640 -and $h -eq 120) { $script:subHandle = $hWnd }
    }
  }
  return $true
}
[MovePetTest2]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:petHandle -eq [IntPtr]::Zero) { 'pet not found'; exit 1 }
if ($script:chatHandle -eq [IntPtr]::Zero) { 'chat not found'; exit 1 }

$petBefore = New-Object MovePetTest2+RECT
[MovePetTest2]::GetWindowRect($script:petHandle, [ref]$petBefore) | Out-Null
"pet before=$($petBefore.Left),$($petBefore.Top) $($petBefore.Right-$petBefore.Left)x$($petBefore.Bottom-$petBefore.Top)"

[MovePetTest2]::ShowWindow($script:petHandle, 5) | Out-Null
[MovePetTest2]::SetForegroundWindow($script:petHandle) | Out-Null
$cx = [int](($petBefore.Left + $petBefore.Right) / 2)
$cy = [int](($petBefore.Top + $petBefore.Bottom) / 2)
[MovePetTest2]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 200
[MovePetTest2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 10; $i++) {
  [MovePetTest2]::SetCursorPos($cx, $cy + [int](140 * $i / 10)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[MovePetTest2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200

$petRect = New-Object MovePetTest2+RECT
$chatRect = New-Object MovePetTest2+RECT
$subRect = New-Object MovePetTest2+RECT
[MovePetTest2]::GetWindowRect($script:petHandle, [ref]$petRect) | Out-Null
[MovePetTest2]::GetWindowRect($script:chatHandle, [ref]$chatRect) | Out-Null
if ($script:subHandle -ne [IntPtr]::Zero) {
  [MovePetTest2]::GetWindowRect($script:subHandle, [ref]$subRect) | Out-Null
}
"pet after =$($petRect.Left),$($petRect.Top) $($petRect.Right-$petRect.Left)x$($petRect.Bottom-$petRect.Top)"
"sub       =$($subRect.Left),$($subRect.Top) $($subRect.Right-$subRect.Left)x$($subRect.Bottom-$subRect.Top)"
"chat      =$($chatRect.Left),$($chatRect.Top) $($chatRect.Right-$chatRect.Left)x$($chatRect.Bottom-$chatRect.Top)"
$overlap = ($chatRect.Left -lt $subRect.Right -and $subRect.Left -lt $chatRect.Right -and $chatRect.Top -lt $subRect.Bottom -and $subRect.Top -lt $chatRect.Bottom)
"subtitle overlap=$overlap"
