import { CURSOR } from './cursor.js';

/** A process-owned WPF overlay; closing the MCP worker also removes the window. */
const OVERLAY = `
namespace Rookery {
  using System;
  using System.IO;
  using System.Threading;
  using System.Runtime.InteropServices;
  using System.Windows;
  using System.Windows.Controls;
  using System.Windows.Interop;
  using System.Windows.Media;
  using System.Windows.Media.Animation;
  using System.Windows.Media.Imaging;
  using System.Windows.Shapes;
  using System.Windows.Threading;

  public sealed class AgentPointer : Window {
    static AgentPointer pointer;
    static Dispatcher ui;
    static readonly ManualResetEvent ready = new ManualResetEvent(false);
    static Exception failure;
    static Thread worker;
    public static IntPtr Handle { get; private set; }
    readonly DispatcherTimer idle = new DispatcherTimer();
    readonly TextBlock label = new TextBlock();
    readonly Image glyph = new Image();
    readonly Border badge = new Border();
    readonly Ellipse pulse = new Ellipse();
    readonly Canvas canvas = new Canvas();
    bool capturing;
    bool shouldShow;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);

    AgentPointer(byte[] png) {
      Width = 220; Height = 104;
      WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
      AllowsTransparency = true; Background = Brushes.Transparent;
      ShowActivated = false; ShowInTaskbar = false; Topmost = true;
      Focusable = false; IsHitTestVisible = false;
      var bitmap = new BitmapImage();
      using (var stream = new MemoryStream(png)) {
        bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.StreamSource = stream; bitmap.EndInit(); bitmap.Freeze();
      }
      glyph.Source = bitmap; glyph.Width = 56; glyph.Height = 56;
      Canvas.SetTop(glyph, 28);
      pulse.Width = 28; pulse.Height = 28; pulse.Opacity = 0;
      pulse.Stroke = new SolidColorBrush(Color.FromRgb(131, 227, 209)); pulse.StrokeThickness = 1.5;
      pulse.RenderTransformOrigin = new Point(0.5, 0.5);
      pulse.RenderTransform = new ScaleTransform(1, 1);
      label.FontFamily = new FontFamily("Segoe UI"); label.FontSize = 11;
      label.Foreground = new SolidColorBrush(Color.FromRgb(238, 249, 245));
      label.Text = "Rookery · Ready";
      badge.Child = label; badge.CornerRadius = new CornerRadius(9);
      badge.Padding = new Thickness(11, 6, 11, 6);
      badge.Background = new SolidColorBrush(Color.FromArgb(240, 18, 30, 29));
      badge.BorderBrush = new SolidColorBrush(Color.FromArgb(90, 131, 227, 209));
      badge.BorderThickness = new Thickness(1);
      canvas.Children.Add(pulse); canvas.Children.Add(glyph); canvas.Children.Add(badge);
      Content = canvas;
      idle.Interval = TimeSpan.FromSeconds(2);
      idle.Tick += delegate { idle.Stop(); label.Text = "Rookery · Waiting"; };
      new WindowInteropHelper(this).EnsureHandle();
    }

    protected override void OnSourceInitialized(EventArgs e) {
      base.OnSourceInitialized(e);
      Handle = new WindowInteropHelper(this).Handle;
      // WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW.
      SetWindowLong(Handle, -20, GetWindowLong(Handle, -20) | 0x08000000 | 0x20 | 0x80);
      HwndSource.FromHwnd(Handle).AddHook(delegate(IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) {
        if (msg == 0x84) { handled = true; return new IntPtr(-1); } // HTTRANSPARENT
        if (msg == 0x21) { handled = true; return new IntPtr(3); }  // MA_NOACTIVATE
        return IntPtr.Zero;
      });
    }

    public static bool ShowPointer(byte[] png, long window, int x, int y, string action, bool follow) {
      if (worker == null) {
        worker = new Thread(delegate() {
          try { ui = Dispatcher.CurrentDispatcher; pointer = new AgentPointer(png); }
          catch (Exception error) { failure = error; }
          finally { ready.Set(); }
          if (failure == null) Dispatcher.Run();
        });
        worker.IsBackground = true; worker.SetApartmentState(ApartmentState.STA); worker.Start();
      }
      if (!ready.WaitOne(5000)) throw new TimeoutException("Cursor overlay startup timed out.");
      if (failure != null) throw new InvalidOperationException("Cursor overlay is unavailable.", failure);
      return (bool)ui.Invoke(new Func<bool>(delegate { return pointer.Place(new IntPtr(window), x, y, action, follow); }));
    }

    public static void Status(string action) {
      if (ui == null || pointer == null) return;
      ui.Invoke(new Action(delegate {
        pointer.label.Text = "Rookery · " + action;
        pointer.idle.Stop();
      }));
    }

    public static void Complete() {
      if (ui == null || pointer == null) return;
      ui.Invoke(new Action(delegate {
        if (pointer.shouldShow) pointer.idle.Start();
      }));
    }

    public static void Capture(bool hide) {
      if (ui == null || pointer == null) return;
      ui.Invoke(new Action(delegate {
        pointer.capturing = hide;
        if (hide) pointer.Hide();
        else if (pointer.shouldShow) pointer.Show();
      }));
    }

    public static string StatusText {
      get { return pointer == null ? "" : (string)ui.Invoke(new Func<string>(delegate { return pointer.label.Text; })); }
    }

    bool Place(IntPtr target, int x, int y, string action, bool follow) {
      bool wasVisible = IsVisible;
      double fromX = Left, fromY = Top;
      idle.Stop();
      // Never paint a background action over a different app covering its target.
      if (target != IntPtr.Zero) {
        Hide();
        if (!IsWindowVisible(target) || IsIconic(target) ||
            GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2) != target) {
          shouldShow = false;
          return false;
        }
      }
      var scale = HwndSource.FromHwnd(Handle).CompositionTarget.TransformToDevice;
      var area = System.Windows.Forms.Screen.FromPoint(new System.Drawing.Point(x, y)).WorkingArea;
      bool flip = x + 200 * scale.M11 > area.Right;
      double offset = flip ? 164 : 0;
      Canvas.SetLeft(glyph, offset);
      Canvas.SetLeft(pulse, offset + ${12 + CURSOR.hotspot} - 14);
      Canvas.SetTop(pulse, 28 + ${12 + CURSOR.hotspot} - 14);
      Canvas.SetLeft(badge, flip ? 0 : 40);
      Canvas.SetTop(badge, y + 60 * scale.M22 > area.Bottom ? 0 : 66);
      double toX = x / scale.M11 - ${12 + CURSOR.hotspot} - offset;
      double toY = y / scale.M22 - ${12 + CURSOR.hotspot} - 28;
      label.Text = "Rookery · " + action;
      BeginAnimation(LeftProperty, null); BeginAnimation(TopProperty, null);
      Left = toX; Top = toY;
      bool animate;
      animate = SystemParametersInfo(0x1042, 0, out animate, 0) && animate;
      if (wasVisible && !follow && animate) {
        var easing = new CubicEase { EasingMode = EasingMode.EaseOut };
        BeginAnimation(LeftProperty, new DoubleAnimation(fromX, toX, TimeSpan.FromMilliseconds(140)) { EasingFunction = easing });
        BeginAnimation(TopProperty, new DoubleAnimation(fromY, toY, TimeSpan.FromMilliseconds(140)) { EasingFunction = easing });
      }
      if (action == "Clicking" && animate) {
        pulse.BeginAnimation(OpacityProperty, new DoubleAnimation(0.8, 0, TimeSpan.FromMilliseconds(360)));
        var transform = (ScaleTransform)pulse.RenderTransform;
        transform.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.5, 1.6, TimeSpan.FromMilliseconds(360)));
        transform.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.5, 1.6, TimeSpan.FromMilliseconds(360)));
      }
      shouldShow = true;
      if (!capturing) Show();
      return true;
    }
  }
}
`;

