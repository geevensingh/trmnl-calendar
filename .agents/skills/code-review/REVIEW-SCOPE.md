# Review snapshots and commit identity

Use this procedure from `code-review` before dispatch and from `implement` when binding acceptance. It uses existing Git and PowerShell, not a new validation entrypoint.

## Select the candidate

Resolve the baseline-selection rules in `SKILL.md` first. Supply these inputs in the repository root:

| Input | Meaning |
| --- | --- |
| `$fixedPoint` | Explicit revision or the implementation's recorded full baseline ID; never an invented fallback. |
| `$mode` | `committed` or `working-tree`. |
| `$paths` | Nonempty array of literal repository-relative file paths, including deleted paths and both sides of renames. Inventory all intended task changes before choosing it. |
| `$snapshotIndex` | Unique, nonexistent temporary file path outside the checkout, in the session artifacts. Its parent directory must exist. |

Keep exclusions and their reasons beside the snapshot. Committed mode deliberately excludes all staged, unstaged, and untracked work. Working-tree mode overlays **final working files** on the pinned head, seeding scoped index entries first so staged executable/symlink modes survive when Git ignores filesystem modes. Staged and unstaged edits to the same file compose into one final candidate, not two competing versions. Frozen layer patches expose both edits; if they cancel completely, only the effective final change is reviewed. Untracked additions appear in the final patch and `untracked` list.

Committed scope validation uses the pinned head/basis tree entries, not the live filesystem. An excluded local directory replacing a committed file cannot block that committed review.

Whole-file scope is intentional: if a file contains unrelated user hunks, first construct an explicit task-only candidate in a disposable copy/alternate index, preserving the user file and real index. Use that candidate's tree and patches in the same manifest below. If intent cannot be isolated confidently, clarify before review; including the whole mixed file is not an exclusion.

Resolve unmerged entries and index visibility restrictions before using the recipe. Dirty submodule contents need their own pinned review; a superproject tree only records the gitlink. Missing paths deleted in earlier implementation commits remain in scope without being re-added.

## Freeze the snapshot

