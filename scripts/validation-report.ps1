function Save-ValidationReport {
    $script:validationReport.duration_ms = [Math]::Round($script:validationClock.Elapsed.TotalMilliseconds, 3)
    $script:validationReport.stage_wall_ms = ($script:validationReport.stages |
        ForEach-Object { $_.duration_ms } | Measure-Object -Sum).Sum
    $script:validationReport.orchestration_ms = [Math]::Round(
        $script:validationReport.duration_ms - $script:validationReport.stage_wall_ms, 3)
    $temporary = Join-Path $script:validationDirectory 'summary.tmp'
    $script:validationReport | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination (Join-Path $script:validationDirectory 'summary.json') -Force
}

function Read-ValidationGit([string]$Root, [string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new('git')
    $start.WorkingDirectory = $Root
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.UseShellExecute = $false
    foreach ($name in @($start.Environment.Keys) | Where-Object { $_ -like 'GIT_*' }) {
        $null = $start.Environment.Remove($name)
    }
    $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $start.Environment['GIT_OPTIONAL_LOCKS'] = '0'
    foreach ($argument in @('--no-replace-objects', '-c', 'core.fsmonitor=false') + $Arguments) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(10000)) {
            $process.Kill($true)
            $process.WaitForExit()
            return $null
        }
        $null = $stderr.GetAwaiter().GetResult()
        $text = $stdout.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { return $null }
        return [pscustomobject]@{ text = $text.TrimEnd() }
    }
    catch {
        Write-Host '[timing] Git provenance is unavailable; see the report unavailable list.'
        return $null
    }
    finally { $process.Dispose() }
}

function New-ValidationReport([string]$Root, [string]$Scope) {
    $script:validationClock = [Diagnostics.Stopwatch]::StartNew()
    $script:validationDirectory = Join-Path $Root "artifacts\validation\$($Scope.ToLowerInvariant())-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $script:validationDirectory -Force | Out-Null
    $unavailable = [Collections.Generic.List[string]]::new()
    $commit = $tree = $clean = $null
    if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
        $identity = Read-ValidationGit $Root @('rev-parse', '--verify', 'HEAD^{commit}')
        if ($identity) { $commit = $identity.text }
        $identity = Read-ValidationGit $Root @('rev-parse', '--verify', 'HEAD^{tree}')
        if ($identity) { $tree = $identity.text }
        $status = Read-ValidationGit $Root @('status', '--porcelain', '--untracked-files=all')
        $visible = Read-ValidationGit $Root @('ls-files', '-v')
        if ($status -and $visible -and $visible.text -cnotmatch '(?m)^[a-zS] ') {
            $clean = !$status.text
        }
        $gitVersion = Read-ValidationGit $Root @('--version')
    }
    if (!$commit -or !$tree) { $unavailable.Add('git identity') }
    if ($clean -ne $true) { $unavailable.Add('clean evaluated content identity') }
    if (!$env:PR_BASE_COMMIT) { $unavailable.Add('event-pinned base commit') }
    if (!$env:ImageVersion) { $unavailable.Add('runner image version') }
    $unavailable.Add('Azure CLI version (not queried by shared validation)')
    $script:validationReport = [ordered]@{
        schema_version = 1
        scope = $Scope
        started_at = [DateTimeOffset]::UtcNow.ToString('O')
        finished_at = $null
        outcome = 'incomplete'
        duration_ms = 0
        stage_wall_ms = 0
        orchestration_ms = 0
        first_failure_ms = $null
        total_job_runner_minutes = $null
        provenance = [ordered]@{
            head_commit = if ($env:PR_HEAD_COMMIT) { $env:PR_HEAD_COMMIT } else { $commit }
            base_commit = $env:PR_BASE_COMMIT
            evaluated_commit = $commit
            evaluated_tree = $tree
            working_tree_clean = $clean
            runner_os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
            architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
            image_os = $env:ImageOS
            image_version = $env:ImageVersion
            run_id = $env:GITHUB_RUN_ID
            run_attempt = $env:GITHUB_RUN_ATTEMPT
            tools = [ordered]@{ powershell = $PSVersionTable.PSVersion.ToString() }
            cache = [ordered]@{
                dependency_cache_hit = 'unknown (no cache restore evidence supplied)'
                gems_restore = if ($env:TRMNL_GEMS_CACHE_STATE -in @('exact-hit', 'not-hit', 'not-restored')) {
                    $env:TRMNL_GEMS_CACHE_STATE
                } else { 'unknown' }
                framework_restore = if ($env:TRMNL_FRAMEWORK_CACHE_STATE -in @('exact-hit', 'not-hit', 'not-restored')) {
                    $env:TRMNL_FRAMEWORK_CACHE_STATE
                } else { 'unknown' }
                worktree_bundle_present = Test-Path -LiteralPath (Join-Path $Root 'vendor\bundle')
                framework_present = Test-Path -LiteralPath (Join-Path $Root '.tools\framework')
                browser_selection = if ($env:PLAYWRIGHT_BROWSERS_PATH) { 'explicit' } else { 'default shared cache' }
            }
            dependency_sha256 = [ordered]@{}
        }
        stages = [Collections.Generic.List[object]]::new()
        evidence = [ordered]@{ status = if ($Scope -eq 'Full') { 'incomplete' } else { 'not-requested' } }
        node_files = @()
        unavailable = $unavailable
        timing_semantics = 'Stage intervals are sequential wall time; per-test/class/phase sums are work, not elapsed time. Nested and concurrent intervals can overlap.'
    }
    if ($commit -and $gitVersion) { $script:validationReport.provenance.tools.git = $gitVersion.text }
    foreach ($path in @('global.json', 'Gemfile.lock', 'tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj')) {
        $file = Join-Path $Root $path
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $script:validationReport.provenance.dependency_sha256[$path] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $script:validationReport.unavailable.Add('whole-job elapsed/runner minutes and action provisioning durations (see GitHub step timings)')
    Save-ValidationReport
    Write-Host "Timing report: $script:validationDirectory"
}

