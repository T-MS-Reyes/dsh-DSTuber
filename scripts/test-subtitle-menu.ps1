param(
  [switch]$ToggleSnap
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SubtitleTest {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
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
if (-not $proc) { Write-Output 'no shell process'; exit 1 }
$targetPid = [uint32]$proc.Id
$script:subtitle = [IntPtr]::Zero
$script:menu = [IntPtr]::Zero

$findWindows = [SubtitleTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SubtitleTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $targetPid -and [SubtitleTest]::IsWindowVisible($hWnd)) {
    $title = New-Object System.Text.StringBuilder 128
    [SubtitleTest]::GetWindowText($hWnd, $title, 128) | Out-Null
    $class = New-Object System.Text.StringBuilder 128
    [SubtitleTest]::GetClassName($hWnd, $class, 128) | Out-Null
    $probe = New-Object SubtitleTest+RECT
    [SubtitleTest]::GetWindowRect($hWnd, [ref]$probe) | Out-Null
    $width = $probe.Right - $probe.Left
    $height = $probe.Bottom - $probe.Top
    if ($title.ToString().StartsWith('DS Tuber') -and $width -eq 380 -and $height -eq 120) {
      $script:subtitle = $hWnd
    }
    if ($class.ToString() -eq '#32768') { $script:menu = $hWnd }
  }
  return $true
}

[SubtitleTest]::EnumWindows($findWindows, [IntPtr]::Zero) | Out-Null
if ($script:subtitle -eq [IntPtr]::Zero) { Write-Output 'subtitle window not found'; exit 1 }
$rect = New-Object SubtitleTest+RECT
[SubtitleTest]::GetWindowRect($script:subtitle, [ref]$rect) | Out-Null
$centerX = [int](($rect.Left + $rect.Right) / 2)
$centerY = [int](($rect.Top + $rect.Bottom) / 2)
Write-Output "subtitle rect=$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top) click=$centerX,$centerY"

[SubtitleTest]::ShowWindow($script:subtitle, 5) | Out-Null
[SubtitleTest]::SetForegroundWindow($script:subtitle) | Out-Null
Start-Sleep -Milliseconds 200
[SubtitleTest]::SetCursorPos($centerX, $centerY) | Out-Null
[SubtitleTest]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
[SubtitleTest]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700

$script:menu = [IntPtr]::Zero
$findMenu = [SubtitleTest+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [SubtitleTest]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $targetPid) {
    $class = New-Object System.Text.StringBuilder 128
    [SubtitleTest]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq '#32768' -and [SubtitleTest]::IsWindowVisible($hWnd)) {
      $script:menu = $hWnd
    }
  }
  return $true
}
[SubtitleTest]::EnumWindows($findMenu, [IntPtr]::Zero) | Out-Null
Write-Output "menuFound=$($script:menu -ne [IntPtr]::Zero)"

if ($script:menu -ne [IntPtr]::Zero) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  try {
    $menuElement = [System.Windows.Automation.AutomationElement]::FromHandle($script:menu)
    $items = $menuElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($item in $items) {
      if ($item.Current.Name) {
        Write-Output ("menu item: {0} | {1}" -f $item.Current.ControlType.ProgrammaticName, $item.Current.Name)
      }
    }
  } catch {
    Write-Output "uia error: $($_.Exception.Message)"
  }
  if ($ToggleSnap) {
    # Second item: 吸附桌宠
    foreach ($vk in @(0x28, 0x28, 0x0D)) {
      [SubtitleTest]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
      [SubtitleTest]::keybd_event([byte]$vk, 0, 0x0002, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 250
    }
    Start-Sleep -Milliseconds 500
  }
}
