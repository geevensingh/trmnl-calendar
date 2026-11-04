# Native agenda references

These references cross the existing normalized synthetic agenda -> production
Liquid, framework/fonts, readiness/fitting -> native document/PNG seam. They are
not screenshots of workbench cards, a replacement renderer, or a simulation of
physical-panel sharpness. OG Full is the detailed comparison target for #114.
Physical appearance review and Git delivery remain separate gates.

## Capture fixed presentation and inputs

Use the [documented local prerequisites and setup](../README.md#local-validation).
The existing test runner provides a focused capture workflow, not another
validation entrypoint. From this worktree:

```powershell
$previousPresentation = $env:TRMNL_REFERENCE_PRESENTATION_COMMIT
$previousInput = $env:TRMNL_REFERENCE_INPUT_COMMIT
try {
    $env:TRMNL_REFERENCE_PRESENTATION_COMMIT = '34794a182538008215e134503f0862dc78363964'
    $env:TRMNL_REFERENCE_INPUT_COMMIT = '34794a182538008215e134503f0862dc78363964'
    dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj `
        --no-restore --nologo --verbosity minimal `
        --filter FullyQualifiedName~NativeReferenceTests `
        --logger 'trx;LogFileName=native-reference.trx'
    if ($LASTEXITCODE -ne 0) { throw 'Native reference capture failed; do not accept its outputs.' }
}
finally {
    $env:TRMNL_REFERENCE_PRESENTATION_COMMIT = $previousPresentation
    $env:TRMNL_REFERENCE_INPUT_COMMIT = $previousInput
}
```

The **initial presentation baseline stays
`34794a182538008215e134503f0862dc78363964`**. For a later candidate, change only the
presentation commit to its full accepted commit ID and keep the input commit
fixed. Without overrides, presentation resolves HEAD once and inputs use that
same resolved commit. Missing/incompatible history fails explicitly; it never
checks out files, changes the baseline, or falls back to live scenarios/templates.
Capture committed presentation content, not an uncommitted typography edit.
Use the ordinary workbench for save-time working-copy comparisons.

Each successful run writes a new ignored `artifacts\native-references\<run-id>`
directory, also printed in the test's TRX output. Preserve the original bundle;
do not replace it with a later run. The five scenarios are `normal-mixed`,
`dense-primary`, `long-text`, `emphasis-in-progress`, and `emphasis-upcoming`.
The latter two supplement the required normal/dense/long-title references with
inverse-block evidence. All inputs are committed synthetic scenarios.

The bundle contains the pinned production renderer/timing/templates/contract,
exact scenario files, normalized `*-agenda.json` payloads, production `*.html`,
actual 800 x 480 `*.png`, text-hidden raster comparisons, and `manifest.json`.
The manifest records full presentation/input identities, scenario/payload/output
SHA-256s, framework 3.4.3 and installed font/asset hashes, browser version,
harness source hashes and dirty status, native screen/view geometry, viewport
and device scale factor 1, completed font/framework/fitting readiness, and
layout findings captured at the native readiness publication itself. The
manifest is written only after every capture succeeds; an unfinished directory
is not accepted evidence.

Per-role records cover date/count, ordinary timed/all-day labels and titles,
source prefix/timestamp, and emphasized title/time/status. They include computed
family/size/weight, text rectangles, Chromium's **actually used platform fonts**
(including custom/fallback identities and glyph counts), and real foreground
differences against a text-hidden native capture. Font-face loading status is
retained, including unsuccessful probe/fallback faces; actual required custom
glyphs and painted text must still be present. A variable font's PostScript
name is not proof of its effective weight; glyph counts may include elided text.
Neither CSS size/weight nor whole-string pixel totals establish equal apparent
letter size or physical crispness.

Day/row records preserve eligible/displayed totals, displayed IDs, optional
location admission/truncation, title truncation/ellipsis policy, emphasis and
header alignment. Compare those records and PNGs using identical input hashes;
do not silently alter text or timestamps to make a comparison fit. Non-Latin
system fallback can differ between hosts, so retain browser/platform-font
evidence and rerun matched native comparisons on the same host when possible.
Investigations belong in ignored/session artifacts or issue evidence, not
committed generated outputs. Native facts do not diagnose firmware, lighting,
panel contrast, or the cause of a private photograph.

For review, open the PNG at **100% native pixels**. Image viewers may initially
scale it. The workbench's **Fit to window** remains an explicitly scaled
convenience; its **100% (scroll)** mode exposes the native document. Neither is
physical approval. No blur, gray overlay, or device-look filter is applied.
The isolated capture does not alter ordinary workbench use or supported layouts.
Use `.\scripts\validate.ps1 -Scope Full -DisplayCoverage Exhaustive` for the
complete retained native family; this focused OG workflow is not that proof.

## Typography candidate comparison

The #116 candidate reuses the installed Inter Variable font for date/count and
ordinary title/time roles. Ordinary rows retain their initial 21px size and
single-line end ellipsis; titles are bold (OG 700, existing X semibold 600) and
times normal 400. Dates are bold 700 with smaller normal-weight counts on the
same typographic baseline, not aligned by lowest ink pixels. Source metadata
keeps 16px and its placement, using normal-weight Inter rather than arbitrary
shrinking. Inverse cards retain larger bold titles and bold time/status.

Compare effective custom-font glyph identities, readiness-complete PNGs, and
the five same-input layout records rather than CSS family/weight declarations
alone. `TypographyDisplayTests` additionally observes actual Chromium fonts,
header baseline markers and identical title/time glyphs ("All day" and
"11:00 AM") in native screenshots across all six layouts. Horizontal raster
strips from the existing PNG inspector measure painted glyph height and dark
stroke counts. These controlled same-glyph measurements are distinct from
whole-string ink totals and from a claim about physical-panel crispness.
The existing lowercase-s and ellipsis raster thresholds remain required.

Record before/after displayed/eligible totals, displayed IDs, admitted optional
locations and truncated titles for each same-input scenario. A shorter
same-date source label or wider Inter title can change room/truncation without
changing eligibility or admission priorities. The reference is `generated_at`
in Los Angeles, not the browser clock or primary working day: same-date
source checks show time/timezone; all different-date checks include the year.
Keep missing/stale/error provenance visible. Pin candidate captures to the full
accepted presentation commit while retaining the initial input commit above.
Native implementation readiness does not satisfy downstream #117 physical
appearance acceptance, human landing or publication.

## Owner-controlled separate synthetic test plugin

These are instructions, **not authorization for an agent to perform account,
plugin, playlist, device, or release writes**. No physical photo is needed to
accept the #115 implementation prerequisite.

1. Privately record the ordinary device/playlist selection and any temporary
   display settings needed for restoration. Do not export its calendar data,
   keys, or the owner's supplied photograph into this workflow.
2. Create a **new, separate Private Plugin**, clearly named as synthetic
   typography comparison, in the owner-controlled account. Use the documented
   [Static strategy / Static Data](https://help.trmnl.com/en/articles/17434705-plugin-strategies):
   paste one bundle's `*-agenda.json` object exactly. Its keys become top-level
   variables; do not paste the scenario envelope or wrap it in `merge_variables`.
   Do not configure polling, the live agenda endpoint, source URL, or function
   key. Verify the complete IDs/totals and fixed timestamps in Your Variables.
   If the service rejects the unchanged input, stop and record that blocker;
   do not trim it or substitute private/live data.
3. Select framework **3.4.3**, and copy the bundle's
   `display\src\shared.liquid` and matching view templates into their editor
   tabs, retaining exactly the intended baseline presentation. Do not paste
   the local HTML screen wrapper or capture instrumentation. Check the saved
   templates/framework setting and the native render for missing fonts,
   errors, wrong dimensions, or incomplete fitting before device use. The
   local asset hashes are provenance, not proof that the service uses them.
4. Only the owner, or an operator with separately scoped approval, temporarily
   selects this synthetic plugin on **OG Full**. Wait for a completed fresh
   render/check-in; verify the displayed scenario, count, fixed source time,
   and emphasis rather than photographing a previously retained image. Record
   scenario/input/presentation IDs, framework setting, device model/firmware,
   capture time and relevant camera/lighting context with each synthetic photo.
   Repeat with the same inputs and intended candidate presentation for #117.
   Do not mistake the intentionally fixed synthetic source date for live
   freshness, or assume browser and service font/raster paths are identical.
5. Restore the privately recorded ordinary plugin/playlist and display
   settings, verify the normal display has actually returned, and remove the
   synthetic plugin from active selection. Do not edit/delete the ordinary
   plugin. Retention/deletion of the temporary plugin and photos stays under
   owner control. No automatic device switching or restoration is performed.

Matched physical photos and explicit owner appearance acceptance belong to
#117; native evidence cannot discharge them. Human landing/publication and the
repository's completion proof are still pending before delivery-ticket closure.