/** Windows renders the shared SVG asset once, then reuses its bitmap. */
export const WINDOWS_CURSOR = `
$script:rkPointerBitmap = $null
$script:rkPointerPng = $null
function Rk-PointerBitmap {
  if ($null -ne $script:rkPointerBitmap) { return $script:rkPointerBitmap }
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  $visual = New-Object System.Windows.Media.DrawingVisual
  $drawing = $visual.RenderOpen()
  $fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('${CURSOR.fill}')
  $edge = [System.Windows.Media.BrushConverter]::new().ConvertFromString('${CURSOR.outline}')
  $pen = New-Object System.Windows.Media.Pen $edge, 1
  $pen.LineJoin = [System.Windows.Media.PenLineJoin]::Round
  $drawing.PushTransform((New-Object System.Windows.Media.TranslateTransform 12, 12))
  $drawing.PushTransform((New-Object System.Windows.Media.ScaleTransform (${CURSOR.size} / 24), (${CURSOR.size} / 24)))
  $drawing.DrawGeometry($fill, $pen, [System.Windows.Media.Geometry]::Parse('${CURSOR.path}'))
  $drawing.Close()
  $glow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $glow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('${CURSOR.glow}')
  $glow.BlurRadius = 8; $glow.ShadowDepth = 0; $glow.Opacity = 0.45
  $visual.Effect = $glow
  $image = New-Object System.Windows.Media.Imaging.RenderTargetBitmap 56, 56, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
  $image.Render($visual)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($image))
  $stream = New-Object System.IO.MemoryStream
  try {
    $encoder.Save($stream)
    $script:rkPointerPng = $stream.ToArray()
    $stream.Position = 0
    $bitmap = New-Object System.Drawing.Bitmap $stream
    try { $script:rkPointerBitmap = $bitmap.Clone() } finally { $bitmap.Dispose() }
  } finally { $stream.Dispose() }
  $script:rkPointerBitmap
}

function Rk-DrawPointer($graphics, $x, $y) {
  $image = Rk-PointerBitmap
  $graphics.DrawImage($image, [single]($x - ${12 + CURSOR.hotspot}), [single]($y - ${12 + CURSOR.hotspot}), 56, 56)
}

function Rk-ShowPointer($window, $x, $y, $action = 'Working', $follow = $false) {
  try {
    if ($null -eq ('Rookery.AgentPointer' -as [type])) {
      Add-Type -AssemblyName PresentationFramework
      Add-Type -ReferencedAssemblies @(
        'System.dll', 'System.Core.dll', 'System.Xaml.dll',
        [System.Windows.Forms.Form].Assembly.Location,
        [System.Drawing.Bitmap].Assembly.Location,
        [System.Windows.Window].Assembly.Location,
        [System.Windows.Media.Visual].Assembly.Location,
        [System.Windows.Threading.Dispatcher].Assembly.Location
      ) -TypeDefinition @'
${OVERLAY}
'@
    }
    Rk-PointerBitmap | Out-Null
    $shown = [Rookery.AgentPointer]::ShowPointer($script:rkPointerPng, $window, [int]$x, [int]$y, $action, $follow)
    $script:rkCursorFeedback = @{ visible = $shown; overlayHandle = [long][Rookery.AgentPointer]::Handle }
    $script:rkCursorFeedback
  } catch {
    # Display failure must never trigger a retry of an already-dispatched action.
    $script:rkCursorFeedback = @{ visible = $false; error = $_.Exception.Message }
    $script:rkCursorFeedback
  }
}

function Rk-CursorStatus($action) {
  if ($null -ne ('Rookery.AgentPointer' -as [type])) { [Rookery.AgentPointer]::Status($action) }
}

function Rk-CursorCapture($hide) {
  if ($null -ne ('Rookery.AgentPointer' -as [type])) { [Rookery.AgentPointer]::Capture($hide) }
}

function Rk-CursorDone {
  if ($null -ne ('Rookery.AgentPointer' -as [type])) { [Rookery.AgentPointer]::Complete() }
}

function Rk-ObserverState {
  if ($null -eq ('Rookery.AgentPointer' -as [type])) { return @{ visible = $false } }
  @{ visible = [RkNative]::IsWindowVisible([Rookery.AgentPointer]::Handle);
    overlayHandle = [long][Rookery.AgentPointer]::Handle; label = [Rookery.AgentPointer]::StatusText }
}

function Rk-InputPointer($action) {
  $point = Rk-Cursor
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $element) {
    $rect = $element.Current.BoundingRectangle
    if (-not $rect.IsEmpty -and -not $element.Current.IsOffscreen) {
      $point = @{ x = $rect.X + $rect.Width / 2; y = $rect.Y + $rect.Height / 2 }
    }
  }
  $feedback = Rk-ShowPointer 0 $point.x $point.y $action
  if ($feedback.error) { throw ('Cannot show the computer-use cursor. No input sent: ' + $feedback.error) }
}
`;
