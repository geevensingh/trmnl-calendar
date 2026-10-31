function Assert-ValidationPhysicalDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (!$item.PSIsContainer) { throw 'Worker isolation requires a physical directory.' }
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Worker isolation does not permit linked directory ancestors.'
        }
        $item = $item.Parent
    }
}

function Restore-ValidationWorkerVariables([hashtable]$Saved) {
    foreach ($name in $Saved.Keys) {
        if ($null -eq $Saved[$name]) {
            if (Test-Path -LiteralPath "Env:$name") { Remove-Item -LiteralPath "Env:$name" -ErrorAction Stop }
        } else {
            [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process')
        }
    }
}

function Assert-ValidationPhysicalDestination([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [Management.Automation.ItemNotFoundException] {
            $current = [IO.Path]::GetDirectoryName($current)
            if (!$current) { throw 'Worker output has no physical directory ancestor.' }
            continue
        }
        Assert-ValidationPhysicalDirectory $item.FullName
        return
    }
}

function Enter-ValidationWorkerEnvironment([string]$Root, [string]$ReportDirectory) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $reportPath = [IO.Path]::GetFullPath($ReportDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $prefix = Join-Path $rootPath 'artifacts\validation'
    if (!$reportPath.StartsWith("$prefix\", [StringComparison]::OrdinalIgnoreCase) -or
        $rootPath.Length -le 3) {
        throw 'Worker artifacts must be in an owned report directory beneath this checkout.'
    }
    Assert-ValidationPhysicalDirectory $rootPath
    Assert-ValidationPhysicalDirectory $reportPath
    $buildRoots = @(
        foreach ($project in @('src\CalendarAgenda', 'tests\CalendarAgenda.Tests')) {
            foreach ($kind in @('bin', 'obj')) { Join-Path $rootPath "$project\$kind" }
        }
    )
    foreach ($destination in @($buildRoots) + @(
        (Join-Path $rootPath '.bundle'), (Join-Path $rootPath 'vendor\bundle'),
        (Join-Path $rootPath '.tools\framework')
    )) {
        Assert-ValidationPhysicalDestination $destination
    }
    $owner = [Guid]::NewGuid().ToString('N')
    $processRoot = Join-Path $reportPath "process-$owner"
    if (Test-Path -LiteralPath $processRoot) { throw 'Worker process-directory ownership collision.' }
    $saved = @{}
    foreach ($name in @('TEMP', 'TMP', 'TMPDIR', 'TRMNL_TIMING_DIRECTORY')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    New-Item -ItemType Directory -Path $processRoot -ErrorAction Stop | Out-Null
    try {
        [IO.File]::WriteAllText((Join-Path $processRoot '.validation-owner'), $owner)
        foreach ($name in @('TEMP', 'TMP', 'TMPDIR')) {
            [Environment]::SetEnvironmentVariable($name, $processRoot, 'Process')
        }
        $env:TRMNL_TIMING_DIRECTORY = $reportPath
    }
    catch {
        Restore-ValidationWorkerVariables $saved
        Remove-Item -LiteralPath $processRoot -Recurse -Force
        throw
    }
    return [pscustomobject]@{
        owner = $owner; saved_environment = $saved; restored = $false
        isolation = [ordered]@{
            host_id = [Environment]::MachineName
            workspace_root = $rootPath; artifact_root = $reportPath; process_root = $processRoot
            build_roots = $buildRoots
        }
    }
}

function Exit-ValidationWorkerEnvironment($State) {
    if ($State.restored) { throw 'Worker environment was already restored.' }
    Restore-ValidationWorkerVariables $State.saved_environment
    $State.restored = $true
    $processRoot = $State.isolation.process_root
    Assert-ValidationPhysicalDirectory $processRoot
    $marker = Join-Path $processRoot '.validation-owner'
    if (!(Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Item -LiteralPath $marker -Force).LinkType -or
        [IO.File]::ReadAllText($marker) -cne $State.owner) {
        throw 'Worker scratch ownership changed; refusing cleanup of uncertain content.'
    }
    Remove-Item -LiteralPath $processRoot -Recurse -Force -ErrorAction Stop
}

function Invoke-ValidationOwnedTool(
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [ValidateRange(0.1, 3600)][double]$TimeoutSeconds = 3600
) {
    if (![OperatingSystem]::IsWindows()) { throw 'Owned validation commands require Windows Job Objects.' }
    if (!('ValidationOwnedJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class ValidationOwnedJob : SafeHandleZeroOrMinusOneIsInvalid
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Limits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(ValidationOwnedJob job, int informationClass, ref Limits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(ValidationOwnedJob job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(ValidationOwnedJob job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(ValidationOwnedJob job, int informationClass, out Accounting accounting, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public ValidationOwnedJob() : base(true)
    {
        SetHandle(CreateJobObjectW(IntPtr.Zero, IntPtr.Zero));
        if (IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new Limits { Flags = 0x2000 }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(this, 9, ref limits, (uint)Marshal.SizeOf<Limits>()))
        {
            var error = Marshal.GetLastWin32Error();
            Dispose();
            throw new Win32Exception(error);
        }
    }

    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(this, process.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Stop()
    {
        if (IsClosed) return;
        if (!TerminateJobObject(this, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var clock = Stopwatch.StartNew();
        while (true)
        {
            if (!QueryInformationJobObject(this, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (accounting.ActiveProcesses == 0) break;
            if (clock.Elapsed.TotalSeconds >= 10) throw new TimeoutException("Owned validation processes did not terminate.");
            Thread.Sleep(10);
        }
        Dispose();
    }

    protected override bool ReleaseHandle() => CloseHandle(handle);
}
'@
    }
    $executable = Get-Command $Command -CommandType Application -ErrorAction Stop
    if ([IO.Path]::GetExtension($executable.Source) -ine '.exe') {
        throw 'Owned validation commands require a resolved executable, not a shell command string.'
    }
    $launcher = @'
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$PSNativeCommandArgumentPassing = 'Standard'
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if (!$request) { throw 'Owned tool request was not provided.' }
& $request.command @($request.arguments)
exit $LASTEXITCODE
'@
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher)))) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $started = $false
    $job = [ValidationOwnedJob]::new()
    try {
        $started = $process.Start()
        if (!$started) { throw 'Validation tool could not start.' }
        # The launcher cannot start the tool until it receives this request after job assignment.
        $job.Assign($process)
        $process.StandardInput.WriteLine((@{ command = $executable.Source; arguments = @($Arguments) } | ConvertTo-Json -Compress))
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadLineAsync()
        $stderr = $process.StandardError.ReadLineAsync()
        while ($stdout -or $stderr -or !$process.HasExited) {
            if ($process.HasExited -and !$job.IsClosed) { $job.Stop() }
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                throw [TimeoutException]::new('Owned validation tool exceeded its finite deadline.')
            }
            $progress = $false
            if ($stdout -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $stdout = $null }
                else { Write-Host $line; $stdout = $process.StandardOutput.ReadLineAsync() }
                $progress = $true
            }
            if ($stderr -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $stderr = $null }
                else { Write-Host $line; $stderr = $process.StandardError.ReadLineAsync() }
                $progress = $true
            }
            if (!$progress) {
                $pending = [Collections.Generic.List[Threading.Tasks.Task]]::new()
                if ($stdout) { $pending.Add($stdout) }
                if ($stderr) { $pending.Add($stderr) }
                if ($pending.Count) { $null = [Threading.Tasks.Task]::WaitAny($pending.ToArray(), 100) }
                else { $null = $process.WaitForExit(100) }
            }
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            $failure = [InvalidOperationException]::new("Owned validation tool exited with code $($process.ExitCode).")
            $failure.Data['tool_exit_code'] = $process.ExitCode
            throw $failure
        }
    }
    finally {
        try {
            try { $job.Stop() }
            finally {
                if ($started -and !$process.HasExited) {
                    $process.Kill($true)
                    $process.WaitForExit()
                }
            }
        }
        finally { $job.Dispose(); $process.Dispose() }
    }
}
