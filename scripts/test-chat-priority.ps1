Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MovePetTest {
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
$script:pet = [IntPtr]::Zero
$script:chat = [IntPtr]::Zero
$script:sub = [IntPtr]::Zero
$find = [MovePetTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [MovePetTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [MovePetTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [MovePetTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [MovePetTest]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq 'Tauri Window') {
      $rect = New-Object MovePetTest+RECT
      [MovePetTest]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -eq 380 -and $h -eq 500) { $script:pet = $hWnd }
      if ($w -ge 540 -and $w -lt 600 -and $h -ge 60 -and $h -lt 120) { $script:chat = $hWnd }
      if ($w -eq 640 -and $h -eq 120) { $script:sub = $hWnd }
    }
  }
  return $true
}
[MovePetTest]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
if ($script:pet -eq [IntPtr]::Zero) { 'pet not found'; exit 1 }
$pet = New-Object MovePetTest+RECT
[MovePetTest]::GetWindowRect($script:pet, [ref]$pet) | Out-Null
"pet before=$($pet.Left),$($pet.Top) $($pet.Right-$pet.Left)x$($pet.Bottom-$pet.Top)"
[MovePetTest]::ShowWindow($script:pet, 5) | Out-Null
[MovePetTest]::SetForegroundWindow($script:pet) | Out-Null
$cx = [int](($pet.Left + $pet.Right) / 2)
$cy = [int](($pet.Top + $pet.Bottom) / 2)
[MovePetTest]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 200
[MovePetTest]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 10; $i++) {
  [MovePetTest]::SetCursorPos($cx, $cy + [int](120 * $i / 10)) | Out-Null
  Start-Sleep -Milliseconds 35
}
[MovePetTest]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200

$chat = New-Object MovePetTest+RECT
$sub = New-Object MovePetTest+RECT
[MovePetTest]::GetWindowRect($script:chat, [ref]$chat) | Out-Null
[MovePetTest]::GetWindowRect($script:sub, [ref]$sub) | Out-Null
$pet2 = New-Object MovePetTest+RECT
[MovePetTest]::GetWindowRect($script:pet, [ref]$pet2) | Out-Null
"pet after =$($pet2.Left),$($pet2.Top) $($pet2.Right-$pet2.Left)x$($pet2.Bottom-$pet2.Top)"
"sub       =$($sub.Left),$($sub.Top) $($sub.Right-$sub.Left)x$($sub.Bottom-$sub.Top)"
"chat      =$($chat.Left),$($chat.Top) $($chat.Right-$chat.Left)x$($chat.Bottom-$chat.Top)"
$overlap = ($chat.Left -lt $sub.Right -and $sub.Left -lt $chat.Right -and $chat.Top -lt $sub.Bottom -and $sub.Top -lt $chat.Bottom)
"subtitle overlap=$overlap"
