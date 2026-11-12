// Agent Hub 화면 도우미(Windows) — 허브가 csc.exe(.NET Framework 4, Windows 기본)로 컴파일해서 띄운다.
// 표준 입력: 한 줄에 명령 하나(ASCII). 표준 출력: [종류 1바이트][길이 4바이트 LE][내용]
//   info              → J {"monitors":[{x,y,w,h,primary}]}
//   frame m w q       → F JPEG | S(관리자 확인 창·잠금 화면이라 못 찍음) | E 오류 글
//   move m x y        (x·y 는 그 모니터 안 0..1)
//   down m x y b / up m x y b   (b: 0 왼쪽 1 오른쪽 2 가운데)
//   wheel m x y dy    (dy: 120 = 위로 한 칸)
//   key d vk / key u vk
//   text base64(UTF-8)  → 글자 그대로 넣기(입력기 거치지 않음)
//   indicator 1|0     → 이 PC 화면 위쪽에 "원격으로 보는 중" 표시
// 답을 기다리지 않는 명령이 실패하면 L(기록만, 허브는 버린다)
// C# 5 문법만(csc v4): 문자열 보간·?. 없음.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Helper {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  // x64 전용으로 컴파일(/platform:x64): 공용체는 8바이트 뒤, 크기 40
  [StructLayout(LayoutKind.Explicit)] struct INPUT {
    [FieldOffset(0)] public int type;
    [FieldOffset(8)] public MOUSEINPUT mi;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }

  static Stream stdout;
  static Screen[] screens;
  static Indicator indicator;

  [STAThread]
  static void Main() {
    // 화면 배율(125%·150%)과 상관없이 실제 픽셀로 찍고 움직이게
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
    stdout = Console.OpenStandardOutput();
    screens = Screen.AllScreens;
    var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = reader.ReadLine()) != null) {
      var a = line.Trim().Split(' ');
      try { Handle(a); }
      catch (Exception e) { Write(a[0] == "info" || a[0] == "frame" ? 'E' : 'L', Encoding.UTF8.GetBytes(e.Message)); } // 답을 기다리는 명령만 E, 나머지는 L(기록만)
    }
    if (indicator != null) indicator.Close();
  }

  static void Write(char type, byte[] data) {
    var head = new byte[5];
    head[0] = (byte)type;
    BitConverter.GetBytes(data.Length).CopyTo(head, 1);
    stdout.Write(head, 0, 5);
    stdout.Write(data, 0, data.Length);
    stdout.Flush();
  }

  static Screen Mon(string s) {
    int m;
    if (!int.TryParse(s, out m) || m < 0 || m >= screens.Length) m = 0;
    return screens[m];
  }

  static Point At(Screen mon, string xs, string ys) {
    var b = mon.Bounds;
    double x = Clamp(double.Parse(xs, System.Globalization.CultureInfo.InvariantCulture));
    double y = Clamp(double.Parse(ys, System.Globalization.CultureInfo.InvariantCulture));
    return new Point(b.X + (int)Math.Round(x * (b.Width - 1)), b.Y + (int)Math.Round(y * (b.Height - 1)));
  }
  static double Clamp(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  static readonly uint[] DOWN = { 0x0002, 0x0008, 0x0020 };
  static readonly uint[] UP = { 0x0004, 0x0010, 0x0040 };

  static void Handle(string[] a) {
    switch (a[0]) {
      case "info": {
        screens = Screen.AllScreens;
        var sb = new StringBuilder("{\"monitors\":[");
        for (int i = 0; i < screens.Length; i++) {
          var b = screens[i].Bounds;
          if (i > 0) sb.Append(',');
          sb.Append("{\"x\":").Append(b.X).Append(",\"y\":").Append(b.Y).Append(",\"w\":").Append(b.Width).Append(",\"h\":").Append(b.Height).Append(",\"primary\":").Append(screens[i].Primary ? "true" : "false").Append('}');
        }
        sb.Append("]}");
        Write('J', Encoding.UTF8.GetBytes(sb.ToString()));
        break;
      }
      case "frame": Frame(Mon(a[1]), int.Parse(a[2]), int.Parse(a[3])); break;
      case "move": { var p = At(Mon(a[1]), a[2], a[3]); SetCursorPos(p.X, p.Y); break; }
      case "down":
      case "up": {
        var p = At(Mon(a[1]), a[2], a[3]);
        int b = int.Parse(a[4]);
        if (b < 0 || b > 2) break;
        SetCursorPos(p.X, p.Y);
        mouse_event(a[0] == "down" ? DOWN[b] : UP[b], 0, 0, 0, UIntPtr.Zero);
        break;
      }
      case "wheel": {
        var p = At(Mon(a[1]), a[2], a[3]);
        SetCursorPos(p.X, p.Y);
        mouse_event(0x0800, 0, 0, Math.Max(-1200, Math.Min(1200, int.Parse(a[4]))), UIntPtr.Zero);
        break;
      }
      case "key": {
        int vk = int.Parse(a[2]);
        if (vk <= 0 || vk > 254) break;
        uint f = a[1] == "u" ? 0x0002u : 0u;
        if (Extended(vk)) f |= 0x0001;
        keybd_event((byte)vk, (byte)MapVirtualKey((uint)vk, 0), f, UIntPtr.Zero);
        break;
      }
      case "text": Text(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); break;
      case "indicator": Indicate(a[1] == "1"); break;
    }
  }

  // 방향키·Insert·Delete·Home·End·PgUp·PgDn·오른쪽 Ctrl/Alt·Win·NumLock·나누기
  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0xA3 || vk == 0xA5 || vk == 0x90 || vk == 0x6F || vk == 0x2C;
  }

  static void Text(string s) {
    var list = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { // 줄바꿈은 Enter 로
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
        continue;
      }
      var down = new INPUT { type = 1 };
      down.ki.wScan = c;
      down.ki.dwFlags = 0x0004; // KEYEVENTF_UNICODE
      var up = down;
      up.ki.dwFlags = 0x0004 | 0x0002;
      list.Add(down);
      list.Add(up);
    }
    if (list.Count > 0) SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  static ImageCodecInfo jpeg;
  static void Frame(Screen mon, int maxW, int quality) {
    // 관리자 확인 창(보안 데스크톱)·잠금 화면이면 입력 데스크톱을 열 수 없다 → 못 찍는다고 알린다
    IntPtr desk = OpenInputDesktop(0, false, 0x0100); // DESKTOP_READOBJECTS
    if (desk == IntPtr.Zero) { Write('S', new byte[0]); return; }
    CloseDesktop(desk);
    var b = mon.Bounds;
    using (var shot = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb)) {
      try {
        using (var g = Graphics.FromImage(shot)) {
          g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy);
          DrawCursor(g, b);
        }
      } catch (System.ComponentModel.Win32Exception) { Write('S', new byte[0]); return; }
      int w = Math.Max(160, Math.Min(maxW, b.Width));
      int h = (int)Math.Round((double)b.Height * w / b.Width);
      Bitmap outImg = shot;
      Bitmap scaled = null;
      if (w != b.Width) {
        scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(scaled)) {
          g.InterpolationMode = InterpolationMode.Bilinear;
          g.PixelOffsetMode = PixelOffsetMode.Half;
          g.DrawImage(shot, 0, 0, w, h);
        }
        outImg = scaled;
      }
      if (jpeg == null) foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
      var p = new EncoderParameters(1);
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(95, quality)));
      using (var ms = new MemoryStream()) {
        outImg.Save(ms, jpeg, p);
        Write('F', ms.ToArray());
      }
      if (scaled != null) scaled.Dispose();
    }
  }

  static void DrawCursor(Graphics g, Rectangle b) {
    var ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0) return;
    ICONINFO ii;
    int hx = 0, hy = 0;
    if (GetIconInfo(ci.hCursor, out ii)) {
      hx = ii.xHotspot; hy = ii.yHotspot;
      if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
      if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, ci.pt.x - b.X - hx, ci.pt.y - b.Y - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
    finally { g.ReleaseHdc(hdc); }
  }

  static void Indicate(bool on) {
    if (indicator == null) {
      if (!on) return;
      var ready = new ManualResetEvent(false);
      var t = new Thread(() => {
        indicator = new Indicator();
        indicator.HandleCreated += (s, e) => ready.Set();
        Application.Run(indicator);
      });
      t.IsBackground = true;
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      ready.WaitOne(3000);
    }
    var f = indicator;
    if (f == null || !f.IsHandleCreated) return;
    f.BeginInvoke((Action)(() => { if (on) f.ShowBar(); else f.Hide(); }));
  }
}

/** 이 PC 화면 위 가운데 작은 띠 — 누르거나 포커스를 가져가지 않고, 원격 화면에는 찍히지 않는다 */
class Indicator : Form {
  public Indicator() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(201, 100, 66);
    ForeColor = Color.White;
    Font = new Font("Malgun Gothic", 9f, FontStyle.Bold);
    var label = new Label { Text = "원격으로 화면 보는 중", AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
    Controls.Add(label);
    Size = new Size(180, 26);
    Opacity = 0.92;
    var wa = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(wa.X + (wa.Width - Width) / 2, wa.Y);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= 0x00000080 | 0x08000000 | 0x00000020 | 0x00080000; // TOOLWINDOW | NOACTIVATE | TRANSPARENT | LAYERED
      return cp;
    }
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    try { Helper.SetWindowDisplayAffinity(Handle, 0x11); } catch { } // WDA_EXCLUDEFROMCAPTURE(Win10 2004+)
  }
  public void ShowBar() {
    var wa = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(wa.X + (wa.Width - Width) / 2, wa.Y);
    if (!Visible) Show();
  }
}
