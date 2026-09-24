import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateComputerCall } from '../dist/computer/validation.js';
import { PowerShellSession, powershellBinary } from '../dist/computer/powershell.js';
import { builtinSkill } from '../dist/skills/builtin.js';
import { playwrightCliPath } from '../dist/tools/catalog.js';
import { createServer } from 'node:http';

function server(mode = 'background', script = fileURLToPath(new URL('../dist/computer/mcp-server.js', import.meta.url)), args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ROOKERY_COMPUTER_MODE: mode, ROOKERY_COMPUTER_DIR: '' },
  });
  let seq = 0;
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  child.stderr.resume();
  reader.on('line', (line) => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); });
  return {
    request(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)); }, 20_000);
        pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); resolve(msg.result ?? msg.error); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    call(name, args = {}) { return this.request('tools/call', { name, arguments: args }); },
    close() { child.stdin.end(); reader.close(); },
  };
}

test('computer validates every batch step and enforces background boundaries', () => {
  for (const [name, args] of [
    ['click', { x: 2, y: 3 }], ['type_text', { text: 'no' }], ['focus_window', { title: 'x' }],
    ['clipboard', { action: 'set', text: 'x' }], ['open', { target: 'notepad' }],
  ]) assert.throws(() => validateComputerCall(name, args, true), /Background-only/);
  assert.throws(() => validateComputerCall('click', { x: null, y: 5 }), /Invalid/);
  assert.throws(() => validateComputerCall('click', { x: -1, y: 5 }), /Invalid/);
  assert.throws(() => validateComputerCall('act', { ref: 'a', action: 'set_value' }), /requires value/);
  assert.throws(() => validateComputerCall('batch', { actions: [{ tool: 'act', arguments: { ref: 'a', action: 'toggle' } }, { tool: 'click', arguments: { x: 0, y: 0 } }] }, true), /Background-only/);
  validateComputerCall('batch', { actions: [{ tool: 'act', arguments: { ref: 'a', action: 'set_value', value: '' } }], window: 123 }, true);
  assert.deepEqual(validateComputerCall('click', { x: 2, y: 3 }).args, { x: 2, y: 3, button: 'left', count: 1 });
  assert.throws(() => validateComputerCall('batch', { actions: [
    { tool: 'wait', arguments: {} }, { tool: 'press_keys', arguments: { keys: 'ctrl+unknown' } },
  ] }), /Unknown key/, 'all steps are checked before dispatch');
  assert.match(builtinSkill('computer-use').body, /not rolled back/);
});

test('native cursor glides to an exact point and returns without clicking', {
  skip: process.platform !== 'win32' || process.env.ROOKERY_COMPUTER_TEST_CURSOR !== '1',
}, async () => {
  const shell = new PowerShellSession();
  try {
    const result = await shell.run(`
      $before = Rk-Cursor
      $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point $before.x, $before.y)).Bounds
      $x = if ($before.x + 60 -lt $screen.Right) { $before.x + 60 } else { $before.x - 60 }
      $animate = $false
      $supported = [RkNative]::SystemParametersInfo(0x1042, 0, [ref]$animate, 0)
      try {
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        Rk-Move $x $before.y | Out-Null
        $elapsed = $clock.Elapsed.TotalMilliseconds
        $after = Rk-Cursor
        @{ x = $x; y = $before.y; after = $after; elapsed = $elapsed; animated = $animate; supported = $supported }
      } finally { Rk-Move $before.x $before.y | Out-Null }
    `);
    assert.equal(result.supported, true);
    assert.deepEqual(result.after, { x: result.x, y: result.y });
    if (result.animated) assert.ok(result.elapsed >= 70, 'movement traverses intermediate frames');
    console.log('Native cursor: exact destination, no clicks, original position restored; ' + Math.round(result.elapsed) + ' ms.');
  } finally { shell.close(); }
});

