param(
  [Parameter(Mandatory = $true)]
  [string]$AuthRoot,
  [string]$Destination = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$paths = @(
  'app/[locale]/(dashboard)/modulo/reservas',
  'app/api/reservas',
  'app/api/cron/reservas/reminders',
  'lib/modules/reservas',
  'lib/automation/engine.ts',
  'lib/automation/ai-flow-router.ts',
  'lib/automation/template-validation.ts',
  'lib/modules/ai-router/intent-router.ts',
  'lib/morf-ai/providers/sales-policy.ts',
  'lib/morf-ai/runtime/generate.ts',
  'migrations/20260603_reservas_ia_optional.sql',
  'migrations/20260824_auto_calendar_hardening.sql'
)

foreach ($relativePath in $paths) {
  $source = Join-Path $AuthRoot $relativePath
  $target = Join-Path $Destination $relativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "No existe en Auth: $source"
  }
  $targetParent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

Write-Host "Auto Calendario sincronizado desde $AuthRoot"
Write-Host 'Este script no ejecuta migraciones, no toca .env y no despliega.'
