
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class Helper
{
    internal sealed class Request
    {
        public string kind { get; set; }
        public string cwd { get; set; }
        public string desktopSid { get; set; }
        public long deadline { get; set; }
        public Frame frame { get; set; }
        public DesktopAction action { get; set; }
    }

    internal sealed class Frame
    {
        public string stamp { get; set; }
        public long capturedAt { get; set; }
    }

    internal sealed class DesktopAction
    {
        public string kind { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public string button { get; set; }
        public int delta { get; set; }
        public string[] keys { get; set; }
        public string text { get; set; }
    }

    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 10 * 1024 * 1024 };
    internal static long Now { get { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); } }

    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "context")
        {
            try { Console.Out.Write(Json.Serialize(Desktop.Context(args[1]))); return 0; }
            catch (Exception) { return 1; }
        }
        if (args.Length != 2 || (args[0] != "shell" && args[0] != "desktop")) return 1;
        bool screen = args[0] == "desktop" && args[1].StartsWith("s-", StringComparison.Ordinal);
        string id = screen ? args[1].Substring(2) : args[1];
        if (!Regex.IsMatch(id, @"\A[a-fA-F0-9-]{32,64}\z")) return 1;
        string directory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, screen ? "screens" : "jobs", id);
        string path = Path.Combine(directory, "request.json");
        if (!File.Exists(path)) return 1;

        try
        {
            using (var claim = new FileStream(Path.Combine(directory, "claim"), FileMode.CreateNew, FileAccess.Write))
                claim.Flush(true);
        }
        catch (IOException) { return 1; }

        using (var process = Process.GetCurrentProcess())
            WriteReceipt(directory, "live.json", new { pid = process.Id, startedTicks = process.StartTime.ToUniversalTime().Ticks.ToString() });

        object receipt;
        try
        {
            var request = Json.Deserialize<Request>(File.ReadAllText(path, Utf8));
            if (Cancelled(directory, request)) receipt = new { state = "cancelled" };
            else if (args[0] == "shell" && request.kind == "powershell") receipt = Job.Run(directory, request);
            else if (args[0] == "desktop" && request.kind == (screen ? "screen" : "desktop"))
                receipt = Desktop.Run(directory, request);
            else receipt = Failed("invalid_guest_request");
        }
        catch (Exception)
        {
            receipt = Failed("guest_helper_error");
        }

        WriteReceipt(directory, "terminal.json", receipt);
        if (!screen)
        {
            File.Delete(path);
            if (args[0] == "shell") File.Delete(Path.Combine(directory, "script.ps1"));
        }
        return 0;
    }

    internal static object Failed(string error) { return new { state = "failed", error = error }; }

    internal static object Succeeded(int exitCode, string stdout, string stderr, bool truncated)
    {
        return new { state = "succeeded", result = new { exitCode = exitCode, stdout = stdout, stderr = stderr, truncated = truncated } };
    }

    internal static bool Cancelled(string directory, Request request)
    {
        return Now >= request.deadline || File.Exists(Path.Combine(directory, "cancel"));
    }

    private static void WriteReceipt(string directory, string name, object value)
    {
        string path = Path.Combine(directory, name);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = Utf8.GetBytes(Json.Serialize(value));
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
