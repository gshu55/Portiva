[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$Offline,
    [switch]$Run
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot 'dist'
$outputPath = Join-Path $outputDirectory 'portiva2.exe'
$pendingPath = Join-Path $outputDirectory '.portiva2.exe.pending'

Push-Location -LiteralPath $projectRoot
try {
    # Keep the only user-facing executable separate from Cargo's build cache.
    if (Test-Path -LiteralPath $outputPath) {
        try {
            $file = [System.IO.File]::Open($outputPath, 'Open', 'ReadWrite', 'None')
            $file.Dispose()
        }
        catch {
            throw "Cannot replace $outputPath. Close Portiva 2 and retry; no alternate executable will be created. $($_.Exception.Message)"
        }
    }

    $metadataArguments = @('metadata', '--no-deps', '--format-version', '1', '--locked')
    $buildArguments = @('build', '--package', 'portiva-desktop', '--bin', 'portiva2', '--locked')
    if ($Offline) {
        $metadataArguments += '--offline'
        $buildArguments += '--offline'
    }
    if ($Configuration -eq 'Release') {
        $buildArguments += '--release'
    }

    $metadataJson = & cargo @metadataArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Cargo metadata failed; the previous executable has been preserved.'
    }
    $metadata = ($metadataJson -join "`n") | ConvertFrom-Json
    & cargo @buildArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Build failed; the previous executable has been preserved. If the Cargo executable is running, close it and retry.'
    }

    $profileDirectory = Join-Path $metadata.target_directory $Configuration.ToLowerInvariant()
    $builtPath = Join-Path $profileDirectory 'portiva2.exe'
    if (-not (Test-Path -LiteralPath $builtPath -PathType Leaf)) {
        throw "Cargo did not produce the expected executable: $builtPath"
    }

    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
    try {
        Copy-Item -LiteralPath $builtPath -Destination $pendingPath -Force
        if (Test-Path -LiteralPath $outputPath) {
            [System.IO.File]::Replace($pendingPath, $outputPath, [NullString]::Value)
        }
        else {
            [System.IO.File]::Move($pendingPath, $outputPath)
        }
    }
    finally {
        if (Test-Path -LiteralPath $pendingPath) {
            Remove-Item -LiteralPath $pendingPath -Force
        }
    }

    # Remove earlier ad hoc names only at the top of known output directories.
    # Dependency binaries, examples and application data are not build copies.
    $legacyDirectories = @(
        (Join-Path $projectRoot 'target\debug'),
        (Join-Path $projectRoot 'target\release'),
        (Join-Path $metadata.target_directory 'debug'),
        (Join-Path $metadata.target_directory 'release'),
        $outputDirectory
    ) | Select-Object -Unique
    foreach ($directory in $legacyDirectories) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            continue
        }
        $legacyFiles = Get-ChildItem -LiteralPath $directory -File | Where-Object {
            $_.BaseName -match '^portiva2[-_]' -and $_.Extension -in @('.exe', '.pdb', '.d')
        }
        foreach ($legacyFile in $legacyFiles) {
            try {
                Remove-Item -LiteralPath $legacyFile.FullName -Force
            }
            catch {
                throw "Latest executable is ready, but an old build could not be removed: $($legacyFile.FullName). Close that version and rerun this script. $($_.Exception.Message)"
            }
        }
    }

    Write-Output "Latest Portiva 2 ($Configuration): $outputPath"
    if ($Run) {
        Start-Process -FilePath $outputPath -WorkingDirectory $projectRoot
    }
}
finally {
    Pop-Location
}
