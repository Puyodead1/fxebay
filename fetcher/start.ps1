# Starts the fxebay fetcher. Right-click -> "Run with PowerShell", or: powershell -ExecutionPolicy Bypass -File start.ps1
# The token lives in .token next to this script (created on first run, gitignored).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$tokenFile = Join-Path $PSScriptRoot ".token"
if (-not (Test-Path $tokenFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
    Write-Host "Created new token in .token - give it to the worker with: npx wrangler secret put FETCHER_TOKEN"
}
$env:FETCHER_TOKEN = (Get-Content $tokenFile -Raw).Trim()

python -c "import curl_cffi" 2>$null
if ($LASTEXITCODE -ne 0) { python -m pip install -r requirements.txt }

python app.py
