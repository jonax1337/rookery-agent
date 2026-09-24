/** Loaded into the existing persistent PowerShell process, once per MCP session. */
export const ACCESSIBILITY = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
$null = [System.Windows.Automation.AutomationElement]::RootElement
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly([UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
$script:rkRefs = @{}
$script:rkPointer = $null

function Rk-Window($handle) {
  $h = [IntPtr][long]$handle
  if (-not [RkNative]::IsWindow($h)) { throw 'Window no longer exists. Call list_windows again.' }
  $h
}

function Rk-ElementActions($element) {
  $actions = @()
  foreach ($pair in @(
    @('InvokePattern', 'invoke'), @('ValuePattern', 'set_value'), @('TogglePattern', 'toggle'),
    @('SelectionItemPattern', 'select'), @('ExpandCollapsePattern', 'expand'), @('ScrollPattern', 'scroll_down')
  )) {
    $type = ('System.Windows.Automation.' + $pair[0]) -as [type]
    $pattern = $null
    if ($element.TryGetCurrentPattern($type::Pattern, [ref]$pattern)) {
      if ($pair[0] -ne 'ValuePattern' -or -not $pattern.Current.IsReadOnly) { $actions += $pair[1] }
      if ($pair[0] -eq 'ExpandCollapsePattern') { $actions += 'collapse' }
      if ($pair[0] -eq 'ScrollPattern') { $actions += 'scroll_up' }
    }
  }
  $actions
}

function Rk-Snapshot($handle, $maxNodes, $maxDepth, $observe = $true) {
  $h = Rk-Window $handle
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($observe) {
    $bounds = $root.Current.BoundingRectangle
    if ($script:rkPointer -and $script:rkPointer.window -eq $handle) {
      Rk-ShowPointer $handle $script:rkPointer.x $script:rkPointer.y 'Reading' | Out-Null
    } elseif (-not $bounds.IsEmpty) {
      Rk-ShowPointer $handle ($bounds.X + $bounds.Width / 2) ($bounds.Y + $bounds.Height / 2) 'Reading' | Out-Null
    }
  }
  $script:rkRefs = @{}
  $prefix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ element = $root; depth = 0 })
  $rows = New-Object System.Collections.ArrayList
  $truncated = $false
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt $maxNodes) {
    $item = $queue.Dequeue()
    $element = $item.element
    $visited++
    try {
      $c = $element.Current
      $ref = $prefix + ':' + $visited
      $script:rkRefs[$ref] = @{ element = $element; window = [long]$handle; pid = $root.Current.ProcessId }
      $rect = $c.BoundingRectangle
      $row = @{ ref = $ref; depth = $item.depth; name = $c.Name; role = $c.ControlType.ProgrammaticName.Replace('ControlType.', '');
        automationId = $c.AutomationId; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; password = $c.IsPassword;
        actions = @(Rk-ElementActions $element) }
      if (-not $rect.IsEmpty) { $row.bounds = @{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height } }
      if (-not $c.IsPassword) {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          $value = $pattern.Current.Value
          $row.value = $value.Substring(0, [Math]::Min(2000, $value.Length))
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
          $row.text = $pattern.DocumentRange.GetText(2000)
        }
      }
      [void]$rows.Add($row)
      $child = $walker.GetFirstChild($element)
      if ($item.depth -ge $maxDepth) { if ($null -ne $child) { $truncated = $true }; continue }
      while ($null -ne $child) {
        if (($visited + $queue.Count) -ge $maxNodes) { $truncated = $true; break }
        $queue.Enqueue(@{ element = $child; depth = $item.depth + 1 })
        $child = $walker.GetNextSibling($child)
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { $truncated = $true }
  }
  @{ window = [long]$handle; foreground = [long][RkNative]::GetForegroundWindow(); title = [RkNative]::Title($h); elements = @($rows.ToArray()); truncated = ($truncated -or $queue.Count -gt 0) }
}

function Rk-Act($ref, $action, $value) {
  Rk-Failsafe
  $before = [long][RkNative]::GetForegroundWindow()
  $entry = $script:rkRefs[$ref]
  if ($null -eq $entry) { throw 'Stale or unknown ref. Take a fresh snapshot before acting.' }
  $h = Rk-Window $entry.window
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($root.Current.ProcessId -ne $entry.pid) { throw 'Window identity changed. Take a fresh snapshot.' }
  $element = $entry.element
  if (-not $element.Current.IsEnabled) { throw 'The control is disabled.' }
  $actions = @(Rk-ElementActions $element)
  if ($actions -notcontains $action) { throw ('Unsupported action ' + $action + '. No physical-input fallback was used.') }
  $rect = $element.Current.BoundingRectangle
  $input = 'uia'
  $cursor = @{ visible = $false }
  if (-not $rect.IsEmpty) {
    $script:rkPointer = @{ window = $entry.window; x = $rect.X + $rect.Width / 2; y = $rect.Y + $rect.Height / 2 }
    $label = switch ($action) { 'set_value' { 'Typing' }; 'scroll_up' { 'Scrolling' }; 'scroll_down' { 'Scrolling' }; default { 'Clicking' } }
    $cursor = Rk-ShowPointer $entry.window $script:rkPointer.x $script:rkPointer.y $label
    if ($cursor.error) { throw ('Cannot show the computer-use cursor. No input sent: ' + $cursor.error) }
    if ($cursor.visible) {
      Rk-CursorSettle
      if ($label -eq 'Clicking') { Rk-CursorPulse 'Clicking' }
    }
  }
  switch ($action) {
    'invoke' { ([System.Windows.Automation.InvokePattern]$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
    'set_value' {
      if ([RkNative]::SetEditText([IntPtr]$element.Current.NativeWindowHandle, $value)) { $input = 'win32' }
      else { ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($value) }
    }
    'toggle' { ([System.Windows.Automation.TogglePattern]$element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Toggle() }
    'select' { ([System.Windows.Automation.SelectionItemPattern]$element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() }
    'expand' { ([System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand() }
    'collapse' { ([System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Collapse() }
    'scroll_up' { ([System.Windows.Automation.ScrollPattern]$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)).Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::SmallDecrement) }
    'scroll_down' { ([System.Windows.Automation.ScrollPattern]$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)).Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::SmallIncrement) }
  }
  @{ dispatched = $true; ref = $ref; action = $action; window = $entry.window; input = $input;
    cursor = $cursor; focusChanged = ($before -ne [long][RkNative]::GetForegroundWindow()); verification = 'Read a fresh snapshot to verify the result.' }
}
`;
