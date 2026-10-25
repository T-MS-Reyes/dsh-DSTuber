param(
  [string]$WindowName = 'DS Tuber 设置',
  [int]$Limit = 120
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  $WindowName
)
$window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (-not $window) {
  Write-Output "window not found: $WindowName"
  exit 1
}

Write-Output "window: $($window.Current.Name) class=$($window.Current.ClassName)"
$all = $window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$count = 0
foreach ($element in $all) {
  $name = $element.Current.Name
  $type = $element.Current.ControlType.ProgrammaticName
  if ($name) {
    Write-Output ("{0} | {1}" -f $type, $name)
    $count += 1
    if ($count -ge $Limit) { break }
  }
}
if ($count -eq 0) { Write-Output '(no named descendants)' }
