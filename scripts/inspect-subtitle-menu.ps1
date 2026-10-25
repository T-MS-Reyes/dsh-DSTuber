Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MenuInspect {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint owner);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr hMenu);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr hMenu, uint item, StringBuilder text, int max, uint flags);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr hMenu, uint item, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

$proc = Get-Process dsh-dstuber-shell -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { 'no shell'; exit 1 }
$target = [uint32]$proc.Id
$script:menu = [IntPtr]::Zero
$find = [MenuInspect+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [MenuInspect]::GetWindowThreadProcessId($hWnd, [ref]$owner) | Out-Null
  if ($owner -eq $target) {
    $class = New-Object System.Text.StringBuilder 128
    [MenuInspect]::GetClassName($hWnd, $class, 128) | Out-Null
    if ($class.ToString() -eq '#32768') { $script:menu = $hWnd }
  }
  return $true
}
[MenuInspect]::EnumWindows($find, [IntPtr]::Zero) | Out-Null
"menu hwnd=$($script:menu)"
if ($script:menu -ne [IntPtr]::Zero) {
  $hMenu = [MenuInspect]::GetMenu($script:menu)
  "hmenu=$hMenu"
  $count = [MenuInspect]::GetMenuItemCount($hMenu)
  "count=$count"
  for ($i = 0; $i -lt [Math]::Max($count, 0); $i++) {
    $text = New-Object System.Text.StringBuilder 256
    [MenuInspect]::GetMenuString($hMenu, [uint32]$i, $text, 256, 0x400) | Out-Null
    $state = [MenuInspect]::GetMenuState($hMenu, [uint32]$i, 0x400)
    "item[$i] text=$($text.ToString()) state=0x$($state.ToString('X')) checked=$([bool]($state -band 0x8))"
  }
}
# Close the menu.
[MenuInspect]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
[MenuInspect]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
