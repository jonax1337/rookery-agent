import { compiledSource } from './assemblies.js';
import { CURSOR } from './cursor.js';

/**
 * A process-owned WPF overlay; closing the MCP worker also removes the window.
 *
 * All motion runs here in C#, never in PowerShell script: one step is one
 * SetCursorPos plus one SetWindowPos on a steady ~2 ms cadence, so the real
 * pointer and the overlay move together and every refresh shows a fresh step.
 * Positions are physical pixels throughout; the window offset of the tip is
 * the only place the DPI scale enters.
 */
export const OVERLAY = `
namespace Rookery {
  using System;
  using System.Diagnostics;
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
    // Where the tip of the pointer sits inside the 56 px glyph bitmap.
    const double Tip = ${12 + CURSOR.hotspot};
    // Stopwatch timestamp of the last mouse event a human made (not injected); 0 until then.
    static long humanAt;
    static Thread watcher;
    static HookProc hook;
    static AgentPointer pointer;
    static Dispatcher ui;
    static readonly ManualResetEvent ready = new ManualResetEvent(false);
    static Exception failure;
    static Thread worker;
    static readonly object gate = new object();
    static double tipX, tipY, offsetX, offsetY;
    static int ticket;
    static Thread mover;
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
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
    // MOUSEINPUT is the largest member of the INPUT union, so this has the native size.
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] struct HOOKINFO { public POINT pt; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint message; public IntPtr w, l; public uint time; public POINT pt; }
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

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
      glyph.RenderTransformOrigin = new Point(Tip / 56, Tip / 56);
      glyph.RenderTransform = new ScaleTransform(1, 1);
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
      // WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW: never focused, never hit.
      SetWindowLong(Handle, -20, GetWindowLong(Handle, -20) | 0x08000000 | 0x20 | 0x80);
      HwndSource.FromHwnd(Handle).AddHook(delegate(IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) {
        if (msg == 0x84) { handled = true; return new IntPtr(-1); } // HTTRANSPARENT
        if (msg == 0x21) { handled = true; return new IntPtr(3); }  // MA_NOACTIVATE
        return IntPtr.Zero;
      });
    }

    /** Start the overlay thread once; throws if the overlay cannot exist. */
    public static void Start(byte[] png) {
      if (worker == null) {
        worker = new Thread(delegate() {
          try { ui = Dispatcher.CurrentDispatcher; pointer = new AgentPointer(png); }
          catch (Exception error) { failure = error; }
          finally { ready.Set(); }
          if (failure == null) Dispatcher.Run();
        });
        worker.IsBackground = true; worker.SetApartmentState(ApartmentState.STA); worker.Start();
        Watch();
      }
      if (!ready.WaitOne(5000)) throw new TimeoutException("Cursor overlay startup timed out.");
      if (failure != null) throw new InvalidOperationException("Cursor overlay is unavailable.", failure);
      if (watcher == null) throw new InvalidOperationException("Cannot watch for the user taking over the mouse.");
    }

    /**
     * A low-level mouse hook on its own message loop. It only notes when a
     * human touched the mouse: injected events carry LLMHF_INJECTED, so our own
     * moves never count, while a user grabbing the mouse always does. There is
     * deliberately no keyboard hook: a script installing one is what keyloggers
     * look like, and antivirus (AMSI) blocks the whole worker for it.
     */
    static void Watch() {
      var installed = new ManualResetEvent(false);
      bool ok = false;
      var thread = new Thread(delegate() {
        hook = delegate(int code, IntPtr w, IntPtr l) {
          if (code >= 0 && (((HOOKINFO)Marshal.PtrToStructure(l, typeof(HOOKINFO))).flags & 0x1) == 0)
            Interlocked.Exchange(ref humanAt, Stopwatch.GetTimestamp());
          return CallNextHookEx(IntPtr.Zero, code, w, l);
        };
        ok = SetWindowsHookEx(14, hook, GetModuleHandle(null), 0) != IntPtr.Zero; // WH_MOUSE_LL
        installed.Set();
        if (!ok) return;
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
      });
      thread.IsBackground = true; thread.Start();
      installed.WaitOne(5000);
      if (ok) watcher = thread;
    }

    /**
     * Put the overlay at a point. Without follow it travels there on its own
     * thread; Settle waits for it. False when a background target is covered.
     */
    public static bool ShowPointer(long window, int x, int y, string action, bool follow) {
      int my = Interlocked.Increment(ref ticket);
      int was = (int)ui.Invoke(new Func<int>(delegate { return pointer.Begin(new IntPtr(window), x, y, action); }));
      if (was < 0) return false;
      double fromX, fromY;
      lock (gate) { fromX = tipX; fromY = tipY; }
      int ms = follow || was == 0 ? 0 : Duration(Distance(fromX, fromY, x, y));
      if (ms == 0) { MoveTo(x, y, false); Reveal(); return true; }
      Reveal();
      var thread = new Thread(delegate() { Animate(my, false, 0, 0, fromX, fromY, x, y, ms); });
      thread.IsBackground = true; mover = thread; thread.Start();
      return true;
    }

    /** Wait until an overlay-only move has arrived. */
    public static void Settle() {
      Thread thread = mover;
      if (thread != null) thread.Join(1000);
    }

    /** Move the real pointer to a point on a slight arc, the overlay with it. Null on arrival, else why it stopped. */
    public static string Glide(int x, int y, string action) {
      int my = Interlocked.Increment(ref ticket);
      Settle();
      POINT start; GetCursorPos(out start);
      int was = (int)ui.Invoke(new Func<int>(delegate { return pointer.Begin(IntPtr.Zero, x, y, action); }));
      double fromX = start.X, fromY = start.Y;
      if (was == 1) { lock (gate) { fromX = tipX; fromY = tipY; } }
      else MoveTo(fromX, fromY, false);
      Reveal();
      return Animate(my, true, start.X, start.Y, fromX, fromY, x, y, Duration(Distance(start.X, start.Y, x, y)));
    }

    /**
     * Draw a whole picture in one call. packed is the stroke count, then per
     * stroke its point count and its x, y pairs. Each stroke: a quick pen-up
     * hop to its start, press, trace, release. Null when done, else why it
     * stopped; the button is always released.
     */
    public static string Draw(int[] packed, bool right, string action) {
      int count = packed[0];
      int my = Interlocked.Increment(ref ticket);
      Settle();
      POINT now; GetCursorPos(out now);
      ui.Invoke(new Func<int>(delegate { return pointer.Begin(IntPtr.Zero, now.X, now.Y, action); }));
      MoveTo(now.X, now.Y, false);
      Reveal();
      uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
      long since = Stopwatch.GetTimestamp();
      timeBeginPeriod(1);
      try {
        for (int k = 0, at = 1; k < count; k++) {
          int n = packed[at++];
          var points = new int[2 * n];
          Array.Copy(packed, at, points, 0, 2 * n);
          at += 2 * n;
          if (count > 1) Label(action + " · " + (k + 1) + "/" + count);
          GetCursorPos(out now);
          double hop = Distance(now.X, now.Y, points[0], points[1]);
          // Pen up: a short, fast hop; the show is the ink, not the travel.
          int ms = hop < 3 ? 0 : (int)Math.Min(140, 40 + 20 * Math.Log(1 + hop / 24, 2));
          string stop = Animate(my, true, now.X, now.Y, now.X, now.Y, points[0], points[1], ms);
          if (stop != null) return stop;
          if (Interlocked.Read(ref humanAt) > since) return TakenOver;
          Button(down);
          try {
            // Short holds at both ends let apps tell a stroke from a click.
            Thread.Sleep(8);
            if (n > 1) {
              stop = Trace(points, since);
              if (stop != null) return stop;
              Thread.Sleep(8);
            }
          } finally { Button(up); }
        }
        return null;
      } finally { timeEndPeriod(1); }
    }

    /**
     * Trace a polyline with the held button: straight segments, every vertex
     * hit exactly, a short dwell at sharp corners so apps that sample the
     * pointer per frame cannot round them off, and no two consecutive events
     * more than 2 px apart, because stamp brushes (calligraphy, watercolour)
     * paint only where an event lands.
     */
    static string Trace(int[] points, long since) {
      int n = points.Length / 2;
      var along = new double[n];
      for (int i = 1; i < n; i++) along[i] = along[i - 1] + Distance(points[2 * i - 2], points[2 * i - 1], points[2 * i], points[2 * i + 1]);
      double length = along[n - 1];
      // About 3.5 px per ms of ink, eased; long strokes are capped rather than slowed further.
      int ms = (int)Math.Min(4000, Math.Max(40, length / 3.5));
      int px = points[0], py = points[1];
      string stop;
      var clock = Stopwatch.StartNew();
      double paused = 0;
      int next = 1;
      while (true) {
        double t = Math.Min(1, (clock.Elapsed.TotalMilliseconds - paused) / ms);
        double d = t * t * t * (10 - 15 * t + 6 * t * t) * length;
        for (; next < n && along[next] <= d; next++) {
          stop = Ink(points[2 * next], points[2 * next + 1], ref px, ref py, since);
          if (stop != null) return stop;
          if (next < n - 1 && Sharp(points, next)) {
            double before = clock.Elapsed.TotalMilliseconds;
            Thread.Sleep(8);
            paused += clock.Elapsed.TotalMilliseconds - before;
          }
        }
        if (next < n && along[next] > along[next - 1]) {
          double f = (d - along[next - 1]) / (along[next] - along[next - 1]);
          int ax = points[2 * next - 2], ay = points[2 * next - 1];
          stop = Ink((int)Math.Round(ax + (points[2 * next] - ax) * f), (int)Math.Round(ay + (points[2 * next + 1] - ay) * f), ref px, ref py, since);
          if (stop != null) return stop;
        }
        if (t >= 1) { Land(points[2 * n - 2], points[2 * n - 1]); return null; }
        Pace(clock);
      }
    }

    /** Move from (px, py) to (x, y) in events at most 2 px apart, sent as one batch. */
    static string Ink(int x, int y, ref int px, ref int py, long since) {
      if (Interlocked.Read(ref humanAt) > since) return TakenOver;
      int count = Math.Max(1, (int)Math.Ceiling(Distance(px, py, x, y) / 2));
      var screen = System.Windows.Forms.SystemInformation.VirtualScreen;
      var inputs = new INPUT[count];
      for (int i = 1; i <= count; i++)
        inputs[i - 1] = Move((int)Math.Round(px + (x - px) * (double)i / count), (int)Math.Round(py + (y - py) * (double)i / count), screen);
      if (SendInput((uint)count, inputs, Marshal.SizeOf(typeof(INPUT))) != count)
        return "Stopped: Windows refused the pointer input (a secure or elevated window is in front). Take a fresh screenshot.";
      px = x; py = y;
      MoveTo(x, y, true);
      return null;
    }

    /** A button press or release, injected like the moves. */
    static void Button(uint flags) {
      var input = new INPUT[1];
      input[0].mi.flags = flags;
      SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Label(string text) {
      ui.BeginInvoke(new Action(delegate {
        pointer.label.Text = "Rookery · " + text;
        pointer.idle.Stop();
      }));
    }

    /** Click feedback at the current tip: a ripple and a short press of the glyph. */
    public static void Pulse(string action) {
      if (ui == null || pointer == null) return;
      ui.BeginInvoke(new Action(delegate {
        pointer.label.Text = "Rookery · " + action;
        pointer.idle.Stop();
        if (Animations()) pointer.Ripple();
      }));
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

    /** UI thread: -1 covered target (hidden), 0 was hidden, 1 was visible. */
    int Begin(IntPtr target, int x, int y, string action) {
      idle.Stop();
      // Never paint a background action over a different app covering its target.
      // The overlay itself is transparent to WindowFromPoint, so it need not hide first.
      if (target != IntPtr.Zero && (!IsWindowVisible(target) || IsIconic(target) ||
          GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2) != target)) {
        shouldShow = false;
        Hide();
        return -1;
      }
      label.Text = "Rookery · " + action;
      int was = IsVisible ? 1 : 0;
      Layout(x, y);
      return was;
    }

    /** UI thread: keep the badge on screen at the destination and remember where the tip sits. */
    void Layout(int x, int y) {
      var scale = HwndSource.FromHwnd(Handle).CompositionTarget.TransformToDevice;
      var area = System.Windows.Forms.Screen.FromPoint(new System.Drawing.Point(x, y)).WorkingArea;
      bool flip = x + 200 * scale.M11 > area.Right;
      double left = flip ? 164 : 0;
      Canvas.SetLeft(glyph, left);
      Canvas.SetLeft(pulse, left + Tip - 14);
      Canvas.SetTop(pulse, 28 + Tip - 14);
      Canvas.SetLeft(badge, flip ? 0 : 40);
      Canvas.SetTop(badge, y + 60 * scale.M22 > area.Bottom ? 0 : 66);
      double tx, ty;
      lock (gate) { offsetX = (left + Tip) * scale.M11; offsetY = (28 + Tip) * scale.M22; tx = tipX; ty = tipY; }
      // A flipped layout must not make the visible tip jump.
      if (IsVisible) MoveTo(tx, ty, false);
    }

    void Ripple() {
      var fade = new QuadraticEase { EasingMode = EasingMode.EaseOut };
      pulse.BeginAnimation(OpacityProperty, new DoubleAnimation(0.85, 0, TimeSpan.FromMilliseconds(380)) { EasingFunction = fade });
      var ring = (ScaleTransform)pulse.RenderTransform;
      var grow = new DoubleAnimation(0.4, 1.7, TimeSpan.FromMilliseconds(380)) { EasingFunction = fade };
      ring.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
      ring.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
      var press = (ScaleTransform)glyph.RenderTransform;
      var squeeze = new DoubleAnimation(1, 0.82, TimeSpan.FromMilliseconds(70)) { AutoReverse = true, EasingFunction = new QuadraticEase() };
      press.BeginAnimation(ScaleTransform.ScaleXProperty, squeeze);
      press.BeginAnimation(ScaleTransform.ScaleYProperty, squeeze);
    }

    static void Reveal() {
      ui.Invoke(new Action(delegate {
        pointer.shouldShow = true;
        if (!pointer.capturing) pointer.Show();
      }));
    }

    /** One SetWindowPos per frame; async so a busy UI thread never stalls the pointer. */
    static void MoveTo(double x, double y, bool async) {
      int left, top;
      lock (gate) {
        tipX = x; tipY = y;
        left = (int)Math.Round(x - offsetX); top = (int)Math.Round(y - offsetY);
      }
      // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER [| SWP_ASYNCWINDOWPOS]
      SetWindowPos(Handle, IntPtr.Zero, left, top, 0, 0, 0x0001u | 0x0004u | 0x0010u | 0x0200u | (async ? 0x4000u : 0u));
    }

    static bool Animations() {
      bool enabled;
      return !SystemParametersInfo(0x1042, 0, out enabled, 0) || enabled; // SPI_GETCLIENTAREAANIMATION
    }

    static double Distance(double ax, double ay, double bx, double by) {
      return Math.Sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    }

    /** Fitts-like: short hops are quick, long travel grows only logarithmically. */
    static int Duration(double distance) {
      if (distance < 3 || !Animations()) return 0;
      return (int)Math.Min(280, 90 + 30 * Math.Log(1 + distance / 24, 2));
    }

    /** Control point of a slight arc, as a hand moves; straight for short hops, kept on screen. */
    static void Arc(double ax, double ay, double bx, double by, out double cx, out double cy) {
      double dx = bx - ax, dy = by - ay, d = Math.Sqrt(dx * dx + dy * dy);
      cx = (ax + bx) / 2; cy = (ay + by) / 2;
      if (d < 60) return;
      double bend = Math.Min(40, d * 0.08) * (dx >= 0 ? -1 : 1) / d;
      var screen = System.Windows.Forms.SystemInformation.VirtualScreen;
      cx = Math.Max(screen.Left, Math.Min(screen.Right - 1, cx - dy * bend));
      cy = Math.Max(screen.Top, Math.Min(screen.Bottom - 1, cy + dx * bend));
    }

    static double Curve(double a, double c, double b, double s) {
      return (1 - s) * (1 - s) * a + 2 * (1 - s) * s * c + s * s * b;
    }

    /**
     * Step every ~2 ms instead of waiting on DwmFlush: with displays of mixed
     * refresh rates its clock beats (3-10 ms steps on a 240 Hz screen). A fine,
     * steady cadence means every refresh shows a position at most 2 ms old.
     */
    static void Pace(Stopwatch clock) {
      double next = clock.Elapsed.TotalMilliseconds + 2;
      while (clock.Elapsed.TotalMilliseconds < next) Thread.Sleep(1);
    }

    const string TakenOver = "Stopped: the user moved the mouse, so the agent let go. Nothing further was sent. Take a fresh screenshot before continuing.";

    /**
     * One real mouse move, injected like hardware input so apps that read
     * pointer or raw input (Paint, canvases, games) see it; SetCursorPos alone
     * only teleports the cursor. NOCOALESCE keeps every step, so corners and
     * curves survive. Refuses once a human touched the mouse since the motion began.
     */
    static string Step(int x, int y, long since, bool follow) {
      if (Interlocked.Read(ref humanAt) > since) return TakenOver;
      var input = new[] { Move(x, y, System.Windows.Forms.SystemInformation.VirtualScreen) };
      if (SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) != 1)
        return "Stopped: Windows refused the pointer input (a secure or elevated window is in front). Take a fresh screenshot.";
      if (follow) MoveTo(x, y, true);
      return null;
    }

    /** An absolute, uncoalesced move to a pixel of the virtual desktop. */
    static INPUT Move(int x, int y, System.Drawing.Rectangle screen) {
      var input = new INPUT();
      // The smallest normalized value that lands in pixel x: Windows floors n * width / 65536.
      input.mi.dx = (int)Math.Ceiling((x - screen.Left) * 65536.0 / screen.Width);
      input.mi.dy = (int)Math.Ceiling((y - screen.Top) * 65536.0 / screen.Height);
      input.mi.flags = 0x0001 | 0x2000 | 0x4000 | 0x8000; // MOVE | MOVE_NOCOALESCE | VIRTUALDESK | ABSOLUTE
      return input;
    }

    /** Injected moves apply asynchronously; wait for the last one, then pin the exact pixel. */
    static void Land(int x, int y) {
      var clock = Stopwatch.StartNew();
      POINT now;
      while (GetCursorPos(out now) && (now.X != x || now.Y != y) && clock.ElapsedMilliseconds < 30) Thread.Sleep(1);
      if (now.X != x || now.Y != y) SetCursorPos(x, y);
    }

    /** A turn of more than 30 degrees at vertex i. */
    static bool Sharp(int[] p, int i) {
      double ax = p[2 * i] - p[2 * i - 2], ay = p[2 * i + 1] - p[2 * i - 1];
      double bx = p[2 * i + 2] - p[2 * i], by = p[2 * i + 3] - p[2 * i + 1];
      double la = Math.Sqrt(ax * ax + ay * ay), lb = Math.Sqrt(bx * bx + by * by);
      return la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < 0.866;
    }

    static string Animate(int my, bool cursor, int sx, int sy, double fx, double fy, int x, int y, int ms) {
      double cpx, cpy, opx, opy;
      Arc(sx, sy, x, y, out cpx, out cpy);
      Arc(fx, fy, x, y, out opx, out opy);
      long since = Stopwatch.GetTimestamp();
      timeBeginPeriod(1);
      try {
        var clock = Stopwatch.StartNew();
        while (true) {
          if (Thread.VolatileRead(ref ticket) != my) return null; // A newer move took over the overlay.
          double t = ms <= 0 ? 1 : Math.Min(1, clock.Elapsed.TotalMilliseconds / ms);
          double s = t * t * t * (10 - 15 * t + 6 * t * t); // minimum jerk: no snap at either end
          if (cursor) {
            string stop = Step((int)Math.Round(Curve(sx, cpx, x, s)), (int)Math.Round(Curve(sy, cpy, y, s)), since, false);
            if (stop != null) return stop;
          }
          MoveTo(Curve(fx, opx, x, s), Curve(fy, opy, y, s), true);
          if (t >= 1) { if (cursor) Land(x, y); return null; }
          Pace(clock);
        }
      } finally { timeEndPeriod(1); }
    }
  }
}
`;
export const OVERLAY_FILES = compiledSource('overlay', OVERLAY);

