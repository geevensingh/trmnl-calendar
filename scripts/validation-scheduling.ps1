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

function Get-ValidationComponents([string]$Scope, [string]$Component = '') {
    $items = @(
        @{ id = 'prerequisites'; name = 'Prerequisites'; requires = @() }
        @{ id = 'format'; name = 'C# formatting (read-only)'; requires = @('prerequisites') }
        @{ id = 'build'; name = '.NET build (warnings as errors)'; requires = @('prerequisites') }
        @{ id = 'syntax'; name = 'PowerShell and Node syntax'; requires = @('prerequisites') }
        if ($Scope -eq 'Full') {
            @{ id = 'browser'; name = 'Pinned Chromium readiness'; requires = @('prerequisites', 'build') }
            @{ id = 'node'; name = 'Node delivery and guardrail tests'; requires = @('prerequisites', 'build', 'syntax', 'browser') }
            @{ id = 'dotnet'; name = '.NET tests (production rendering)'; requires = @('prerequisites', 'format', 'build', 'syntax', 'browser', 'node') }
            @{ id = 'evidence'; name = 'Complete timing evidence'; requires = @() }
        }
    )
    foreach ($item in $items) {
        if ($Component -and $item.id -eq $(if ($Component -eq 'node') { 'dotnet' } else { 'node' })) { continue }
        $requires = @($item.requires | Where-Object { !$Component -or $item.id -ne 'dotnet' -or $_ -ne 'node' })
        [ordered]@{ id = $item.id; name = $item.name; requires = $requires
            outcome = 'incomplete'; evidence_outcome = $null; blocked_by = @() }
    }
}

function Get-ValidationNodeFiles([string]$Root) {
    foreach ($directory in @('tests\delivery', 'tests\validation')) {
        $tests = @(Get-ChildItem -LiteralPath (Join-Path $Root $directory) -Filter '*.test.mjs' -File | Sort-Object Name)
        if (!$tests.Count) { throw "No Node tests found in $directory; refusing an empty test run." }
        $tests.FullName
    }
}

