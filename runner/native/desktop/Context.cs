using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Windows.Forms;

internal static class DesktopContext
{
    private static int Main(string[] args)
    {
        if (args.Length != 1) return 1;
        try { Console.Out.Write(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(Context(args[0]))); return 0; }
        catch (Exception) { return 1; }
    }

    internal static object Context(string sid)
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Snapshot current = GetSnapshot(sid);
        if (current == null) return null;
        using (var process = Process.GetCurrentProcess())
            return new { stamp = current.Stamp, sessionId = process.SessionId };
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

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenStatistics
    {
        public long TokenId, AuthenticationId, Expiration;
        public uint Type, Impersonation, Charged, Available, Groups, Privileges;
        public long ModifiedId;
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
}
