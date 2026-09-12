# Windows bootstrap. No Git, .env, or administrator shell required when Node is installed.
[CmdletBinding()]
param([string]$ArchiveUrl = 'https://github.com/jonax1337/rookery-agent/archive/refs/heads/main.zip')
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 22.5 or newer from https://nodejs.org, then run this command again.'
    }
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed.' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.5 or newer is required. Update Node.js and try again.' }
$installTemp = Join-Path ([IO.Path]::GetTempPath()) ('rookery-install-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $installTemp | Out-Null
try {
    Write-Host 'Downloading Rookery...'
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile (Join-Path $installTemp 'source.zip')
    Expand-Archive -LiteralPath (Join-Path $installTemp 'source.zip') -DestinationPath $installTemp
    $source = @(Get-ChildItem -LiteralPath $installTemp -Directory)
    if ($source.Count -ne 1) { throw 'Expected one source directory in the archive.' }
    Push-Location $source[0].FullName
    try {
        npm.cmd ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        npm.cmd run package
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
        $package = @(Get-ChildItem -LiteralPath 'dist' -Filter '*.tgz')
        if ($package.Count -ne 1) { throw 'Expected one release package.' }
        npm.cmd install --global --ignore-scripts $package[0].FullName
        if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
        $prefix = (npm.cmd prefix --global).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the installed package.' }
        $env:Path = $prefix + ';' + $env:Path
        if (-not (Get-Command codex -ErrorAction SilentlyContinue) -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
            $choice = Read-Host 'Install a provider: [1] Codex (ChatGPT), [2] Claude Code, [3] Later (default: 1)'
            if ($choice -eq '' -or $choice -eq '1' -or $choice -eq '2') {
                $provider = if ($choice -eq '2') { 'claude' } else { 'codex' }
                $providerPackage = if ($provider -eq 'claude') { '@anthropic-ai/claude-code' } else { '@openai/codex' }
                npm.cmd install --global --ignore-scripts $providerPackage
                if ($LASTEXITCODE -ne 0) { throw 'Provider installation failed. You can retry separately, then run rookery setup.' }
                if ($provider -eq 'claude') { & (Join-Path $prefix 'claude.cmd') auth login }
                else { & (Join-Path $prefix 'codex.cmd') login }
                if ($LASTEXITCODE -ne 0) { Write-Warning 'Login was not completed. Finish provider login before chatting.' }
                $rookeryData = if ($env:ROOKERY_HOME) { $env:ROOKERY_HOME } else { Join-Path $env:USERPROFILE '.rookery' }
                if (-not (Test-Path -LiteralPath (Join-Path $rookeryData 'config.json'))) {
                    & (Join-Path $prefix 'rookery.cmd') config set defaultProvider $provider
                    if ($LASTEXITCODE -ne 0) { throw 'Could not save the selected provider.' }
                }
            } elseif ($choice -ne '3') {
                Write-Warning 'Unknown selection. Skipping provider installation; choose a provider in Settings after installing its CLI.'
            }
        }
        & (Join-Path $prefix 'rookery.cmd') setup
        if ($LASTEXITCODE -ne 0) { throw 'Setup failed. Run rookery setup to retry.' }
    } finally { Pop-Location }
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath($installTemp)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTemp -Leaf).StartsWith('rookery-install-')) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