function New-ValidationExecutionPlan([string]$Root, [string]$Profile) {
    $path = Join-Path $script:validationDirectory 'discovery.json'
    $saved = @{}
    foreach ($name in @('TRMNL_DISCOVERY_PATH', 'TRMNL_TIMING_DIRECTORY', 'TRMNL_DISPLAY_COVERAGE')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        $env:TRMNL_DISCOVERY_PATH = $path
        $env:TRMNL_DISPLAY_COVERAGE = $Profile
        Remove-Item Env:TRMNL_TIMING_DIRECTORY -ErrorAction SilentlyContinue
        Invoke-Tool dotnet @('test', (Join-Path $Root 'tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj'),
            '--no-build', '--no-restore', '--nologo', '--verbosity', 'quiet',
            '--settings', (Join-Path $Root 'tests\validation-partitions.runsettings'),
            '--filter', 'FullyQualifiedName=CalendarAgenda.Tests.ValidationPartitionTests.Test_case_discovery_materializes_complete_unfiltered_inventory') `
            'Complete independent xUnit discovery is required before partition execution.' | Out-Host
    }
    finally { Restore-ValidationWorkerVariables $saved }
    $contract = @(Get-ValidationComponents 'Full' | ForEach-Object {
        [ordered]@{ id = $_.id; name = $_.name; requires = $_.requires }
    })
    $provenance = $script:validationReport.provenance
    $request = [ordered]@{
        inventory = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        coverage = Get-DisplayCoverageInventory $Root $Profile
        serial = $contract
        context = [ordered]@{
            run_id = $provenance.run_id; run_attempt = $provenance.run_attempt
            head_commit = $provenance.head_commit; base_commit = $provenance.base_commit
            evaluated_commit = $provenance.evaluated_commit; evaluated_tree = $provenance.evaluated_tree
            content_sha256 = $script:validationReport.content.started.sha256
        }
        node_files = @(Get-ValidationNodeFiles $Root | ForEach-Object { [IO.Path]::GetRelativePath($Root, $_) })
    }
    $requestPath = Join-Path $script:validationDirectory 'execution-request.json'
    $request | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $requestPath -Encoding utf8
    $json = Invoke-Tool node @((Join-Path $Root 'scripts\validation-execution.mjs'), '--operation', 'plan', '--request', $requestPath) `
        'The complete independent inventory must map to the approved partition contract.'
    $plan = ($json -join "`n") | ConvertFrom-Json
    if (!$plan.sha256) { throw 'Execution planning did not produce a bound plan.' }
    [IO.File]::WriteAllText((Join-Path $script:validationDirectory 'execution-plan.json'), ($json -join "`n"))
    return $plan
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

function Remove-ValidationUnsupportedToolEnvironment($Variables) {
    $nativeInputs = @('ALLUSERSPROFILE', 'APPDATA', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
        'CommonProgramW6432', 'COMPUTERNAME', 'ComSpec', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
        'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
        'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PSModulePath', 'PUBLIC',
        'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir',
        'CI', 'ImageVersion', 'ImageOS', 'PR_HEAD_COMMIT', 'PR_BASE_COMMIT', 'PLAYWRIGHT_BROWSERS_PATH',
        'MSBUILDDISABLENODEREUSE', 'UseSharedCompilation', 'AZURE_CONFIG_DIR',
        'AZURE_BICEP_USE_BINARY_FROM_PATH', 'AZURE_BICEP_CHECK_VERSION', 'AZURE_EXTENSION_USE_DYNAMIC_INSTALL',
        'CC', 'CXX', 'MAKE', 'INCLUDE', 'LIB', 'LIBPATH', 'MSYSTEM', 'MSYS2_PATH_TYPE',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
        'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'TERM', 'COLORTERM', 'NO_COLOR', 'TZ',
        'DOTNET_ROOT', 'DOTNET_ROOT_X64', 'DOTNET_ROOT_X86', 'DOTNET_ROOT_ARM64', 'DOTNET_HOST_PATH',
        'DOTNET_CLI_HOME', 'DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER', 'DOTNET_CLI_TELEMETRY_OPTOUT',
        'DOTNET_NOLOGO', 'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'POWERSHELL_TELEMETRY_OPTOUT',
        'NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH', 'NUGET_SCRATCH',
        'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF',
        'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL', 'GITHUB_WORKSPACE',
        'TRMNL_RUBY', 'TRMNL_DISPLAY_COVERAGE', 'TRMNL_TIMING_DIRECTORY', 'TRMNL_DISCOVERY_PATH',
        'TRMNL_GEMS_CACHE_STATE', 'TRMNL_FRAMEWORK_CACHE_STATE',
        'BUNDLE_IGNORE_CONFIG', 'BUNDLE_APP_CONFIG', 'BUNDLE_GEMFILE', 'BUNDLE_PATH', 'BUNDLE_BIN',
        'BUNDLE_CACHE_PATH', 'BUNDLE_FROZEN', 'BUNDLE_DISABLE_SHARED_GEMS', 'BUNDLE_USER_HOME', 'BUNDLE_USER_CACHE',
        'GEM_HOME', 'GEM_PATH', 'RI_DEVKIT')
    foreach ($name in @($Variables.Keys)) {
        if ($name -notin $nativeInputs) {
            $null = $Variables.Remove($name)
            $name
        }
    }
}

function Assert-ValidationPhysicalDestination([string]$Path, [switch]$Recurse) {
    $destination = [IO.Path]::GetFullPath($Path)
    $current = $destination
    while ($true) {
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [Management.Automation.ItemNotFoundException] {
            $current = [IO.Path]::GetDirectoryName($current)
            if (!$current) { throw 'Worker output has no physical directory ancestor.' }
            continue
        }
        Assert-ValidationPhysicalDirectory $item.FullName
        if ($Recurse -and $current -ceq $destination) {
            $pending = [Collections.Generic.Stack[string]]::new()
            $pending.Push($item.FullName)
            while ($pending.Count) {
                foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint -or $entry.LinkType) {
                        throw 'Worker isolation does not permit linked directory descendants or output files.'
                    }
                    if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
                }
            }
        }
        return
    }
}

