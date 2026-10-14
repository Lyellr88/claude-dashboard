$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$describer = Join-Path $repoRoot 'bin/describe-scripts.ps1'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = Join-Path $tempRoot ("claude-dashboard-test-" + [guid]::NewGuid().ToString('N'))
$probe = Join-Path $fixture 'safety-probe.ps1'
$defaultMarker = Join-Path $fixture 'default.marker'
$dynamicMarker = Join-Path $fixture 'dynamic.marker'

if (-not ([IO.Path]::GetFullPath($fixture).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'The fixture must stay under the system temp directory.'
}

New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    @'
param([string]$Value = $([System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'default.marker'), 'ran'); 'default'))
dynamicparam {
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'dynamic.marker'), 'ran')
  return [System.Management.Automation.RuntimeDefinedParameterDictionary]::new()
}
'@ | Set-Content -LiteralPath $probe

    $json = & pwsh -NoProfile -File $describer -Dir $fixture
    if ($LASTEXITCODE -ne 0) { throw 'The script describer returned a failure exit code.' }
    $result = ($json -join [Environment]::NewLine) | ConvertFrom-Json
    $entry = $result.entries | Select-Object -First 1
    $parameter = $entry.params | Where-Object name -eq 'Value'
    if (-not $parameter.hasDefault) { throw 'The default expression was not detected.' }
    if (-not $entry.warning) { throw 'The dynamic parameter warning was not returned.' }
    if ((Test-Path -LiteralPath $defaultMarker) -or (Test-Path -LiteralPath $dynamicMarker)) {
        throw 'The describer executed code from the inspected script.'
    }
    Write-Output 'PASS: default metadata found without running default or dynamic parameter code.'
} finally {
    foreach ($path in @($probe, $defaultMarker, $dynamicMarker)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force }
}
