
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class Job
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint KillOnJobClose = 0x00002000;
    private const uint UseStdHandles = 0x00000100;
    private const int OutputLimit = 32 * 1024;

    internal static object Run(string directory, Helper.Request request)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr input = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        bool assigned = false, resumed = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = KillOnJobClose;
            Require(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));

            var inherit = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
            input = CreateFile("NUL", 0x80000000, 3, ref inherit, 3, 0, IntPtr.Zero);
            Require(input != new IntPtr(-1));
            Require(CreatePipe(out stdoutRead, out stdoutWrite, ref inherit, 0));
            Require(CreatePipe(out stderrRead, out stderrWrite, ref inherit, 0));
            Require(SetHandleInformation(stdoutRead, 1, 0));
            Require(SetHandleInformation(stderrRead, 1, 0));

            var startup = new StartupInfo {
                Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = UseStdHandles,
                StandardInput = input, StandardOutput = stdoutWrite, StandardError = stderrWrite
            };
            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string launcher = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launch.ps1");
            string script = Path.Combine(directory, "script.ps1");
            var args = new StringBuilder(Quote(powershell) + " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(launcher) + " " + Quote(script));

            Require(CreateProcess(powershell, args, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateNoWindow,
                IntPtr.Zero, request.cwd, ref startup, out process));
            Require(AssignProcessToJobObject(job, process.Process));
            assigned = true;
            Close(ref stdoutWrite);
            Close(ref stderrWrite);

            var stdout = Drain(ref stdoutRead);
            var stderr = Drain(ref stderrRead);
            bool cancelled = Helper.Cancelled(directory, request);
            if (!cancelled)
            {
                Require(ResumeThread(process.Thread) != UInt32.MaxValue);
                resumed = true;
            }

            while (!cancelled && ActiveProcesses(job) != 0)
            {
                cancelled = Helper.Cancelled(directory, request);
                if (!cancelled) Thread.Sleep(75);
            }
            if (cancelled)
            {
                Require(TerminateJobObject(job, 1));
                var stopDeadline = Stopwatch.StartNew();
                while (ActiveProcesses(job) != 0 && stopDeadline.ElapsedMilliseconds < 5000) Thread.Sleep(25);
                if (ActiveProcesses(job) != 0) return new { state = "unknown", error = "guest_stop_unconfirmed" };
                return new { state = "cancelled" };
            }

            uint exitCode;
            Require(GetExitCodeProcess(process.Process, out exitCode));
            Task.WaitAll(new Task[] { stdout, stderr }, 2000);
            Output outValue = ReadOutput(stdout);
            Output errValue = ReadOutput(stderr);
            return Helper.Succeeded(unchecked((int)exitCode), outValue.Text, errValue.Text, outValue.Truncated || errValue.Truncated);
        }
        catch (Exception)
        {
            if (resumed) return new { state = "unknown", error = "guest_shell_result_unknown" };
            return Helper.Failed("guest_shell_launch_failed");
        }
        finally
        {
            // 如果加入 Job Object 失败，仍需清理未恢复的进程。
            if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            Close(ref job);
            Close(ref process.Thread);
            Close(ref process.Process);
            Close(ref input);
            Close(ref stdoutRead);
            Close(ref stdoutWrite);
            Close(ref stderrRead);
            Close(ref stderrWrite);
        }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        Accounting accounting;
        Require(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return accounting.ActiveProcesses;
    }

    private sealed class Output
    {
        internal string Text;
        internal bool Truncated;
    }

    private static Output ReadOutput(Task<Output> task)
    {
        return task.Status == TaskStatus.RanToCompletion ? task.Result : new Output { Text = "", Truncated = true };
    }

    private static Task<Output> Drain(ref IntPtr pipe)
    {
        var handle = new SafeFileHandle(pipe, true);
        pipe = IntPtr.Zero;
        return Task.Factory.StartNew(() => {
            using (handle)
            using (var input = new FileStream(handle, FileAccess.Read))
            using (var output = new MemoryStream())
            {
                bool truncated = false;
                var buffer = new byte[4096];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                {
                    int keep = Math.Min(count, OutputLimit - (int)output.Length);
                    output.Write(buffer, 0, keep);
                    truncated = truncated || keep < count;
                }
                return new Output { Text = Encoding.UTF8.GetString(output.ToArray()), Truncated = truncated };
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private static string Quote(string value) { return "\"" + value + "\""; }

    private static void Require(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTime, PerJobUserTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Counters;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
