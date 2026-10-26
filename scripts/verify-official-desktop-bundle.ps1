# Validate official, *unmodified* OpenCode Desktop 2.1.4 installer on
# an ephemeral Windows GitHub Actions runner and expose its bundled native CLI.
# Never run NSIS installer and never use the runner's ordinary user profiles.
$ErrorActionPreference = 'Stop'
$version = '2.1.4'
$url = "https://opencode.ai/files/bin/$version/opencode-desktop-win-x64.exe"
$root = Join-Path $env:RUNNER_TEMP 'coo-official-desktop-2_1_4'
$installer = Join-Path $root 'opencode-desktop-win-x64.exe'
$outer = Join-Path $root 'unpacked-nsis'
New-Item -ItemType Directory -Force -Path $root,$outer | Out-Null
$seven = (Get-Command '7z.exe' -ErrorAction SilentlyContinue).Source
if (-not $seven) { $seven = 'C:\Program Files\7-Zip\7z.exe' }
if (-not (Test-Path -LiteralPath $seven)) { throw 'windows_7z_required_for_official_desktop_proof' }

# Stable exact-version vendor URL, never /latest, no third-party mirrors.
Invoke-WebRequest -Uri $url -OutFile $installer -TimeoutSec 240 -MaximumRedirection 3
$file = Get-Item -LiteralPath $installer
if ($file.Length -lt 50MB -or $file.Length -gt 300MB) {
  throw 'official_desktop_installer_size_unexpected'
}
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid') {
  throw ('official_desktop_signature_invalid_' + $signature.Status)
}
if (-not $signature.SignerCertificate) { throw 'official_desktop_signer_missing' }
$installerDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
& $seven x -y "-o$outer" $installer | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'official_desktop_installer_unpack_failed' }

function Find-Cli($directory) {
  $hits = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter 'opencode-cli.exe' -ErrorAction Stop)
  if ($hits.Count -eq 0) { return $null }
  $matches = @($hits | Where-Object { $_.FullName -match '[\\/]resources[\\/]opencode-cli\.exe$' })
  if ($matches.Count -eq 1) { return $matches[0].FullName }
  throw 'official_desktop_embedded_cli_ambiguous'
}
$cli = Find-Cli $outer
if (-not $cli) {
  $archives = @(Get-ChildItem -LiteralPath $outer -Recurse -File -Filter 'app-*.7z')
  if ($archives.Count -ne 1) { throw 'official_desktop_embedded_cli_not_found_in_nsis' }
  $inner = Join-Path $root 'unpacked-app'
  New-Item -ItemType Directory -Force -Path $inner | Out-Null
  & $seven x -y "-o$inner" $archives[0].FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'official_desktop_app_archive_unpack_failed' }
  $cli = Find-Cli $inner
}
if (-not $cli) { throw 'official_desktop_cli_missing' }
$cli = (Resolve-Path -LiteralPath $cli).Path
if (-not $cli.StartsWith($root + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) {
  throw 'official_desktop_cli_path_outside_runner'
}
$reply = (& $cli --version 2>&1 | Out-String).Trim()
$cliExit = $LASTEXITCODE
$versionFile = Join-Path (Split-Path -Parent $cli) 'opencode-cli.version'
$metadataVersion = if (Test-Path -LiteralPath $versionFile) {
  (Get-Content -LiteralPath $versionFile -Raw).Trim()
} else { 'missing' }
# Version metadata and exit code are nonsensitive fixed-size diagnostics; never
# print the environment, the CLI path, user profiles, or any model/account data.
$bounded = if ($reply.Length -gt 96) { $reply.Substring(0,96) } else { $reply }
$bounded = $bounded -replace '[^a-zA-Z0-9._ +\\r\\n-]', '?'
Write-Output ("OFFICIAL_DESKTOP_CLI_EXACT_VERSION_DIAGNOSTIC=" +
  ($bounded -replace '[\\r\\n]+', ' ') + ";exit=" + $cliExit +
  ";resourceVersion=" + ($metadataVersion -replace '[^a-zA-Z0-9._-]', '?'))
if ($cliExit -ne 0 -or $reply -ne $version) {
  throw 'official_desktop_bundled_cli_wrong_version'
}
$cliDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $cli).Hash.ToLowerInvariant()
Write-Output ("OFFICIAL_DESKTOP_WINDOWS_INSTALLER_SIGNATURE=Valid")
Write-Output ("OFFICIAL_DESKTOP_WINDOWS_INSTALLER_SHA256=" + $installerDigest)
Write-Output ("OFFICIAL_DESKTOP_EMBEDDED_CLI_VERSION=" + $reply)
Write-Output ("OFFICIAL_DESKTOP_EMBEDDED_CLI_SHA256=" + $cliDigest)
if (-not $env:GITHUB_ENV) { throw 'github_actions_runner_only' }
"CHAT_ON_OPENCODE_TEST_CLI=$cli" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
