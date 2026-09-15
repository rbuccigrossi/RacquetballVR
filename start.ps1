param([string]$NodePath)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) {
    $candidate = Get-Command node -ErrorAction SilentlyContinue
    if ($candidate) {
        $major = & $candidate.Source -p 'process.versions.node.split(".")[0]'
        if ([int]$major -ge 22) { $NodePath = $candidate.Source }
    }
}
if (-not $NodePath) {
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) { $NodePath = $bundled }
}
if (-not $NodePath) { throw 'Install Node.js 22 or newer, or pass -NodePath to its executable.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'server\node_modules\three'))) {
    throw 'Dependencies are missing. With Node.js 22+, run: cd server; npm ci'
}
& $NodePath (Join-Path $PSScriptRoot 'server\server.js')
exit $LASTEXITCODE
