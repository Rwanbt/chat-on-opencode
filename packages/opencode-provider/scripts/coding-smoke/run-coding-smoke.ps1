<#
.SYNOPSIS
  Real-project coding smoke test for the chat-on-opencode provider.

.DESCRIPTION
  Runs the acceptance loop of ADR-0001 against a disposable fixture project:
  the model reads a file, proposes an edit, OpenCode executes it, the model
  runs the test, observes the result and reports the outcome.

  The runner proves the receipts itself, so a run cannot be called green by
  assertion: it re-arms the fixture from a proven RED state, records the RED
  exit code, runs the CLI, lists the tool calls the native turn actually
  executed, and re-runs the test afterwards.

  Nothing personal is read or written. The CLI, the provider profile and the
  fixture all live in disposable directories that the caller names.

.PARAMETER Cli
  Path to the disposable OpenCode CLI executable.

.PARAMETER Profile
  Path to the isolated OpenCode profile. Its configuration must select
  `nativeTools: "coding"`; the runner refuses any other mode.

.PARAMETER Fixture
  Where the fixture is materialised. Defaults to `<Profile>\fixture-coding`.

.PARAMETER Model
  The provider model to run. Defaults to `chat-on-opencode/chatgpt-default`.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-coding-smoke.ps1 `
    -Cli C:\disposable\opencode-cli.exe -Profile C:\disposable\profile
#>
param(
  [Parameter(Mandatory = $true)][string]$Cli,
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Fixture = '',
  [string]$Model = 'chat-on-opencode/chatgpt-default',
  [string]$Agent = 'build'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'fixture'
if (-not (Test-Path $Cli)) { throw ('cli_not_found: ' + $Cli) }
if (-not (Test-Path $Profile)) { throw ('profile_not_found: ' + $Profile) }
if (-not $Fixture) { $Fixture = Join-Path $Profile 'fixture-coding' }

# The mode is the point of the run: a profile that does not select the coding
# bridge would prove the wrong thing, so it is refused rather than assumed.
$config = Join-Path $Profile 'opencode.jsonc'
if (-not (Test-Path $config)) { throw ('profile_config_not_found: ' + $config) }
$configText = [System.IO.File]::ReadAllText($config)
if ($configText -notmatch '"nativeTools"\s*:\s*"coding"') { throw 'profile_not_in_coding_mode' }

# Materialise the fixture from the checkout, so the run is reproducible from a
# clean tree and never depends on a previous run's leftovers.
New-Item -ItemType Directory -Force -Path $Fixture | Out-Null
foreach ($file in 'sum.js', 'sum.test.js', 'package.json') {
  Copy-Item (Join-Path $source $file) (Join-Path $Fixture $file) -Force
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $Profile ("run-" + $stamp + ".out.json")
$err = Join-Path $Profile ("run-" + $stamp + ".err.log")
$test = Join-Path $Fixture 'sum.test.js'
$target = Join-Path $Fixture 'sum.js'

$env:OPENCODE_CONFIG_DIR = $Profile
$env:OPENCODE_CONFIG_PROJECT_DISABLE = '1'
$env:OPENCODE_DISABLE_PROJECT_CONFIG = '1'
$env:OPENCODE_DISABLE_AUTOUPDATE = '1'
$env:OPENCODE_DISABLE_MODELS_FETCH = '1'
$env:OPENCODE_DISABLE_DEFAULT_PLUGINS = '1'
$env:CHAT_ON_OPENCODE_GATEWAY_KEY = 'local-smoke-placeholder'
$env:CHAT_ON_OPENCODE_STAGE_TRACE = Join-Path $Profile 'stage-trace.log'
Remove-Item $env:CHAT_ON_OPENCODE_STAGE_TRACE -ErrorAction SilentlyContinue
$env:XDG_CONFIG_HOME = Join-Path $Profile 'xdg-config'
$env:XDG_DATA_HOME = Join-Path $Profile 'xdg-data'
$env:XDG_CACHE_HOME = Join-Path $Profile 'xdg-cache'
$env:XDG_STATE_HOME = Join-Path $Profile 'xdg-state'

# The fixture is RED before the model touches it: the qualification only counts
# if the test genuinely fails first.
$ErrorActionPreference = 'Continue'
& node $test 2>&1 | Out-Null
$redExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($redExit -eq 0) { throw 'fixture_not_red' }
Write-Output ("RED_FIXTURE_EXIT=" + $redExit)

$prompt = "The project in this directory has one failing test. In $target the exported function sum(a, b) subtracts instead of adding, so running 'node sum.test.js' fails with '-1 !== 5'. Read that file, fix it so sum adds its two arguments, then run 'node sum.test.js' to verify the test passes, and finally report the outcome in one short sentence."
Write-Output ("PROMPT=" + $prompt)
Write-Output ("STDOUT=" + $out)
Write-Output ("STDERR=" + $err)

Push-Location $Fixture
# PowerShell 5.1 turns native stderr into ErrorRecords; with Stop it would kill
# the run on the first log line. The CLI's stderr is the evidence, not a failure.
$ErrorActionPreference = 'Continue'
& $Cli run --standalone --model $Model --agent $Agent --format json --auto --print-logs --log-level info $prompt 1> $out 2> $err
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Pop-Location
Write-Output ("EXIT=" + $code)

# The receipts: the tool calls the native turn executed, in order.
$tools = @()
$answer = ''
if (Test-Path $out) {
  foreach ($line in Get-Content $out -Encoding UTF8) {
    if (-not $line.Trim()) { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -eq 'tool_use') {
      $tools += ($event.part.tool + ':' + $event.part.state.status)
    } elseif ($event.type -eq 'text') {
      $answer = $event.part.text
    }
  }
}
Write-Output ("TOOL_CALLS=" + ($tools -join ' -> '))
Write-Output ("ANSWER=" + ($answer -replace "`r?`n", ' '))

$ErrorActionPreference = 'Continue'
$testOutput = & node $test 2>&1 | Out-String
$greenExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Output ("TEST_OUTPUT=" + ($testOutput -replace "`r?`n", ' ').Trim())
Write-Output ("GREEN_TEST_EXIT=" + $greenExit)

$read = $tools -contains 'read:completed'
$patch = $tools -contains 'patch:completed'
$shell = $tools -contains 'shell:completed'
if ($code -eq 0 -and $redExit -ne 0 -and $greenExit -eq 0 -and $read -and $patch -and $shell -and $answer) {
  Write-Output 'SMOKE=PASS'
  exit 0
}
Write-Output 'SMOKE=FAIL'
exit 1