The recipe returns `$review`, a manifest with immutable tree identities and frozen patches. Save its JSON outside the checkout with the spec/standards context and exclusions. Use `git --no-replace-objects` throughout capture, frozen-file reads, and binding so identities describe actual objects rather than local replacements. The real index, working files, branch, and commits are left unchanged; Git may write candidate objects to its object database. Restore the alternate-index environment and remove only the named temporary index, even on failure.

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-ReviewGit {
    $output = & git --no-replace-objects --no-optional-locks --no-pager --literal-pathspecs @args
    if ($LASTEXITCODE -ne 0) { throw "Review Git command failed: $($args[0]) ($LASTEXITCODE)." }
    $output
}
if ($mode -notin @('committed', 'working-tree')) { throw 'Specify the review mode.' }
if (@($paths).Count -eq 0) { throw 'Specify a nonempty literal file scope.' }
foreach ($path in $paths) {
    if (!$path -or ($mode -eq 'working-tree' -and
        (Test-Path -LiteralPath $path -PathType Container) -and
        (Get-Item -LiteralPath $path -Force).LinkType -ne 'SymbolicLink')) {
        throw 'Scope must contain individual file paths, not directories.'
    }
}
$baseline = Invoke-ReviewGit rev-parse --verify --end-of-options "$fixedPoint^{commit}"
$reviewHead = Invoke-ReviewGit rev-parse --verify 'HEAD^{commit}'
$bases = @(Invoke-ReviewGit merge-base --all $baseline $reviewHead)
if ($bases.Count -ne 1) { throw 'A unique comparison basis is required.' }
$basis = $bases[0]
if ($mode -eq 'committed') {
    foreach ($path in $paths) {
        $entries = @(Invoke-ReviewGit ls-tree $reviewHead '--' $path) +
            @(Invoke-ReviewGit ls-tree $basis '--' $path)
        if ($entries -match '^040000 ') {
            throw 'Scope must contain individual file paths, not directories.'
        }
    }
}
$headTree = Invoke-ReviewGit rev-parse "$reviewHead^{tree}"
$reviewTree = $headTree
$stagedPatch = @()
$unstagedPatch = @()
$untracked = @()
if ($mode -eq 'working-tree') {
    if (@(Invoke-ReviewGit ls-files --unmerged).Count) { throw 'Resolve unmerged entries before review.' }
    if (@(Invoke-ReviewGit ls-files -v '--' @paths) -cmatch '^[a-zS] ') {
        throw 'Scoped index visibility is restricted; resolve it explicitly before review.'
    }
    $stagedPatch = @(Invoke-ReviewGit diff --binary --full-index --no-ext-diff --no-textconv --cached $reviewHead '--' @paths)
    $unstagedPatch = @(Invoke-ReviewGit diff --binary --full-index --no-ext-diff --no-textconv '--' @paths)
    $untracked = @(Invoke-ReviewGit ls-files --others --exclude-standard '--' @paths)
    $stagedEntries = [System.Collections.Generic.Dictionary[string, string[]]]::new([System.StringComparer]::Ordinal)
    foreach ($path in $paths) {
        $entry = @(Invoke-ReviewGit ls-files '--format=%(objectmode) %(objectname)' '--' $path)
        if ($entry.Count -gt 1) { throw 'Scope must identify individual index entries.' }
        if ($entry.Count -eq 1) { $stagedEntries[$path] = $entry[0] -split ' ' }
    }
    if (Test-Path -LiteralPath $snapshotIndex) { throw 'Temporary index must not already exist.' }
    $previousIndex = $env:GIT_INDEX_FILE
    try {
        $env:GIT_INDEX_FILE = $snapshotIndex
        Invoke-ReviewGit read-tree $reviewHead
        Invoke-ReviewGit update-index --force-remove '--' @paths
        foreach ($path in $stagedEntries.psbase.Keys) {
            $entry = $stagedEntries[$path]
            Invoke-ReviewGit update-index --add --cacheinfo $entry[0] $entry[1] $path
        }
        foreach ($path in $paths) {
            if ((Test-Path -LiteralPath $path) -or @(Invoke-ReviewGit ls-files '--' $path).Count) {
                Invoke-ReviewGit add --all '--' $path
            }
        }
        $reviewTree = Invoke-ReviewGit write-tree
    }
    finally {
        $env:GIT_INDEX_FILE = $previousIndex
        if (Test-Path -LiteralPath $snapshotIndex) { Remove-Item -LiteralPath $snapshotIndex }
    }
}
$patch = @(Invoke-ReviewGit diff --binary --full-index --no-ext-diff --no-textconv $basis $reviewTree '--' @paths)
if ($patch.Count -eq 0) { throw 'Empty scoped change; no reviewers dispatched.' }
$review = [ordered]@{
    mode = $mode; baseline = $baseline; basis = $basis; head = $reviewHead
    tree = $reviewTree; scope = @($paths)
    commits = @(Invoke-ReviewGit log '--format=%H %s' "$basis..$reviewHead" '--' @paths)
    entries = @(Invoke-ReviewGit ls-tree -r $reviewTree '--' @paths)
    patch = $patch
    committed_patch = @(Invoke-ReviewGit diff --binary --full-index --no-ext-diff --no-textconv $basis $reviewHead '--' @paths)
    staged_patch = $stagedPatch; unstaged_patch = $unstagedPatch; untracked = $untracked
}
$review | ConvertTo-Json -Depth 5
```

The immutable comparison is `git --no-replace-objects --literal-pathspecs diff --binary --full-index --no-ext-diff --no-textconv <basis> <tree> -- <scope>`. Both axes receive the same saved manifest and bundle, not separate snapshots. Full file context is available through `git --no-replace-objects show <tree>:<path>`; deleted-file context comes from `<basis>:<path>` with the same option. The commit list can be empty in working-tree mode.

The recipe is a point-in-time capture, not a lock. Reinventory task scope and repeat the capture before dispatch and before committing, comparing head, tree, scope, aggregate patch, and source context with the accepted bundle. Changes during capture require a fresh stable snapshot. Staging reviewed content can redistribute the layer patches without changing the candidate; that alone needs no renewed review. A newly added task file is a scope change even if the old scoped tree still matches. Excluded user edits remain excluded and preserved. For a task-only hunk candidate, repeat its isolation rather than using the whole-file overlay.

## Bind the resulting commit

Commit only after the agreed validation and review gates. Retain the accepted manifest as `$review`; do not overwrite it with a fresh capture. Verify unchanged candidate content/scope/context first. When committing, select only task changes between `$review.head` and `$review.tree`, not unrelated staged files. For whole-file content candidates, stage each task path (`git --no-replace-objects --literal-pathspecs add --all -- <task-paths>`) only if it exists in the working tree or its literal index entry still exists, using the snapshot recipe's `Test-Path -LiteralPath` / `ls-files` condition. Already-staged deletions need no further add; retain them in the full task-path list for the path-limited commit (`git --no-replace-objects --literal-pathspecs commit --only -- <task-paths>`) if unrelated staged work exists, except for the index-only modes below. Keep literal matching through every scoped operation so filenames containing pattern characters cannot include excluded files.

Git's path-limited commit can discard index-only executable modes when `core.filemode=false` and index-only symlink types when `core.symlinks=false` (plain link-target text in the working file, mode `120000` in the index). For either configuration, preserve the reviewed index mode with an ordinary `git --no-replace-objects commit` only when the index contains task work alone; avoid `--only` and `--all`. If unrelated staged work exists, use a separate temporary `GIT_INDEX_FILE` initialized with `git --no-replace-objects read-tree <reviewed-tree>`, commit that candidate with the same ordinary command, then restore the original index environment and refresh **only task paths** in its staging area from the new commit (`git --no-replace-objects --literal-pathspecs restore --staged --source=<commit> -- <task-paths>`). Preserve excluded staged entries and all working files; restore the environment and remove only the named temporary index in `finally`. Hunk-isolated candidates need an equally isolated commit and preserved excluded hunks, not the whole-file staging refresh.

If the candidate tree already equals the pinned head tree, use that existing head; no empty or premature commit is necessary. Otherwise the eventual commit must have exactly the pinned head as its single parent and exactly the candidate's **whole tree**, not merely similar patch text or matching filenames. A rebase, intervening commit, squash, added path, mode change, or different file content invalidates this binding and needs renewed review/verification.

Set `$candidate` to the full resulting commit ID and run:

```powershell
if ($candidate -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') { throw 'Use a full implementation commit ID.' }
$acceptedCommit = & git --no-replace-objects rev-parse --verify --end-of-options "$candidate^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'Implementation commit does not resolve.' }
$acceptedTree = & git --no-replace-objects rev-parse "$acceptedCommit^{tree}"
if ($LASTEXITCODE -ne 0) { throw 'Implementation tree does not resolve.' }
if ($acceptedTree -ne $review.tree) { throw 'Content changed; renew review and verification.' }
if ($acceptedCommit -ne $review.head) {
    if ($review.mode -ne 'working-tree') { throw 'Committed review accepts only its pinned head.' }
    $line = & git --no-replace-objects rev-list --parents -n 1 $acceptedCommit
    if ($LASTEXITCODE -ne 0) { throw 'Implementation parents do not resolve.' }
    $identities = $line -split ' '
    if ($identities.Count -ne 2 -or $identities[1] -ne $review.head) {
        throw 'Review head changed; renew review and verification.'
    }
}
[ordered]@{
    accepted_commit = $acceptedCommit; reviewed_tree = $review.tree
    baseline = $review.baseline; basis = $review.basis; review_head = $review.head
    mode = $review.mode; scope = @($review.scope)
} | ConvertTo-Json -Depth 5
```

Record this full accepted commit ID with both axis reports, scope/exclusions, and validation evidence under the delivery contract. If the post-commit check fails, record **no acceptance** for that commit. Preserve work and return to the affected review/validation gates rather than rewriting history automatically. This binding establishes implementation evidence, not human landing or publication.

## Disposable demonstrations

`tests\validation\review-scope.test.mjs` executes these Markdown recipes with real Git in disposable repositories under Node's existing test runner. It covers committed-only and uncommitted-only changes, layered staged/unstaged edits, task untracked files, unrelated staged/unstaged/untracked work, recorded and invalid baselines, empty changes, staged executable modes with `core.filemode=false`, index-only symlinks with `core.symlinks=false`, replacement objects affecting capture/frozen reads/binding, literal filenames containing pattern characters or dictionary member names, case-distinct Git paths, directory symlinks as single file entries, staged and unstaged deletions, renamed paths, and post-review content/scope/parent changes. Diagnostics identify each shared review snapshot and accepted commit; these are recipe demonstrations, not additional reviewers or acceptance of production changes.
