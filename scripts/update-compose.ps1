$ErrorActionPreference = 'Stop'

if (docker compose version *> $null) {
    $composeCommand = 'docker compose'
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $composeCommand = 'docker-compose'
} else {
    throw "Neither 'docker compose' nor 'docker-compose' is available."
}

Write-Host "Pulling ghcr.io/your-user/webpo-generator:latest"
Invoke-Expression "$composeCommand pull"

Invoke-Expression "$composeCommand up -d --force-recreate"
Write-Host 'Done.'
