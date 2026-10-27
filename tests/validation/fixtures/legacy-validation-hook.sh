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
