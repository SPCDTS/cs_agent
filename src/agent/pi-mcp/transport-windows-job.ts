/** Windows 专属 Job 的静态启动器；命令和参数仅按数据传入，不进行脚本拼接。 */
export const WINDOWS_JOB_SCRIPT = String.raw`param([string]$SpecBase64)
$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SpecBase64)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class McpJob {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS Basic; public IO_COUNTERS Io; public UIntPtr a,b,c,d;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved, desktop, title; public uint x,y,w,h,cx,cy,fill,flags;
    public ushort show,reserved2; public IntPtr reserved3,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr a,int b,ref EXTENDED_LIMITS c,uint d);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr a,IntPtr b);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder line,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESSINFO pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string arg) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
      result.Append('\\',slashes); slashes=0; result.Append(c);
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Run(string command,string[] args,string cwd,string[] envNames) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Exception("job_create");
    PROCESSINFO pi=new PROCESSINFO(); IntPtr environment=IntPtr.Zero;
    try {
      var limits=new EXTENDED_LIMITS(); limits.Basic.LimitFlags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception("job_limit");
      var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); si.flags=0x100;
      si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
      var line=new StringBuilder(Quote(command)); foreach(string arg in args) line.Append(" "+Quote(arg));
      // Only configured names reach the child; secret values stay in the process environment.
      Array.Sort(envNames,StringComparer.OrdinalIgnoreCase); var block=new StringBuilder();
      foreach(string name in envNames) { block.Append(name+"="+Environment.GetEnvironmentVariable(name)); block.Append('\0'); }
      block.Append('\0'); environment=Marshal.StringToHGlobalUni(block.ToString());
      if(!CreateProcess(command,line,IntPtr.Zero,IntPtr.Zero,true,0x08000404,environment,cwd,ref si,out pi)) throw new Exception("process_create");
      if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,1); throw new Exception("job_assign"); }
      if(ResumeThread(pi.thread)==0xffffffff) { TerminateProcess(pi.process,1); throw new Exception("process_resume"); }
      WaitForSingleObject(pi.process,0xffffffff); uint code; GetExitCodeProcess(pi.process,out code); return unchecked((int)code);
    } finally {
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
      CloseHandle(job);
    }
  }
}
'@
exit [McpJob]::Run([string]$spec.command, [string[]]$spec.args, [string]$spec.cwd, [string[]]$spec.envNames)
`;
