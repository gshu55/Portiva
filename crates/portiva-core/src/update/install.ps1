param([string]$Source, [string]$Target, [uint32]$ParentId, [string]$Cache)
$ErrorActionPreference = 'Stop'
$backup = "$Source.bak"
try {
    $parent = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
    if ($parent) { $parent | Wait-Process -Timeout 120 -ErrorAction Stop }
    # All three files are on the same volume. File.Replace keeps the old binary on failure.
    [System.IO.File]::Replace($Source, $Target, $backup)
    try {
        Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target) -WindowStyle Normal
    }
    catch {
        [System.IO.File]::Replace($backup, $Target, [NullString]::Value)
        throw
    }
    Remove-Item -LiteralPath $backup -Force
    # Cache is an explicitly supplied per-update directory, never the application directory.
    $resolvedCache = [System.IO.Path]::GetFullPath($Cache)
    if ((Split-Path -Leaf $resolvedCache) -like 'update-*' -and
        [System.IO.Path]::GetFullPath($PSScriptRoot) -eq $resolvedCache) {
        Remove-Item -LiteralPath $resolvedCache -Recurse -Force
    }
}
catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $Cache 'install-error.txt') -Encoding UTF8
    if (Test-Path -LiteralPath $Source) { Remove-Item -LiteralPath $Source -Force }
}