test('computer browser cursor hook works through the real Playwright MCP in headless mode', {
  skip: process.platform !== 'win32' || process.env.ROOKERY_COMPUTER_TEST_UI !== '1', timeout: 60_000,
}, async () => {
  const web = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body><h1>Rookery background browser</h1><label>Draft <input id="draft"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Apply</button><output></output></body></html>');
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'rookery-browser-test-'));
  const mcp = server('background', playwrightCliPath(), ['--browser', 'msedge', '--headless', '--isolated', '--output-dir', dir, '--init-page', fileURLToPath(new URL('../dist/computer/browser-init.js', import.meta.url))]);
  const shell = new PowerShellSession();
  const snapshotText = (result) => {
    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const path = text.match(/\[Snapshot\]\(([^)]+)\)/)?.[1];
    return path ? readFileSync(path, 'utf8') : text;
  };
  try {
    const before = await shell.run('@{ foreground = [long][RkNative]::GetForegroundWindow(); cursor = (Rk-Cursor) }');
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rookery-test', version: '1' } });
    const navigation = await mcp.call('browser_navigate', { url: 'http://127.0.0.1:' + web.address().port });
    assert.notEqual(navigation.isError, true, JSON.stringify(navigation));
    const snapshot = snapshotText(navigation);
    const ref = snapshot.match(/textbox "Draft" \[ref=(\w+)\]/)?.[1];
    assert.ok(ref, snapshot);
    const typed = await mcp.call('browser_type', { target: ref, text: 'Works without desktop focus' });
    assert.notEqual(typed.isError, true, JSON.stringify(typed));
    const state = await mcp.call('browser_snapshot');
    assert.match(snapshotText(state), /Works without desktop focus/);
    const button = snapshotText(state).match(/button "Apply" \[ref=(\w+)\]/)?.[1];
    assert.ok(button);
    const clicked = await mcp.call('browser_click', { target: button });
    assert.notEqual(clicked.isError, true, JSON.stringify(clicked));
    assert.match(snapshotText(clicked), /status \[ref=\w+\]: Works without desktop focus/);
    const shotPath = join(dir, 'browser-proof.png');
    const shot = await mcp.call('browser_take_screenshot', { type: 'png', scale: 'css', filename: shotPath });
    assert.notEqual(shot.isError, true, JSON.stringify(shot));
    assert.ok(existsSync(shotPath));
    const after = await shell.run('@{ foreground = [long][RkNative]::GetForegroundWindow(); cursor = (Rk-Cursor) }');
    assert.deepEqual(after, before);
    console.log('Headless Playwright MCP: cursor init loaded, form edited, desktop focus and pointer unchanged. Screenshot: ' + join(dir, 'browser-proof.png'));
  } finally { mcp.close(); shell.close(); web.close(); }
});

test('computer MCP serializes batches, stops promptly and rejects queued actions', { skip: process.platform !== 'win32' }, async () => {
  const mcp = server();
  try {
    const hello = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(hello.serverInfo.name, 'computer');
    const list = await mcp.request('tools/list');
    assert.ok(list.tools.some((tool) => tool.name === 'snapshot'));
    const rejected = await mcp.call('click', { x: 3, y: 3 });
    assert.equal(rejected.isError, true);
    const batch = mcp.call('batch', { actions: [{ tool: 'wait', arguments: { ms: 1500 } }, { tool: 'wait', arguments: { ms: 1500 } }], observe: 'none' });
    const queued = mcp.call('wait', { ms: 1 });
    await sleep(100);
    const start = performance.now();
    assert.equal((await mcp.call('stop')).isError, false);
    assert.ok(performance.now() - start < 1000, 'stop bypasses the action queue');
    assert.equal((await batch).isError, true);
    assert.equal((await queued).isError, true);
  } finally { mcp.close(); }
});