/** Windows renders the shared SVG asset once, then reuses its bitmap. */
export const WINDOWS_CURSOR = `
$script:rkPointerBitmap = $null
$script:rkPointerPng = $null
$script:rkOverlay = $false
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

# Compile and start the overlay once; throws while it cannot exist.
function Rk-Overlay {
  if ($script:rkOverlay) { return }
  Add-Type -AssemblyName PresentationFramework
  $refs = @(
    'System.dll', 'System.Core.dll', 'System.Xaml.dll',
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Bitmap].Assembly.Location,
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.Visual].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location
  )
  Rk-Assembly '${OVERLAY_FILES.assembly.replace(/'/g, "''")}' '${OVERLAY_FILES.source.replace(/'/g, "''")}' 'Rookery.AgentPointer' $refs
  Rk-PointerBitmap | Out-Null
  [Rookery.AgentPointer]::Start($script:rkPointerPng)
  $script:rkOverlay = $true
}

function Rk-ShowPointer($window, $x, $y, $action = 'Working', $follow = $false) {
  try {
    Rk-Overlay
    $shown = [Rookery.AgentPointer]::ShowPointer($window, [int]$x, [int]$y, $action, [bool]$follow)
    $script:rkCursorFeedback = @{ visible = $shown; overlayHandle = [long][Rookery.AgentPointer]::Handle }
    $script:rkCursorFeedback
  } catch {
    # Display failure must never trigger a retry of an already-dispatched action.
    $script:rkCursorFeedback = @{ visible = $false; error = $_.Exception.Message }
    $script:rkCursorFeedback
  }
}

# Move the real pointer with the overlay; throws before any motion if the overlay is missing.
function Rk-Glide($x, $y, $action = 'Moving') {
  Rk-Failsafe
  try { Rk-Overlay } catch { throw ('Cannot show the computer-use cursor. No input sent: ' + $_.Exception.Message) }
  $stopped = [Rookery.AgentPointer]::Glide([int]$x, [int]$y, $action)
  $script:rkCursorFeedback = @{ visible = $true; overlayHandle = [long][Rookery.AgentPointer]::Handle }
  if ($stopped) { throw $stopped }
  $script:rkPointer = @{ window = [long][RkNative]::GetForegroundWindow(); x = $x; y = $y }
}

# Draw packed strokes (count, then per stroke its point count and x,y pairs) in one native call.
# The server sends them as base64 Int32 data; a drag passes a small int array directly.
function Rk-Draw($packed, $button = 'left', $action = 'Drawing') {
  Rk-Failsafe
  try { Rk-Overlay } catch { throw ('Cannot show the computer-use cursor. No input sent: ' + $_.Exception.Message) }
  if ($packed -is [string]) {
    $bytes = [Convert]::FromBase64String($packed)
    $ints = New-Object int[] ($bytes.Length / 4)
    [Buffer]::BlockCopy($bytes, 0, $ints, 0, $bytes.Length)
    $packed = $ints
  }
  $stopped = [Rookery.AgentPointer]::Draw([int[]]$packed, ($button -eq 'right'), $action)
  $script:rkCursorFeedback = @{ visible = $true; overlayHandle = [long][Rookery.AgentPointer]::Handle }
  if ($stopped) { throw $stopped }
  $c = Rk-Cursor
  $script:rkPointer = @{ window = [long][RkNative]::GetForegroundWindow(); x = $c.x; y = $c.y }
  @{ ok = $true }
}

function Rk-CursorSettle {
  if ($script:rkOverlay) { [Rookery.AgentPointer]::Settle() }
}

function Rk-CursorPulse($action) {
  if ($script:rkOverlay) { [Rookery.AgentPointer]::Pulse($action) }
}

function Rk-CursorStatus($action) {
  if ($script:rkOverlay) { [Rookery.AgentPointer]::Status($action) }
}

function Rk-CursorCapture($hide) {
  if ($script:rkOverlay) { [Rookery.AgentPointer]::Capture($hide) }
}

function Rk-CursorDone {
  if ($script:rkOverlay) { [Rookery.AgentPointer]::Complete() }
}

function Rk-ObserverState {
  if (-not $script:rkOverlay) { return @{ visible = $false } }
  @{ visible = [RkNative]::IsWindowVisible([Rookery.AgentPointer]::Handle);
    overlayHandle = [long][Rookery.AgentPointer]::Handle; label = [Rookery.AgentPointer]::StatusText }
}

# Travel to the focused control and arrive before a single key is sent.
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
  Rk-CursorSettle
}
`;
