using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Feiyu.Desktop;

// A kernel job keeps future descendants of our controller launches attached even
// when a bootstrap exits quickly. Closing the UI's final handle is a crash backstop.
internal sealed class ProcessJob : IDisposable
{
    readonly IntPtr handle;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessTime, PerJobTime; public uint LimitFlags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public ProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = 0x2000 } }; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) { CloseHandle(handle); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }
    public void Attach(Process process)
    {
        if (process.HasExited) return;
        if (IsProcessInJob(process.Handle, handle, out bool attached) && attached) return;
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            int error = Marshal.GetLastWin32Error();
            if (!process.HasExited) throw new Win32Exception(error, "无法为项目进程建立 Job 保护（系统错误 " + error + "）。");
        }
    }
    public void Dispose() => CloseHandle(handle);
    public uint ActiveCount
    {
        get
        {
            if (!QueryInformationJobObject(handle, 1, out var info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return info.ActiveProcesses;
        }
    }
    public async Task StopRemaining()
    {
        // Called only after the controller's graceful/recorded stop has returned
        // and its own process exited. This job contains no unrelated programs.
        if (ActiveCount == 0) return;
        if (!TerminateJobObject(handle, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "项目任务中的辅助进程未能退出。");
        for (int i = 0; i < 30 && ActiveCount > 0; i++) await Task.Delay(100);
        if (ActiveCount != 0) throw new InvalidOperationException("仍有项目辅助进程未退出，窗口将保留。");
    }
}
