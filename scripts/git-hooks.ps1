#Requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Status', 'Install', 'Remove')][string]$Action = 'Status')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git and add it to PATH before managing local guardrails.'
}
$top = (& git -C $root rev-parse --show-toplevel) -join ''
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($top) -ne $root) {
    throw 'Run the hook manager from the scripts directory of a Git checkout.'
}
$common = (& git -C $root rev-parse --path-format=absolute --git-common-dir) -join ''
if ($LASTEXITCODE -ne 0 -or !$common) { throw 'Cannot locate the repository common Git directory.' }
$hookDirectory = Join-Path $common 'hooks'
$configuration = @(& git -C $root config --show-origin --get core.hooksPath)
$configurationExit = $LASTEXITCODE
if ($configurationExit -notin 0, 1) { throw 'Cannot inspect the effective core.hooksPath configuration.' }
if ($configurationExit -eq 0) {
    Write-Host "Existing core.hooksPath preserved: $($configuration -join ' ')"
    if ($Action -eq 'Install') {
        throw 'Refusing installation while core.hooksPath is configured. No hooks or Git configuration were changed. Integrate scripts\validate.ps1 into your existing hooks explicitly instead.'
    }
}

$template = @'
#!/bin/sh
# trmnl-calendar managed local validation hook v1
if ! command -v pwsh >/dev/null 2>&1; then
    echo "Local validation requires PowerShell 7 (pwsh) on PATH." >&2
    exit 1
fi
exec pwsh -NoLogo -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
$root = (git rev-parse --show-toplevel) -join ""
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$entrypoint = Join-Path $root "scripts\validate.ps1"
if (!(Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Missing scripts\validate.ps1 in this checkout. Restore it or remove the opt-in hooks with scripts\git-hooks.ps1 -Action Remove."
}
function Get-PublicationHead {
    $pending = @(git status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect the publication checkout." }
    if ($pending.Count -gt 0) {
        throw "Publication requires a clean checkout, including staged and untracked files. Commit or move pending changes before git push."
    }
    $head = (git rev-parse --verify HEAD) -join ""
    if ($LASTEXITCODE -ne 0) { throw "Cannot identify the publication checkout HEAD." }
    return $head
}
if ("__SCOPE__" -eq "Full") {
    $publicationHead = Get-PublicationHead
    foreach ($line in ([Console]::In.ReadToEnd() -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $update = $line.Trim() -split "\s+"
        if ($update.Count -ne 4 -or $update[1] -notmatch "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" -or
            $update[3] -notmatch "^(?:[a-f0-9]{40}|[a-f0-9]{64})$") {
            throw "Cannot read Git publication updates. Run the pre-push hook through git push."
        }
        if ($update[1] -match "^0+$") { continue }
        $published = (git rev-parse --verify "$($update[1])^{commit}") -join ""
        if ($LASTEXITCODE -ne 0 -or $published -ne $publicationHead) {
            throw "Only the checked-out HEAD can be published after validation. Check out the desired revision and push it separately."
        }
    }
}
& $entrypoint -Scope __SCOPE__
$validationExit = $LASTEXITCODE
if ($validationExit -ne 0) { exit $validationExit }
if ("__SCOPE__" -eq "Full" -and (Get-PublicationHead) -ne $publicationHead) {
    throw "Checkout HEAD changed during full validation. Retry git push from the intended clean checkout."
}
exit 0
'
'@
$template = $template.Replace("`r`n", "`n") + "`n"
$scopes = [ordered]@{ 'pre-commit' = 'Fast'; 'pre-merge-commit' = 'Fast'; 'pre-push' = 'Full' }
$entries = @()
if (Test-Path -LiteralPath $hookDirectory) {
    $directory = Get-Item -LiteralPath $hookDirectory -Force
    if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Preserved nonstandard hooks path $hookDirectory. Refusing to follow a linked directory or replace a file."
    }
    $entries = @(Get-ChildItem -LiteralPath $hookDirectory -Force)
}
$hooks = @(foreach ($name in $scopes.Keys) {
    $content = $template.Replace('__SCOPE__', $scopes[$name])
    $existing = $entries | Where-Object Name -EQ $name
    $state = 'Missing'
    if ($existing) {
        $state = 'Preserved'
        if (!$existing.PSIsContainer -and !($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($existing.FullName)) -ceq $content) {
            $state = 'Managed'
        }
    }
    [pscustomobject]@{
        Name = $name; Scope = $scopes[$name]; Path = Join-Path $hookDirectory $name
        Content = $content; State = $state
    }
})

Write-Host "Default hooks directory (shared by linked worktrees): $hookDirectory"
if ($Action -eq 'Status') {
    $hooks | Select-Object Name, Scope, State | Format-Table -AutoSize | Out-Host
    Write-Host 'Status only. Opt in with .\scripts\git-hooks.ps1 -Action Install.'
    exit 0
}
if ($Action -eq 'Install') {
    $conflicts = @($hooks | Where-Object State -EQ 'Preserved')
    if ($conflicts.Count -gt 0) {
        throw "Existing or modified hooks preserved: $($conflicts.Name -join ', '). No hooks were installed or overwritten."
    }
    if (!(Get-Command pwsh -ErrorAction SilentlyContinue)) {
        throw 'Install PowerShell 7 and add pwsh to PATH before installing hooks.'
    }
    $null = [IO.Directory]::CreateDirectory($hookDirectory)
    foreach ($hook in $hooks) {
        if ($hook.State -eq 'Missing') {
            $stream = [IO.File]::Open($hook.Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes($hook.Content)
                $stream.Write($bytes, 0, $bytes.Length)
            }
            finally { $stream.Dispose() }
        }
        if (!$IsWindows) {
            [IO.File]::SetUnixFileMode($hook.Path,
                [IO.UnixFileMode]'UserRead,UserWrite,UserExecute,GroupRead,GroupExecute,OtherRead,OtherExecute')
        }
        Write-Host "Installed $($hook.Name): $($hook.Scope) validation."
    }
}
else {
    foreach ($hook in $hooks) {
        if ($hook.State -eq 'Managed') {
            [IO.File]::Delete($hook.Path)
            Write-Host "Removed $($hook.Name)."
        }
        elseif ($hook.State -eq 'Preserved') {
            Write-Host "Preserved existing or modified hook: $($hook.Path)"
        }
    }
    if (@($hooks | Where-Object State -EQ 'Preserved').Count -gt 0) {
        throw 'Removal was partial: unrecognized or modified hooks were left untouched. Only exact generated hooks are removable by this tooling.'
    }
}
Write-Host 'No Git configuration was changed.'
exit 0
