# dsh-capability-composer -- one-shot (re)install into the web profile, the way DSH itself does it.
#
# WHY NOT A JUNCTION ANY MORE
# ---------------------------
# `link:E:/...` in the profile manifest looks like an install and survives until the
# next DSH launch -- then the desktop generation projector rewrites the manifest FROM
# ITS OWN REGISTRY and silently drops every field it does not own. A junction also
# breaks on machine moves and is invisible to DSH's sweep/backup.
#
# So the steps are:
#   1. syntax gate on both halves           (cheap, catches a broken edit)
#   2. the tool-diet test suite must pass   (functional gate, 148 checks)
#   3. install.mjs copies the plugin into a generation under
#      profiles/.generations/live/<name>+<ver>+<hash>/, writes the registry
#      (generation.json + desired.json) and then CALLS DSH's own
#      projectGenerations(), so all four manifest fields -- dependencies,
#      dsh.profile.bundles, pnpm.overrides and dsh.desktop.generationProjection --
#      are written by the official code and survive a restart.
#   4. install.mjs imports the Host half back out of the profile as a smoke test.
#
# A DSH restart is required afterwards.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- adaptive roots: NO literal drive letter, username or platform assumption -----------
# Pure ASCII on purpose (see the note further down): Windows PowerShell 5.1 reads a
# BOM-less .ps1 as ANSI, so any non-ASCII byte here would be corrupted. Also note the
# script must stay 5.1-compatible -- no '??', no '?.'.
$isWin = $true
$isMac = $false
if (Test-Path variable:IsWindows) { $isWin = [bool]$IsWindows }
if (Test-Path variable:IsMacOS) { $isMac = [bool]$IsMacOS }

# $Harness: DSH_HOME first (DSH exports it), else the documented per-OS location.
$Harness = $env:DSH_HOME
if (-not $Harness) {
    if ($isWin) {
        $Harness = Join-Path $env:APPDATA 'dsh-desktop/harness'
    } elseif ($isMac) {
        $Harness = Join-Path $HOME 'Library/Application Support/dsh-desktop/harness'
    } else {
        $cfg = $env:XDG_CONFIG_HOME
        if (-not $cfg) { $cfg = Join-Path $HOME '.config' }
        $Harness = Join-Path $cfg 'dsh-desktop/harness'
    }
}
$Profile = Join-Path $Harness 'profiles/web'

# $AppRoot: the folder that contains node_modules/dsh-desktop-market-installer.
# Resolution order: DSH_APP_ROOT -> the uninstall registry entry's DisplayIcon (Windows)
# -> a drive sweep for "<drive>:/DSH Desktop/resources/app". Never a literal drive.
$AppRoot = $env:DSH_APP_ROOT
if (-not $AppRoot -and $isWin) {
    $uninstallRoots = @(
        'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/Uninstall',
        'HKCU:/SOFTWARE/Microsoft/Windows/CurrentVersion/Uninstall',
        'HKLM:/SOFTWARE/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall'
    )
    foreach ($root in $uninstallRoots) {
        if ($AppRoot) { break }
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
            if ($AppRoot) { return }
            $entry = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($entry -and $entry.DisplayName -match 'DSH' -and $entry.DisplayIcon) {
                $exe = ($entry.DisplayIcon -split ',')[0].Trim('"')
                if (Test-Path $exe) {
                    $candidate = Join-Path (Split-Path -Parent $exe) 'resources/app'
                    if (Test-Path (Join-Path $candidate 'node_modules/dsh-desktop-market-installer')) {
                        $AppRoot = $candidate
                    }
                }
            }
        }
    }
}
if (-not $AppRoot -and $isWin) {
    foreach ($letter in 67..90) {
        if ($AppRoot) { break }
        $candidate = [string][char]$letter + ':/DSH Desktop/resources/app'
        if (Test-Path (Join-Path $candidate 'node_modules/dsh-desktop-market-installer')) { $AppRoot = $candidate }
    }
}
if ($AppRoot) { $env:DSH_APP_ROOT = $AppRoot }
# install.mjs also resolves on its own when this is empty -- it only needs DSH_APP_ROOT as a hint.

# ASCII-only derivation: a hard-coded non-ASCII path in a .ps1 gets decoded as ANSI by
# Windows PowerShell 5.1 and silently breaks. Measured: the tool-diet gate below
# was SKIPPED because the literal decoded to a mojibake path and Test-Path was false.
#
# The plugin source lives in a subfolder of the workspace, while the
# test suite stays at <workspace>/tests/. So walk UP from $Here until we find
# tests/composer_tool_diet_test.mjs -- no literal path, no non-ASCII byte.
$Tests = $null
$probe = $Here
for ($i = 0; $i -lt 6 -and $probe; $i++) {
    $candidate = Join-Path $probe 'tests/composer_tool_diet_test.mjs'
    if (Test-Path $candidate) { $Tests = $candidate; break }
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { break }
    $probe = $parent
}
if (-not $Tests) { $Tests = Join-Path $Here 'tests/composer_tool_diet_test.mjs' }

if (-not (Test-Path $Profile)) { throw "web profile not found: $Profile" }

# PowerShell 5.1 turns a native command's stderr into a terminating error when
# $ErrorActionPreference is Stop, so a warning would abort the deploy on success.
function Invoke-NodeGate {
    param([string]$Label, [string[]]$NodeArgs, [string]$FailMessage)
    Write-Host "gate    : $Label"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node @NodeArgs
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw $FailMessage }
}

Invoke-NodeGate -Label 'node --check lib\index.js' `
    -NodeArgs @('--check', (Join-Path $Here 'lib\index.js')) `
    -FailMessage 'host half has a syntax error'
Invoke-NodeGate -Label 'node --check lib\client.js' `
    -NodeArgs @('--check', (Join-Path $Here 'lib\client.js')) `
    -FailMessage 'client half has a syntax error'

if (Test-Path $Tests) {
    Invoke-NodeGate -Label 'running the tool-diet test suite' `
        -NodeArgs @($Tests) `
        -FailMessage 'test suite FAILED -- refusing to deploy'
} else {
    Write-Host "gate    : SKIPPED (test suite not found: $Tests)"
}

Write-Host ''
Invoke-NodeGate -Label 'running install.mjs (generation + official projector)' `
    -NodeArgs @((Join-Path $Here 'install.mjs')) `
    -FailMessage 'install.mjs FAILED -- the profile was NOT updated'
Write-Host ''

Write-Host 'DONE. Restart DSH to load the plugin.' -ForegroundColor Green
Write-Host ''
Write-Host 'Note: from now on, edits in the workspace need this script re-run.'
Write-Host ''
Write-Host 'Rollback (before restarting):'
Write-Host "  1. restore the authoritative pointer:"
Write-Host "       Copy-Item `"$(Join-Path $Harness 'profiles\.generations\desired.json.bak-before-capability-composer')`" `"$(Join-Path $Harness 'profiles\.generations\desired.json')`" -Force"
Write-Host "  2. re-project: just run this script again (it re-projects through the official "
Write-Host "     projector located relative to the DSH_APP_ROOT resolved above)."
Write-Host "  3. (optional) put the old junction back:"
Write-Host "       cmd /c mklink /J `"$(Join-Path $Profile 'node_modules\dsh-capability-composer')`" `"$Here`""
Write-Host "  4. restart DSH."
