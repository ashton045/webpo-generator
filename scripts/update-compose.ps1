$ErrorActionPreference = 'Stop'

if (docker compose version *> $null) {
    $composeCommand = 'docker compose'
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $composeCommand = 'docker-compose'
} else {
    throw "Neither 'docker compose' nor 'docker-compose' is available."
}

if ($env:WEBPO_IMAGE) {
    Write-Host "Pulling $env:WEBPO_IMAGE"
    Invoke-Expression "$composeCommand pull"
} else {
    Write-Host 'No WEBPO_IMAGE set; refreshing the local build from the Docker base image.'
    Invoke-Expression "$composeCommand build --pull"
}

Invoke-Expression "$composeCommand up -d --force-recreate"
Write-Host 'Done.'
