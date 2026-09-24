/**
 * Reading and operating windows through UI Automation: the worker walks the
 * tree, the server prints it for the model.
 *
 * The model reads a snapshot as text, so its format is its cost: one line per
 * element, indented as a tree, defaults left out, and the centre already in
 * screenshot pixels so a control without an automation action can still be
 * clicked.
 */

export interface SnapshotElement {
  id: number;
  /** The parent's id; 0 for the window itself. */
  parent: number;
  ref: string;
  role: string;
  name: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  actions: string[];
  /** x, y, width, height in physical pixels. */
  bounds?: [number, number, number, number];
  value?: string;
  text?: string;
  password?: boolean;
}

export interface Snapshot {
  window: number;
  foreground: number;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
  /** The virtual desktop's origin and width, which desktop screenshots are scaled from. */
  screen: { left: number; top: number; width: number };
}

export interface ActResult {
  ref: string;
  action: string;
  role: string;
  name: string;
  input: 'uia' | 'win32';
  focusChanged: boolean;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…' : text);
const quote = (text: string, max: number): string => JSON.stringify(clip(text, max));
/** Console buffers and documents pad with spaces and blank lines; none of it is content. */
const tidy = (text: string): string => text.replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/ {2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();

/**
 * The snapshot as an indented tree. Containers without a name, value, text or
 * action are left out and their children move up a level: they carry no
 * information and cannot be acted on.
 */
export function describeSnapshot(snapshot: Snapshot, maxWidth: number): string {
  const scale = Math.min(1, maxWidth / snapshot.screen.width);
  const children = new Map<number, SnapshotElement[]>();
  for (const element of snapshot.elements) {
    const siblings = children.get(element.parent);
    if (siblings) siblings.push(element);
    else children.set(element.parent, [element]);
  }
  const lines = [
    'window=' + snapshot.window + ' ' + quote(snapshot.title, 200) + (snapshot.foreground === snapshot.window ? ' [active]' : ' (background)'),
  ];
  const visit = (element: SnapshotElement, level: number): void => {
    const text = element.text === undefined ? '' : tidy(element.text);
    const shown = element.parent === 0 || element.name || element.value !== undefined || text || element.actions.length;
    if (shown) {
      let line = '  '.repeat(level) + element.ref + ' ' + element.role;
      if (element.name) line += ' ' + quote(element.name, 150);
      else if (element.automationId) line += ' #' + element.automationId;
      if (element.value !== undefined && element.value !== element.name) line += ' value=' + quote(element.value, 300);
      if (text) line += ' text=' + quote(text, 600);
      if (element.actions.length) line += ' [' + element.actions.join(' ') + ']';
      if (element.password) line += ' password';
      if (!element.enabled) line += ' disabled';
      if (element.offscreen) line += ' offscreen';
      else if (element.bounds) {
        const [x, y, width, height] = element.bounds;
        line += ' @' + Math.round((x + width / 2 - snapshot.screen.left) * scale) + ',' + Math.round((y + height / 2 - snapshot.screen.top) * scale);
      }
      lines.push(line);
    }
    for (const child of children.get(element.id) ?? []) visit(child, shown ? level + 1 : level);
  };
  for (const root of children.get(0) ?? []) visit(root, 0);
  if (snapshot.truncated) lines.push('(truncated: raise maxNodes or depth, or snapshot a smaller window)');
  return lines.join('\n');
}

const DONE: Record<string, string> = {
  invoke: 'Invoked', set_value: 'Set the value of', toggle: 'Toggled', select: 'Selected',
  expand: 'Expanded', collapse: 'Collapsed', scroll_up: 'Scrolled up', scroll_down: 'Scrolled down',
};

/** What an act did, in one line. */
export function describeAct(result: ActResult): string {
  const target = result.role + (result.name ? ' ' + quote(result.name, 80) : '') + ' (' + result.ref + ')';
  return (DONE[result.action] ?? result.action) + ' ' + target + (result.input === 'win32' ? ' through its edit control' : '') + '.' +
    (result.focusChanged ? ' The app moved the foreground.' : '');
}

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
  $prefix = [Guid]::NewGuid().ToString('N').Substring(0, 6)
  $processId = $root.Current.ProcessId
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  # Breadth first, so a node budget keeps the top of the tree; parent links let the
  # server print it back as a tree.
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ element = $root; depth = 0; parent = 0 })
  $rows = New-Object System.Collections.ArrayList
  $truncated = $false
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt $maxNodes) {
    $item = $queue.Dequeue()
    $element = $item.element
    try {
      $c = $element.Current
      $row = @{ id = $visited + 1; parent = $item.parent; name = $c.Name; role = $c.ControlType.ProgrammaticName.Replace('ControlType.', '');
        automationId = $c.AutomationId; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; actions = @(Rk-ElementActions $element) }
      $rect = $c.BoundingRectangle
      $password = $c.IsPassword
    } catch {
      # A provider that vanished or failed mid-walk costs its subtree, not the snapshot.
      $truncated = $true
      continue
    }
    $visited++
    $row.ref = $prefix + ':' + $visited
    $script:rkRefs[$row.ref] = @{ element = $element; window = [long]$handle; pid = $processId; role = $row.role; name = $row.name }
    if (-not $rect.IsEmpty) { $row.bounds = @($rect.X, $rect.Y, $rect.Width, $rect.Height) }
    if ($password) { $row.password = $true }
    else {
      try {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          $value = [string]$pattern.Current.Value
          $row.value = $value.Substring(0, [Math]::Min(2000, $value.Length))
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
          $row.text = $pattern.DocumentRange.GetText(2000)
        }
      } catch { }
    }
    [void]$rows.Add($row)
    try {
      $child = $walker.GetFirstChild($element)
      if ($item.depth -ge $maxDepth) { if ($null -ne $child) { $truncated = $true }; continue }
      while ($null -ne $child) {
        if (($visited + $queue.Count) -ge $maxNodes) { $truncated = $true; break }
        $queue.Enqueue(@{ element = $child; depth = $item.depth + 1; parent = $visited })
        $child = $walker.GetNextSibling($child)
      }
    } catch { $truncated = $true }
  }
  $screen = Rk-Bounds
  @{ window = [long]$handle; foreground = [long][RkNative]::GetForegroundWindow(); title = [RkNative]::Title($h); elements = @($rows.ToArray());
    truncated = ($truncated -or $queue.Count -gt 0); screen = @{ left = $screen.Left; top = $screen.Top; width = $screen.Width } }
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
  @{ ref = $ref; action = $action; role = $entry.role; name = $entry.name; input = $input;
    cursor = $cursor; focusChanged = ($before -ne [long][RkNative]::GetForegroundWindow()) }
}
`;
