import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function checkout(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agenda display setup ")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
  for (const file of ["Gemfile", "Gemfile.lock"])
    await cp(join(root, file), join(directory, file));
  const calls = join(directory, "calls.jsonl");
  const sdkHome = join(directory, "sdk home");
  const tools = join(directory, "synthetic tools");
  await mkdir(sdkHome);
  await mkdir(tools);
  const browser = join(directory, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0", "playwright.ps1");
  await mkdir(dirname(browser), { recursive: true });
  await writeFile(browser, String.raw`
@{ tool = 'playwright'; arguments = @($args); cache = $env:PLAYWRIGHT_BROWSERS_PATH } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
dotnet fixture-playwright.dll @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$installed = Join-Path $env:PLAYWRIGHT_BROWSERS_PATH 'synthetic-pinned-chromium'
if ($args[0] -eq 'install') {
  if ($env:DISPLAY_FAIL -eq 'browser-install-throw') { throw 'Synthetic unusable browser installer' }
  if ($env:DISPLAY_FAIL -eq 'browser-install') { exit 61 }
  New-Item -ItemType Directory -Force $env:PLAYWRIGHT_BROWSERS_PATH | Out-Null
  'ready' | Set-Content -LiteralPath $installed
  exit 0
}
if (!(Test-Path -LiteralPath $installed) -or $env:DISPLAY_FAIL -eq 'browser-launch') { exit 62 }
'synthetic screenshot' | Set-Content -LiteralPath $args[-1]
exit 0
`);
  const run = (environment = {}) => {
    const inherited = { ...process.env };
    for (const name of Object.keys(inherited)) {
      if (["DOTNET_GENERATE_ASPNET_CERTIFICATE", "DOTNET_CLI_HOME", "TRMNL_RUBY"].includes(name.toUpperCase()) ||
          name.toUpperCase().startsWith("DISPLAY_"))
        delete inherited[name];
    }
    return spawnSync("pwsh", [
      "-NoProfile", "-NonInteractive", "-Command", String.raw`
      $env:PATH = $env:DISPLAY_TOOLS
      function global:Get-Command {
        [CmdletBinding()]
        param([Parameter(Position = 0)][string]$Name)
        if ($Name -eq $env:DISPLAY_MISSING_TOOL) { return }
        if ($Name -eq 'ruby' -and $env:DISPLAY_MISSING_RUBY) { return }
        Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
      }
      function global:Invoke-SyntheticRuby {
        @{ tool = 'ruby'; arguments = @($args); gemfile = $env:BUNDLE_GEMFILE;
           config = $env:BUNDLE_APP_CONFIG; bundlePath = $env:BUNDLE_PATH;
           frozen = $env:BUNDLE_FROZEN; ignoreConfig = $env:BUNDLE_IGNORE_CONFIG;
           userCache = $env:BUNDLE_USER_CACHE } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        if ($args[0] -eq '-e' -and $args[1] -match 'RUBY_VERSION') {
          if ($env:DISPLAY_FAIL -eq 'ruby') {
            $global:LASTEXITCODE = 31
          } else {
            if ($env:DISPLAY_RUBY_VERSION) { $env:DISPLAY_RUBY_VERSION } else { '4.0.0' }
            $global:LASTEXITCODE = 0
          }
          return
        }
        if ($args[0] -eq '-e' -and $args[1] -match 'Bundler::VERSION') {
          if ($env:DISPLAY_FAIL -eq 'bundler') {
            $global:LASTEXITCODE = 32
          } else {
            if ($env:DISPLAY_BUNDLER_VERSION) { $env:DISPLAY_BUNDLER_VERSION } else { '4.0.20' }
            $global:LASTEXITCODE = 0
          }
          return
        }
        if ($args[0] -eq '-e' -and $args[1] -match 'mkmf') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'native') { 33 } else { 0 }
          return
        }
        if ($args -contains 'check') {
          $global:LASTEXITCODE = if (Test-Path -LiteralPath (Join-Path $env:BUNDLE_PATH 'synthetic-gems')) { 0 } else { 54 }
          return
        }
        if ($args -contains 'config') {
          if ($env:DISPLAY_FAIL -eq 'bundle-config') { $global:LASTEXITCODE = 58; return }
          New-Item -ItemType Directory -Force $env:BUNDLE_APP_CONFIG | Out-Null
          $config = Join-Path $env:BUNDLE_APP_CONFIG 'config'
          if ($env:BUNDLE_IGNORE_CONFIG) {
            ($args -join ' ') | Set-Content -LiteralPath $config
          } else {
            ($args -join ' ') | Add-Content -LiteralPath $config
          }
          $global:LASTEXITCODE = 0
          return
        }
        if ($args -contains 'install') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'bundle-install') { 55 } else { 0 }
          New-Item -ItemType Directory -Force $env:BUNDLE_PATH | Out-Null
          'interrupted gem restore' | Set-Content -LiteralPath (Join-Path $env:BUNDLE_PATH 'partial-gem')
          if ($LASTEXITCODE -eq 0) {
            'ready' | Set-Content -LiteralPath (Join-Path $env:BUNDLE_PATH 'synthetic-gems')
          }
          return
        }
        if (($args -join ' ') -match 'trmnl/liquid') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'gems') { 56 } else { 0 }
          return
        }
        $global:LASTEXITCODE = 53
      }
      function global:Invoke-WebRequest {
        param($Uri, $OutFile, $TimeoutSec)
        @{ tool = 'download'; uri = "$Uri"; target = $OutFile } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        if ($env:DISPLAY_FAIL -eq 'download') {
          'interrupted download' | Set-Content -LiteralPath $OutFile
          throw 'Synthetic network failure'
        }
        $content = if ("$Uri" -match '\.css$') {
          '@font-face{src:url("/fonts/trmnl.woff2")} @font-face{src:url("/fonts/classic.ttf")}'
        } else { 'synthetic complete asset' }
        $content | Set-Content -LiteralPath $OutFile
      }
      function global:Expand-Archive {
        param($LiteralPath, $Path, $DestinationPath, [switch]$Force)
        if (!$LiteralPath) { $LiteralPath = $Path }
        @{ tool = 'extract'; archive = $LiteralPath; target = $DestinationPath } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        New-Item -ItemType Directory -Force $DestinationPath | Out-Null
        $font = if ($LiteralPath -match 'classic') { 'classic.ttf' } else { 'trmnl.woff2' }
        'incomplete font' | Set-Content -LiteralPath (Join-Path $DestinationPath $font)
        if ($env:DISPLAY_FAIL -eq 'extract') { throw 'Synthetic corrupt archive' }
        'synthetic font' | Set-Content -LiteralPath (Join-Path $DestinationPath $font)
      }
      function global:dotnet {
        $state = Join-Path $env:DOTNET_CLI_HOME 'fixture-first-run'
        $firstRun = !(Test-Path -LiteralPath $state)
        @{ tool = 'dotnet'; arguments = @($args); sdkHome = $env:DOTNET_CLI_HOME;
           firstRun = $firstRun; certificate = $env:DOTNET_GENERATE_ASPNET_CERTIFICATE;
           certificateAttempt = $firstRun -and $env:DOTNET_GENERATE_ASPNET_CERTIFICATE -ne 'false' } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        Set-Content -LiteralPath $state 'synthetic SDK first-run state'
        if ($env:DISPLAY_FAIL -eq 'dotnet:throw') { throw 'Synthetic unusable SDK executable' }
        if ($args[0] -eq '--version') {
          if ($env:DISPLAY_SDK_VERSION) { $env:DISPLAY_SDK_VERSION } else { '10.0.100' }
        }
        $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq "dotnet:$($args[0])") { 57 } else { 0 }
      }
      function global:Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $RedirectStandardOutput,
          $RedirectStandardError, [switch]$PassThru, [switch]$NoNewWindow)
        @{ tool = 'native-probe'; arguments = @($ArgumentList); executable = $FilePath } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        '' | Set-Content -LiteralPath $RedirectStandardOutput
        '' | Set-Content -LiteralPath $RedirectStandardError
        $process = [pscustomobject]@{
          ExitCode = if ($env:DISPLAY_FAIL -eq 'native') { 33 } else { 0 }
          Killed = $false
        }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
          param($Milliseconds)
          @{ tool = 'native-wait'; arguments = @($Milliseconds) } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
          return $env:DISPLAY_FAIL -ne 'native-timeout' -or $this.Killed
        }
        $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
          param($EntireTree)
          $this.Killed = $true
          @{ tool = 'native-kill'; arguments = @($EntireTree) } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        }
        $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $process
      }
      function global:Remove-Item {
        [CmdletBinding()]
        param($LiteralPath, $Path, [switch]$Recurse, [switch]$Force)
        if ($env:DISPLAY_FAIL -eq 'cleanup' -and $LiteralPath -match 'display-setup-') {
          throw 'Synthetic staging cleanup failure'
        }
        Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
      }
      Set-Alias -Name $env:DISPLAY_SHARED_RUBY -Value Invoke-SyntheticRuby -Scope Global
      Set-Alias -Name ruby -Value Invoke-SyntheticRuby -Scope Global
      Set-Alias -Name (Join-Path $env:DISPLAY_ROOT '.tools\ruby\bin\ruby.exe') -Value Invoke-SyntheticRuby -Scope Global
      $before = @{}
      Get-ChildItem Env: | Where-Object {
        $_.Name -like 'BUNDLE_*' -or $_.Name -in @('PATH', 'TRMNL_RUBY', 'DOTNET_CLI_HOME',
          'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'PLAYWRIGHT_BROWSERS_PATH')
      } | ForEach-Object { $before[$_.Name] = $_.Value }
      $code = 0
      try { & $env:DISPLAY_SCRIPT }
      catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
      finally {
        $after = @{}
        Get-ChildItem Env: | Where-Object {
          $_.Name -like 'BUNDLE_*' -or $_.Name -in @('PATH', 'TRMNL_RUBY', 'DOTNET_CLI_HOME',
            'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'PLAYWRIGHT_BROWSERS_PATH')
        } | ForEach-Object { $after[$_.Name] = $_.Value }
        @{ before = $before; after = $after } | ConvertTo-Json -Depth 5 |
          Set-Content -LiteralPath $env:DISPLAY_ENVIRONMENT
      }
      exit $code
    `
    ], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: {
        ...inherited, DISPLAY_ROOT: directory, DISPLAY_SCRIPT: join(directory, "scripts", "setup-display.ps1"),
        DISPLAY_CALLS: calls, DISPLAY_SHARED_RUBY: join(directory, "shared tools", "bin", "ruby.exe"),
        DISPLAY_ENVIRONMENT: join(directory, "environment.json"), DISPLAY_TOOLS: tools, DISPLAY_FAIL: "",
        DOTNET_CLI_HOME: sdkHome, PLAYWRIGHT_BROWSERS_PATH: join(directory, "shared browser cache"),
        TRMNL_RUBY: join(directory, "shared tools", "bin", "ruby.exe"), ...environment
      }
    });
  };
  return {
    directory, sdkHome, run,
    environment: async () => JSON.parse(await readFile(join(directory, "environment.json"), "utf8")),
    calls: async () => {
      try { return (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    }
  };
}