// Run explicitly on a desktop: ROOKERY_COMPUTER_TEST_UI=1 node --test this-file.
// The test app shows without activation. No physical mouse/keyboard input is sent.
test('computer UIA edits an unfocused window, with a visible virtual cursor', {
  skip: process.platform !== 'win32' || process.env.ROOKERY_COMPUTER_TEST_UI !== '1', timeout: 60_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rookery-computer-test-'));
  const handlePath = join(dir, 'window.txt');
  const appPath = join(dir, 'app.ps1');
  writeFileSync(appPath, `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
public class BackgroundForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; }
  }
}
"@
$window = New-Object BackgroundForm
$window.Text = 'Rookery Computer Use Test'; $window.Width = 640; $window.Height = 380
$window.TopMost = $true
$window.StartPosition = 'Manual'; $window.Left = 60; $window.Top = 60
$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Rookery / Background computer use'; $heading.AutoSize = $true
$heading.Location = New-Object System.Drawing.Point 24, 24
$window.Controls.Add($heading)
$editor = New-Object System.Windows.Forms.TextBox
$editor.AccessibleName = 'Draft'; $editor.Text = 'Waiting for background input'
$editor.Location = New-Object System.Drawing.Point 24, 80; $editor.Width = 560
$window.Controls.Add($editor)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Apply'; $button.Location = New-Object System.Drawing.Point 24, 130
$button.Width = 560; $button.Height = 40
$button.Add_Click({ $status.Text = 'Applied: ' + $editor.Text })
$window.Controls.Add($button)
$status = New-Object System.Windows.Forms.Label
$status.Text = 'Ready'; $status.Location = New-Object System.Drawing.Point 24, 190
$status.AutoSize = $true; $window.Controls.Add($status)
$window.Add_Shown({ [System.IO.File]::WriteAllText('${handlePath.replaceAll("'", "''")}', $window.Handle.ToInt64().ToString()) })
[System.Windows.Forms.Application]::Run($window)
`);
  const shell = new PowerShellSession();
  const mcp = server();
  const app = spawn(powershellBinary(), ['-NoProfile', '-STA', '-File', appPath], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(handlePath); i++) await sleep(100);
    const handle = Number(readFileSync(handlePath, 'utf8'));
    const before = await shell.run('@{ foreground = [long][RkNative]::GetForegroundWindow(); cursor = (Rk-Cursor) }');
    assert.notEqual(before.foreground, handle, 'test window must be unfocused');
    const snapshot = await mcp.call('snapshot', { window: handle });
    assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
    const tree = JSON.parse(snapshot.content[0].text);
    const editor = tree.elements.find((e) => e.name === 'Draft');
    const button = tree.elements.find((e) => e.name === 'Apply' && e.actions.includes('invoke'));
    assert.ok(editor?.actions.includes('set_value'), JSON.stringify(tree));
    assert.ok(button, JSON.stringify(tree));
    const result = await mcp.call('batch', { actions: [
      { tool: 'act', arguments: { ref: editor.ref, action: 'set_value', value: 'Background editing works.' } },
      { tool: 'act', arguments: { ref: editor.ref, action: 'set_value', value: 'Fast. Visible. In the background.' } },
    ], window: handle, observe: 'snapshot' });
    assert.equal(result.isError, false, JSON.stringify(result));
    const actions = JSON.parse(result.content[0].text).completed;
    for (const action of actions) {
      const feedback = JSON.parse(action.content[0].text);
      assert.equal(feedback.cursor.error, undefined, 'native cursor overlay must initialize');
      assert.equal(feedback.cursor.visible, true, 'native cursor is visible over the unfocused test window');
    }
    const overlayHandle = JSON.parse(actions.at(-1).content[0].text).cursor.overlayHandle;
    const overlay = await shell.run(`@{ visible = [RkNative]::IsWindowVisible([IntPtr]${overlayHandle}); styles = [RkNative]::GetWindowLong([IntPtr]${overlayHandle}, -20) }`);
    assert.equal(overlay.visible, true, 'the OS reports a real visible overlay window');
    assert.equal(overlay.styles & 0x08000020, 0x08000020, 'overlay cannot activate and passes input through');
    const updated = JSON.parse(result.content[1].text);
    assert.equal(updated.elements.find((e) => e.name === 'Draft').value, 'Fast. Visible. In the background.');
    const after = await shell.run('@{ foreground = [long][RkNative]::GetForegroundWindow(); cursor = (Rk-Cursor) }');
    assert.deepEqual(after, before, 'neither foreground nor physical cursor changed');
    await sleep(2200);
    assert.equal(await shell.run(`[RkNative]::IsWindowVisible([IntPtr]${overlayHandle})`), true, 'overlay remains visible between model calls');
    const info = await mcp.call('screen_info');
    assert.match(info.content[0].text, /Rookery · Waiting/);
    const liveView = await shell.run(`
      $rect = New-Object RkNative+RECT
      [RkNative]::GetWindowRect([IntPtr]${handle}, [ref]$rect) | Out-Null
      $image = New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top)
      $graphics = [System.Drawing.Graphics]::FromImage($image)
      $stream = New-Object System.IO.MemoryStream
      try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $image.Size)
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        @{ png = [Convert]::ToBase64String($stream.ToArray()) }
      } finally { $graphics.Dispose(); $image.Dispose(); $stream.Dispose() }
    `);
    const livePath = join(dir, 'live-observer.png');
    writeFileSync(livePath, Buffer.from(liveView.png, 'base64'));
    console.log('Actual Windows overlay capture: ' + livePath);
    const stale = await mcp.call('act', { ref: editor.ref, action: 'set_value', value: 'stale' });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /Stale/);
    const shot = await mcp.call('screenshot', { window: handle });
    assert.equal(shot.isError, false, JSON.stringify(shot.content.filter((c) => c.type !== 'image')));
    const output = join(dir, 'background-proof.png');
    writeFileSync(output, Buffer.from(shot.content.find((c) => c.type === 'image').data, 'base64'));
    console.log(JSON.stringify({ screenshot: output, foregroundUnchanged: true, cursorUnchanged: true, batchTiming: result.content.at(-1).text }));
    // InvokePattern may activate an app through its own provider; verify its
    // effect separately from the focus-preserving set_value path above.
    const invoked = await mcp.call('act', { ref: updated.elements.find((e) => e.name === 'Apply' && e.actions.includes('invoke')).ref, action: 'invoke' });
    const dispatch = JSON.parse(invoked.content[0].text);
    assert.equal(dispatch.dispatched, true);
    if (dispatch.focusChanged) {
      assert.equal(invoked.isError, true, 'background mode reports provider-driven focus changes');
      assert.equal((await mcp.call('wait', { ms: 1 })).isError, true, 'remaining actions are stopped');
    } else assert.equal(invoked.isError, false);
    const applied = await mcp.call('snapshot', { window: handle });
    assert.match(JSON.stringify(applied), /Applied: Fast\. Visible\. In the background\./);
    await mcp.call('stop');
    // Exercise the path from the reported run: ordinary coordinate input,
    // with no act calls that could accidentally initialize the overlay for it.
    if (process.env.ROOKERY_COMPUTER_TEST_CURSOR === '1') {
      const desktop = server('desktop');
      try {
        await desktop.call('focus_window', { title: 'Rookery Computer Use Test' });
        assert.equal(await shell.run('[long][RkNative]::GetForegroundWindow()'), handle, 'only inject into the disposable test app');
        const screen = await shell.run('Rk-ScreenInfo');
        const scale = Math.min(1, 1280 / screen.width);
        const point = { x: (editor.bounds.x + editor.bounds.width / 2 - screen.left) * scale, y: (editor.bounds.y + editor.bounds.height / 2 - screen.top) * scale };
        assert.equal((await desktop.call('screenshot')).isError, false);
        for (const [tool, args, state] of [
          ['click', point, 'Clicking'],
          ['press_keys', { keys: 'ctrl+a' }, 'Keyboard'],
          ['type_text', { text: 'Visible through native mouse and keyboard.' }, 'Typing'],
          ['scroll', { ...point, direction: 'down', amount: 1 }, 'Scrolling'],
        ]) {
          const response = await desktop.call(tool, args);
          assert.equal(response.isError, false, JSON.stringify(response));
          const details = await desktop.call('screen_info');
          const observer = JSON.parse(details.content[0].text.split('Observer: ')[1]);
          assert.equal(observer.visible, true, tool + ' must show the custom cursor');
          assert.equal(observer.label, 'Rookery · ' + state);
        }
        const details = await desktop.call('screen_info');
        const observer = JSON.parse(details.content[0].text.split('Observer: ')[1]);
        await desktop.call('stop');
        for (let i = 0; i < 20 && await shell.run(`[RkNative]::IsWindow([IntPtr]${observer.overlayHandle})`); i++) await sleep(50);
        assert.equal(await shell.run(`[RkNative]::IsWindow([IntPtr]${observer.overlayHandle})`), false, 'stop destroys the native observer window');
        await desktop.call('snapshot', { window: handle });
        const stoppedInfo = await desktop.call('screen_info');
        assert.equal(JSON.parse(stoppedInfo.content[0].text.split('Observer: ')[1]).visible, false, 'observing after stop must not reopen the cursor');
        console.log('Desktop observer: click, keyboard, typing, scrolling and stop verified.');
      } finally {
        desktop.close();
        await shell.run(`if ([long][RkNative]::GetForegroundWindow() -eq ${handle}) { [RkNative]::Focus([IntPtr]${before.foreground}) | Out-Null }; @{ ok = $true }`);
      }
    }
  } finally { mcp.close(); shell.close(); app.kill(); }
});