function Start-ValidationStage([string]$Name) {
    $stage = [ordered]@{
        name = $Name; result = 'running'
        started_at = [DateTimeOffset]::UtcNow.ToString('O')
        offset_ms = [Math]::Round($script:validationClock.Elapsed.TotalMilliseconds, 3)
        duration_ms = 0
    }
    $script:validationReport.stages.Add($stage)
    Save-ValidationReport
    return $stage
}

function Stop-ValidationStage($Stage, [string]$Result) {
    $Stage.result = $Result
    $Stage.duration_ms = [Math]::Round($script:validationClock.Elapsed.TotalMilliseconds - $Stage.offset_ms, 3)
    if ($Result -eq 'failed' -and $null -eq $script:validationReport.first_failure_ms) {
        $script:validationReport.first_failure_ms = [Math]::Round($script:validationClock.Elapsed.TotalMilliseconds, 3)
    }
    Save-ValidationReport
}

function Read-ValidationEvidence {
    $missing = [Collections.Generic.List[string]]::new()
    $reportedFailures = 0
    $evidence = [ordered]@{ status = 'incomplete'; dotnet = $null; node = $null; phases = $null }
    try {
        $path = Join-Path $script:validationDirectory 'dotnet.trx'
        if ((Get-Item -LiteralPath $path).Length -gt 20MB) { throw 'TRX exceeds diagnostic limit.' }
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create($path, $settings)
        try {
            $trx = [Xml.XmlDocument]::new()
            $trx.Load($reader)
        }
        finally { $reader.Dispose() }
        $definitions = @{}
        foreach ($definition in $trx.SelectNodes("//*[local-name()='UnitTest']")) {
            $method = $definition.SelectSingleNode("*[local-name()='TestMethod']")
            $definitions[$definition.id] = "$($method.className).$($method.name)"
        }
        $tests = @(
            foreach ($result in $trx.SelectNodes("//*[local-name()='UnitTestResult']")) {
                if (!$definitions.ContainsKey($result.testId)) { throw 'Missing test definition.' }
                [pscustomobject]@{
                    name = $result.testName
                    method = $definitions[$result.testId]
                    result = $result.outcome
                    duration_ms = [TimeSpan]::Parse($result.duration, [Globalization.CultureInfo]::InvariantCulture).TotalMilliseconds
                }
            }
        )
        $counters = $trx.SelectSingleNode("//*[local-name()='Counters']")
        $summary = $trx.SelectSingleNode("//*[local-name()='ResultSummary']")
        if ($tests.Count -eq 0 -or !$counters -or [int]$counters.total -ne $tests.Count -or
            !$summary -or $summary.outcome -notin @('Completed', 'Passed', 'Failed') -or
            [int]$counters.executed -ne $tests.Count -or
            @($tests | Where-Object { $_.result -notin @('Passed', 'Failed') -or $_.duration_ms -lt 0 }).Count) {
            throw 'Incomplete .NET result inventory.'
        }
        $classes = @($tests | Group-Object { $_.method.Substring(0, $_.method.LastIndexOf('.')) } |
            ForEach-Object {
                [ordered]@{ name = $_.Name; tests = $_.Count
                    work_ms = ($_.Group | Measure-Object duration_ms -Sum).Sum }
            })
        $evidence.dotnet = [ordered]@{ tests = $tests; classes = $classes; count = $tests.Count }
        $reportedFailures += @($tests | Where-Object result -EQ 'Failed').Count
    }
    catch { $missing.Add('complete .NET TRX results') }
    try {
        $path = Join-Path $script:validationDirectory 'node.jsonl'
        if ((Get-Item -LiteralPath $path).Length -gt 20MB) { throw 'Node report exceeds diagnostic limit.' }
        $events = @(Get-Content -LiteralPath $path | ForEach-Object { $_ | ConvertFrom-Json })
        $summaries = @($events | Where-Object kind -EQ 'summary')
        if ($summaries.Count -ne 1 -or $summaries[0].cancelled -ne 0 -or
            $summaries[0].skipped -ne 0 -or $summaries[0].todo -ne 0 -or $summaries[0].tests -le 0) {
            throw 'Incomplete Node results.'
        }
        if ($script:validationReport.node_files.Count -eq 0 -or
            @(Compare-Object @($script:validationReport.node_files) @($summaries[0].files)).Count) {
            throw 'Incomplete Node file inventory.'
        }
        $tests = @($events | Where-Object kind -EQ 'test')
        if (@($tests | Where-Object { $_.type -ne 'suite' }).Count -ne $summaries[0].tests -or
            @($tests | Where-Object {
                $_.result -notin @('passed', 'failed') -or $null -eq $_.duration_ms -or
                $_.duration_ms -lt 0 -or $_.nesting -lt 0
            }).Count) {
            throw 'Missing Node test events.'
        }
        $evidence.node = [ordered]@{
            summary = $summaries[0]; tests = $tests
            top_level_work_ms = ($tests | Where-Object nesting -EQ 0 | Measure-Object duration_ms -Sum).Sum
            note = 'Top-level work excludes nested case durations; it is not wall time across concurrent files.'
        }
        $reportedFailures += [int]$summaries[0].failed
    }
    catch { $missing.Add('complete Node results') }
    try {
        $files = @(Get-ChildItem -LiteralPath $script:validationDirectory -Filter 'phases-*.jsonl' -File)
        if (($files | Measure-Object Length -Sum).Sum -gt 20MB) { throw 'Phase reports exceed aggregate diagnostic limit.' }
        $events = @(
            foreach ($file in $files) {
                if ($file.Length -gt 20MB) { throw 'Phase report exceeds diagnostic limit.' }
                Get-Content -LiteralPath $file.FullName | ForEach-Object { $_ | ConvertFrom-Json }
            }
        )
        $starts = @($events | Where-Object kind -EQ 'start')
        $phases = @($events | Where-Object kind -EQ 'end')
        $terminated = @{}
        foreach ($phase in $phases | Where-Object {
            $_.phase -eq 'ruby.workbench_process' -and
            ($_.result -eq 'cancelled' -or
                ($_.PSObject.Properties['terminated'] -and $_.terminated -eq $true))
        }) {
            $terminated[$phase.id] = $true
        }
        $startById = @{}
        $endById = @{}
        foreach ($event in $starts) {
            if ($startById.ContainsKey($event.id)) { throw 'Duplicate phase start.' }
            $startById[$event.id] = $event
        }
        foreach ($event in $phases) {
            if ($endById.ContainsKey($event.id) -or !$startById.ContainsKey($event.id) -or
                $startById[$event.id].phase -ne $event.phase) { throw 'Unmatched phase end.' }
            $endById[$event.id] = $event
        }
        $interrupted = 0
        foreach ($event in $starts) {
            if ($endById.ContainsKey($event.id)) { continue }
            $operation = $event.PSObject.Properties['operation_id']
            if (!$operation -or !$operation.Value -or !$terminated.ContainsKey($operation.Value)) {
                throw 'Unfinished rendering phase without an owned termination.'
            }
            $interrupted++
        }
        foreach ($name in @('browser.create', 'browser.launch', 'ruby.startup', 'ruby.render',
            'screenshot', 'png.decode', 'png.inspect')) {
            if (!@($phases | Where-Object { $_.phase -eq $name -and $_.result -eq 'passed' }).Count) {
                throw 'Missing rendering phase.'
            }
        }
        if (@($phases | Where-Object {
            $_.result -notin @('passed', 'failed', 'cancelled') -or
            $null -eq $_.duration_ms -or $_.duration_ms -lt 0
        }).Count) {
            throw 'Incomplete rendering phase.'
        }
        $evidence.phases = [ordered]@{
            count = $phases.Count
            interrupted_child_phases = $interrupted
            totals = @($phases | Group-Object phase | ForEach-Object {
                [ordered]@{ phase = $_.Name; count = $_.Count
                    failed = @($_.Group | Where-Object result -EQ 'failed').Count
                    cancelled = @($_.Group | Where-Object result -EQ 'cancelled').Count
                    work_ms = ($_.Group | Measure-Object duration_ms -Sum).Sum }
            })
        }
        $inventories = @(Get-ChildItem -LiteralPath $script:validationDirectory -Filter 'inventory-*.json' -File)
        if ($inventories.Count -ne 1 -or $inventories[0].Length -gt 1MB) { throw 'Missing rendering inventory.' }
        $inventory = Get-Content -LiteralPath $inventories[0].FullName -Raw | ConvertFrom-Json
        $expectedViews = @('og/full', 'og/half_horizontal', 'og/half_vertical',
            'v2/full', 'v2/half_horizontal', 'v2/half_vertical')
        if (@(Compare-Object $expectedViews @($inventory.views)).Count -or @($inventory.scenarios).Count -eq 0) {
            throw 'Incomplete rendering inventory.'
        }
        foreach ($view in $expectedViews) {
            if (!@($phases | Where-Object { $_.phase -eq 'render.view' -and $_.scenario.EndsWith("/$view") }).Count) {
                throw 'Missing executed native view.'
            }
        }
        foreach ($scenario in $inventory.scenarios) {
            if (!@($phases | Where-Object { $_.phase -eq 'scenario.load' -and $_.scenario -eq $scenario }).Count) {
                throw 'Missing executed synthetic scenario.'
            }
        }
        $evidence.phases.inventory = $inventory
    }
    catch { $missing.Add('complete rendering phase results') }
    foreach ($item in $missing) { $script:validationReport.unavailable.Add($item) }
    if ($missing.Count -eq 0) { $evidence.status = if ($reportedFailures) { 'failed' } else { 'complete' } }
    $script:validationReport.evidence = $evidence
    return $missing.Count -eq 0 -and $reportedFailures -eq 0
}

function Complete-ValidationReport([bool]$Passed) {
    $script:validationReport.finished_at = [DateTimeOffset]::UtcNow.ToString('O')
    $script:validationReport.outcome = if ($Passed) { 'passed' } else { 'failed' }
    Save-ValidationReport
}