function Assert-ValidationWorkerWorkspace([string]$Root) {
    foreach ($name in @('BaseOutputPath', 'OutputPath', 'OutDir', 'BaseIntermediateOutputPath',
        'IntermediateOutputPath', 'MSBuildProjectExtensionsPath', 'ArtifactsPath', 'UseArtifactsOutput',
        'CompilerGeneratedFilesOutputPath', 'GeneratedAssemblyInfoFile', 'GeneratedGlobalUsingsFile', 'TargetPath',
        'DocumentationFile', 'PublishDir', 'PackageOutputPath',
        'CreateHardLinksForCopyFilesToOutputDirectoryIfPossible',
        'CreateSymbolicLinksForCopyFilesToOutputDirectoryIfPossible')) {
        if (![string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
            throw "Worker isolation does not support inherited MSBuild output overrides: $name."
        }
    }
    $rootPath = [IO.Path]::GetFullPath($Root)
    Assert-ValidationPhysicalDirectory $rootPath
    Assert-ValidationPhysicalDestination (Join-Path $rootPath 'artifacts\validation')
    foreach ($destination in @(
        foreach ($project in @('src\CalendarAgenda', 'tests\CalendarAgenda.Tests')) {
            foreach ($kind in @('bin', 'obj')) { Join-Path $rootPath "$project\$kind" }
        }
        (Join-Path $rootPath '.bundle'), (Join-Path $rootPath 'vendor\bundle'),
        (Join-Path $rootPath '.tools\framework')
    )) {
        Assert-ValidationPhysicalDestination $destination -Recurse
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
    Assert-ValidationWorkerWorkspace $rootPath
    Assert-ValidationPhysicalDirectory $reportPath
    $buildRoots = @(
        foreach ($project in @('src\CalendarAgenda', 'tests\CalendarAgenda.Tests')) {
            foreach ($kind in @('bin', 'obj')) { Join-Path $rootPath "$project\$kind" }
        }
    )
    $owner = [Guid]::NewGuid().ToString('N')
    $environmentProbe = [Environment]::GetEnvironmentVariables('Process')
    $omitted = @(Remove-ValidationUnsupportedToolEnvironment $environmentProbe | Sort-Object)
    if ($omitted.Count) {
        Write-Host "Owned tools omit $($omitted.Count) unsupported inherited environment variables; names are recorded in isolation evidence."
    }
    $processRoot = Join-Path $reportPath "process-$owner"
    if (Test-Path -LiteralPath $processRoot) { throw 'Worker process-directory ownership collision.' }
    $saved = @{}
    foreach ($name in @('TEMP', 'TMP', 'TMPDIR', 'TRMNL_TIMING_DIRECTORY', 'TRMNL_DISCOVERY_PATH',
        'DOTNET_CLI_HOME', 'DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER', 'MSBUILDDISABLENODEREUSE', 'UseSharedCompilation',
        'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO',
        'BUNDLE_USER_HOME', 'BUNDLE_USER_CACHE', 'PATH', 'AZURE_CONFIG_DIR',
        'NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH', 'NUGET_SCRATCH',
        'AZURE_BICEP_USE_BINARY_FROM_PATH', 'AZURE_EXTENSION_USE_DYNAMIC_INSTALL')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    New-Item -ItemType Directory -Path $processRoot -ErrorAction Stop | Out-Null
    try {
        [IO.File]::WriteAllText((Join-Path $processRoot '.validation-owner'), $owner)
        foreach ($name in @('TEMP', 'TMP', 'TMPDIR')) {
            [Environment]::SetEnvironmentVariable($name, $processRoot, 'Process')
        }
        $env:TRMNL_TIMING_DIRECTORY = $reportPath
        Remove-Item Env:TRMNL_DISCOVERY_PATH -ErrorAction SilentlyContinue
        $env:DOTNET_CLI_HOME = Join-Path $processRoot 'dotnet-home'
        New-Item -ItemType Directory -Path $env:DOTNET_CLI_HOME | Out-Null
        $env:DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER = '1'
        $env:MSBUILDDISABLENODEREUSE = '1'
        $env:UseSharedCompilation = 'false'
        $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
        $env:DOTNET_NOLOGO = '1'
        $env:NUGET_HTTP_CACHE_PATH = Join-Path $processRoot 'nuget-http'
        $env:NUGET_PLUGINS_CACHE_PATH = Join-Path $processRoot 'nuget-plugins'
        $env:NUGET_SCRATCH = Join-Path $processRoot 'nuget-scratch'
        $bicep = Get-Command bicep -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $azure = if ($env:AZURE_CONFIG_DIR) { $env:AZURE_CONFIG_DIR } else {
            Join-Path ([Environment]::GetFolderPath('UserProfile')) '.azure'
        }
        $selectedBicep = if ($bicep) { $bicep.Source } else { Join-Path $azure 'bin\bicep.exe' }
        if (Test-Path -LiteralPath $selectedBicep -PathType Leaf) {
            $env:PATH = "$(Split-Path $selectedBicep -Parent)$([IO.Path]::PathSeparator)$env:PATH"
        }
        $env:AZURE_CONFIG_DIR = Join-Path $processRoot 'azure'
        $env:AZURE_BICEP_USE_BINARY_FROM_PATH = 'true'
        $env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL = 'no'
        $env:BUNDLE_USER_HOME = Join-Path $processRoot 'bundler'
        $env:BUNDLE_USER_CACHE = Join-Path $env:BUNDLE_USER_HOME 'cache'
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
            tool_environment_policy = 'native-inputs-v1'; omitted_inherited_variables = $omitted
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
    $executable = Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $extension = [IO.Path]::GetExtension($executable.Source)
    if ($extension -in @('.cmd', '.bat')) {
        if (@($Arguments | Where-Object { $_ -match '["&|<>%^\r\n]' }).Count) {
            throw 'Windows command shims permit only literal readiness arguments.'
        }
    } elseif ($extension -ine '.exe') {
        throw 'Owned validation commands require a resolved Windows application, not a shell command string.'
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
    $null = Remove-ValidationUnsupportedToolEnvironment $start.Environment
    $start.Environment['POWERSHELL_TELEMETRY_OPTOUT'] = '1'
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
                else { Write-Output $line; $stdout = $process.StandardOutput.ReadLineAsync() }
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
