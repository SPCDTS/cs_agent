
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Desktop
{
    private const int FrameLifetimeMs = 30000;
    private const uint KeyUp = 0x0002;
    private const uint Unicode = 0x0004;
    private const uint Extended = 0x0001;
    private const uint LeftDown = 0x0002, LeftUp = 0x0004, RightDown = 0x0008, RightUp = 0x0010;
    private static readonly Dictionary<string, ushort> KeyCodes = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        { "CTRL", 0x11 }, { "CONTROL", 0x11 }, { "SHIFT", 0x10 }, { "ALT", 0x12 }, { "WIN", 0x5B },
        { "ENTER", 0x0D }, { "TAB", 0x09 }, { "ESC", 0x1B }, { "ESCAPE", 0x1B }, { "BACKSPACE", 0x08 },
        { "DELETE", 0x2E }, { "INSERT", 0x2D }, { "HOME", 0x24 }, { "END", 0x23 },
        { "PAGEUP", 0x21 }, { "PAGEDOWN", 0x22 }, { "SPACE", 0x20 },
        { "LEFT", 0x25 }, { "UP", 0x26 }, { "RIGHT", 0x27 }, { "DOWN", 0x28 }
    };

    internal static object Run(string directory, Helper.Request request)
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        using (var mutex = new Mutex(false, @"Local\CsAgentHypervDesktopV1"))
        {
            bool acquired;
            try { acquired = mutex.WaitOne(250); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) return Helper.Failed("desktop_unavailable");
            try
            {
                if (Helper.Cancelled(directory, request)) return new { state = "cancelled" };
                Snapshot current = GetSnapshot(request.desktopSid);
                if (current == null) return Helper.Failed("desktop_unavailable");
                if (request.kind == "screen") return Capture(directory, request, current);

                long age = Helper.Now - (request.frame == null ? 0 : request.frame.capturedAt);
                if (request.frame == null || age < 0 || age >= FrameLifetimeMs || request.frame.stamp != current.Stamp)
                    return Helper.Failed("desktop_frame_stale");
                Input[] events = BuildInput(current, request.action);
                if (events == null) return Helper.Failed("desktop_invalid_input");
                if (Helper.Cancelled(directory, request)) return new { state = "cancelled" };
                if (!StillCurrent(request, current)) return Helper.Failed("desktop_unavailable");
                return Send(events);
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private sealed class Snapshot
    {
        internal string Stamp;
        internal Rectangle Bounds;
        internal Rectangle[] Monitors;
    }

    private static Snapshot GetSnapshot(string sid)
    {
        int session;
        using (var process = Process.GetCurrentProcess()) session = process.SessionId;
        if (session == 0 || !IsActive(session) || !IsDefaultDesktop()) return null;
        using (var identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null || identity.User.Value != sid) return null;
            TokenStatistics stats;
            int size;
            if (!GetTokenInformation(identity.Token, 10, out stats, Marshal.SizeOf(typeof(TokenStatistics)), out size)) return null;
            var bounds = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
            if (bounds.Width < 1 || bounds.Height < 1 || bounds.Width > 8192 || bounds.Height > 8192 ||
                (long)bounds.Width * bounds.Height > 18000000) return null;
            var monitors = Screen.AllScreens.OrderBy(screen => screen.DeviceName, StringComparer.Ordinal).ToArray();
            string topology = string.Join("|", monitors.Select(screen => screen.DeviceName + screen.Bounds.ToString()));
            string identityAndTopology = session + "/" + stats.AuthenticationId + "/" + sid + "/" + bounds + "/" + topology;
            using (var sha = SHA256.Create())
            {
                return new Snapshot {
                    Stamp = Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(identityAndTopology))),
                    Bounds = bounds, Monitors = monitors.Select(screen => screen.Bounds).ToArray()
                };
            }
        }
    }

    private static bool StillCurrent(Helper.Request request, Snapshot previous)
    {
        Snapshot current = GetSnapshot(request.desktopSid);
        return current != null && current.Stamp == previous.Stamp;
    }

    private static bool IsActive(int session)
    {
        IntPtr data;
        int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out data, out bytes)) return false;
        try { return bytes >= sizeof(int) && Marshal.ReadInt32(data) == 0; }
        finally { WTSFreeMemory(data); }
    }

    private static bool IsDefaultDesktop()
    {
        if (!NamedObject(GetProcessWindowStation(), "WinSta0") || !NamedObject(GetThreadDesktop(GetCurrentThreadId()), "Default"))
            return false;
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try { return NamedObject(desktop, "Default"); }
        finally { CloseDesktop(desktop); }
    }

    private static bool NamedObject(IntPtr handle, string name)
    {
        if (handle == IntPtr.Zero) return false;
        var text = new StringBuilder(256);
        uint needed;
        return GetUserObjectInformation(handle, 2, text, 512, out needed) &&
            string.Equals(text.ToString(), name, StringComparison.OrdinalIgnoreCase);
    }

    private static object Capture(string directory, Helper.Request request, Snapshot snapshot)
    {
        long capturedAt = Helper.Now;
        Rectangle rect = snapshot.Bounds;
        using (var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(rect.X, rect.Y, 0, 0, rect.Size, CopyPixelOperation.SourceCopy);
            if (!StillCurrent(request, snapshot)) return Helper.Failed("desktop_unavailable");
            if (Helper.Cancelled(directory, request)) return new { state = "cancelled" };
            using (var stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Jpeg);
                if (stream.Length > 6 * 1024 * 1024) return Helper.Failed("desktop_image_too_large");
                return new { stamp = snapshot.Stamp, capturedAt = capturedAt,
                    width = rect.Width, height = rect.Height, data = Convert.ToBase64String(stream.ToArray()) };
            }
        }
    }

    private static Input[] BuildInput(Snapshot desktop, Helper.DesktopAction action)
    {
        if (action == null) return null;
        switch (action.kind)
        {
            case "click":
            case "scroll":
                Rectangle rect = desktop.Bounds;
                if (action.x < 0 || action.x >= rect.Width || action.y < 0 || action.y >= rect.Height ||
                    !desktop.Monitors.Any(monitor => monitor.Contains(rect.X + action.x, rect.Y + action.y))) return null;
                var move = Mouse(0xC001, 0);
                move.Value.Mouse.X = (2 * action.x + 1) * 32768 / rect.Width;
                move.Value.Mouse.Y = (2 * action.y + 1) * 32768 / rect.Height;
                if (action.kind == "scroll")
                {
                    if (action.delta == 0 || action.delta < -1200 || action.delta > 1200) return null;
                    return new[] { move, Mouse(0x0800, unchecked((uint)action.delta)) };
                }
                if (action.button != null && action.button != "left" && action.button != "right") return null;
                bool right = action.button == "right";
                return new[] { move, Mouse(right ? RightDown : LeftDown, 0), Mouse(right ? RightUp : LeftUp, 0) };

            case "keys":
                if (action.keys == null || action.keys.Length < 1 || action.keys.Length > 6) return null;
                var keys = new List<ushort>();
                foreach (string name in action.keys)
                {
                    ushort code = ParseKey(name);
                    if (code == 0 || keys.Contains(code) || IsPressed(code)) return null;
                    keys.Add(code);
                }
                return keys.Select(code => Key(code, 0, KeyFlags(code)))
                    .Concat(keys.AsEnumerable().Reverse().Select(code => Key(code, 0, KeyFlags(code) | KeyUp))).ToArray();

            case "text":
                if (string.IsNullOrEmpty(action.text) || action.text.Length > 2048 ||
                    IsPressed(0x10) || IsPressed(0x11) || IsPressed(0x12) || IsPressed(0x5B) || IsPressed(0x5C)) return null;
                return action.text.SelectMany(character => new[] {
                    Key(0, character, Unicode), Key(0, character, Unicode | KeyUp)
                }).ToArray();

            default: return null;
        }
    }

    private static ushort ParseKey(string name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > 12) return 0;
        ushort code;
        if (KeyCodes.TryGetValue(name, out code)) return code;
        string upper = name.ToUpperInvariant();
        if (upper.Length == 1 && ((upper[0] >= 'A' && upper[0] <= 'Z') || (upper[0] >= '0' && upper[0] <= '9')))
            return upper[0];
        int number;
        if (upper[0] == 'F' && Int32.TryParse(upper.Substring(1), out number) && number >= 1 && number <= 24)
            return (ushort)(0x6F + number);
        return 0;
    }

    private static uint KeyFlags(ushort code)
    {
        return (code >= 0x21 && code <= 0x2E) || code == 0x5B ? Extended : 0;
    }

    private static bool IsPressed(ushort code) { return GetAsyncKeyState(code) < 0; }

    private static object Send(Input[] events)
    {
        int size = Marshal.SizeOf(typeof(Input));
        uint sent = SendInput((uint)events.Length, events, size);
        if (sent == events.Length) return Helper.Succeeded(0, "", "", false);
        if (sent == 0) return Helper.Failed("desktop_input_unavailable");

        // 部分输入成功时，清理已按下且尚未释放的按键和鼠标按钮。
        var releases = new Stack<Input>();
        for (int index = 0; index < sent; index++)
        {
            Input entry = events[index];
            if (entry.Type == 1)
            {
                var key = entry.Value.Keyboard;
                if ((key.Flags & KeyUp) != 0) releases.Pop();
                else releases.Push(Key(key.Code, key.Scan, key.Flags | KeyUp));
            }
            else if (entry.Value.Mouse.Flags == LeftDown) releases.Push(Mouse(LeftUp, 0));
            else if (entry.Value.Mouse.Flags == RightDown) releases.Push(Mouse(RightUp, 0));
            else if (entry.Value.Mouse.Flags == LeftUp || entry.Value.Mouse.Flags == RightUp) releases.Pop();
        }
        if (releases.Count > 0) SendInput((uint)releases.Count, releases.ToArray(), size);
        return new { state = "unknown", error = "desktop_input_partial" };
    }

    private static Input Key(ushort code, ushort scan, uint flags)
    {
        return new Input { Type = 1, Value = new InputValue { Keyboard = new KeyboardInput { Code = code, Scan = scan, Flags = flags } } };
    }

    private static Input Mouse(uint flags, uint data)
    {
        return new Input { Value = new InputValue { Mouse = new MouseInput { Flags = flags, Data = data } } };
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenStatistics
    {
        public long TokenId, AuthenticationId, Expiration;
        public uint Type, Impersonation, Charged, Available, Groups, Privileges;
        public long ModifiedId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputValue Value;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputValue
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Code, Scan;
        public uint Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr data, out int bytes);
    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr data);
    [DllImport("advapi32.dll")]
    private static extern bool GetTokenInformation(IntPtr token, int infoClass, out TokenStatistics info, int size, out int returned);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint size, out uint needed);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] events, int size);
}
