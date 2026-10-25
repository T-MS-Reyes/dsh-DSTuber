param(
  [switch]$SendKeys
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class UiTest {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
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

$pet = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pet) { Write-Output 'no shell process'; exit 1 }
$hwnd = $pet.MainWindowHandle
$rect = New-Object UiTest+RECT
[UiTest]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$centerX = [int](($rect.Left + $rect.Right) / 2)
$centerY = [int](($rect.Top + $rect.Bottom) / 2)
Write-Output "pet pid=$($pet.Id) rect=$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top) click=$centerX,$centerY"

# Right click on the pet to open the native menu.
[UiTest]::ShowWindow($hwnd, 5) | Out-Null
[UiTest]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 250
[UiTest]::SetCursorPos($centerX, $centerY) | Out-Null
[UiTest]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[UiTest]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600

$script:menuFound = $false
$script:pidTarget = [uint32]$pet.Id
$callback = [UiTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [UiTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $script:pidTarget) {
    $class = New-Object System.Text.StringBuilder 128
    [UiTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $name = $class.ToString()
    if ($name -eq '#32768' -and [UiTest]::IsWindowVisible($hWnd)) {
      $script:menuFound = $true
      Write-Output "menu window: $hWnd class=$name"
    }
  }
  return $true
}
[UiTest]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
Write-Output "menuFound=$script:menuFound"

if ($SendKeys -and $script:menuFound) {
  # 设置… -> 大小 -> 小 (first submenu item)
  foreach ($vk in @(0x28, 0x28, 0x27, 0x0D)) {
    [UiTest]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [UiTest]::keybd_event([byte]$vk, 0, 0x0002, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 800
  $after = New-Object UiTest+RECT
  [UiTest]::GetWindowRect($hwnd, [ref]$after) | Out-Null
  Write-Output ("after size: {0}x{1}" -f ($after.Right - $after.Left), ($after.Bottom - $after.Top))
}
