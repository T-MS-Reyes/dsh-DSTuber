param([int]$ProcessId = 0)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$target = if ($ProcessId -gt 0) {
  Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
} else {
  Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $target) { Write-Output 'no dsh-dstuber-shell process'; exit 0 }
$script:targetPid = [uint32]$target.Id
$script:rows = New-Object System.Collections.ArrayList

$callback = [WinEnum+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $script:targetPid) {
    $title = New-Object System.Text.StringBuilder 256
    $class = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($hWnd, $title, 256) | Out-Null
    [WinEnum]::GetClassName($hWnd, $class, 256) | Out-Null
    $wr = New-Object WinEnum+RECT
    $cr = New-Object WinEnum+RECT
    [WinEnum]::GetWindowRect($hWnd, [ref]$wr) | Out-Null
    [WinEnum]::GetClientRect($hWnd, [ref]$cr) | Out-Null
    $style = [WinEnum]::GetWindowLong($hWnd, -16)
    $exStyle = [WinEnum]::GetWindowLong($hWnd, -20)
    [void]$script:rows.Add([pscustomobject]@{
      Handle   = $hWnd
      Title    = $title.ToString()
      Class    = $class.ToString()
      Visible  = [WinEnum]::IsWindowVisible($hWnd)
      Style    = ('0x{0:X8}' -f $style)
      ExStyle  = ('0x{0:X8}' -f $exStyle)
      Topmost  = (($exStyle -band 0x8) -ne 0)
      ToolWin  = (($exStyle -band 0x80) -ne 0)
      AppWin   = (($exStyle -band 0x40000) -ne 0)
      Popup    = (($style -band 0x80000000) -ne 0)
      Caption  = (($style -band 0x00C00000) -ne 0)
      Window   = ('{0}x{1}@{2},{3}' -f ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top), $wr.Left, $wr.Top)
      Client   = ('{0}x{1}' -f ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top))
    })
  }
  return $true
}

[WinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$script:rows | Format-List
