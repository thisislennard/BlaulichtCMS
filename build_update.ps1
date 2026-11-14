<#
  LifeLink Update-Paket bauen (wie LiFeOS, aber Veröffentlichen nur mit -Publish).

  .\build_update.ps1             baut UPDATES\lifelink-update-v<VERSION>.zip + .sha256 + .sig (nur lokal)
  .\build_update.ps1 -Publish    zusätzlich Git-Tag v<VERSION> pushen und GitHub-Release mit den drei Dateien anlegen

  Voraussetzungen:
  - sauberer, committeter Git-Stand (das ZIP entspricht genau HEAD)
  - LIFELINK_UPDATE_SIGNING_KEY zeigt auf den privaten Ed25519-Schlüssel (PEM, außerhalb des Repos)
  - server/update-signing-key.pub enthält den passenden öffentlichen Schlüssel
  - Node.js und npm; für -Publish die GitHub-CLI (gh, angemeldet)
#>
param(
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$msg) {
    Write-Host "  Abbruch: $msg" -ForegroundColor Red
    exit 1
}

# Native Befehle ohne PowerShell-5.1-Falle (stderr wird sonst zu NativeCommandError) ausführen
function Run([string]$exe, [string[]]$arguments, [string]$cwd = $root) {
    Push-Location $cwd
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
        Pop-Location
    }
    if ($code -ne 0) { Fail "$exe $($arguments -join ' ') ist fehlgeschlagen (Exit $code)." }
}

$version = ([System.IO.File]::ReadAllText("$root\VERSION", $utf8)).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail "Ungültige VERSION '$version'." }
$minImage = if (Test-Path "$root\MIN_IMAGE_VERSION") { ([System.IO.File]::ReadAllText("$root\MIN_IMAGE_VERSION", $utf8)).Trim() } else { $version }
$zipName = "lifelink-update-v$version.zip"
$updatesDir = Join-Path $root 'UPDATES'
$zipPath = Join-Path $updatesDir $zipName

Write-Host ''
Write-Host "  LifeLink Update-Build v$version" -ForegroundColor Cyan
Write-Host '  -----------------------------------------' -ForegroundColor DarkGray

# 1) Signatur zuerst prüfen – ohne Schlüssel entsteht kein Paket (Server lehnen unsignierte ab)
$signingKey = $env:LIFELINK_UPDATE_SIGNING_KEY
if (-not $signingKey -or -not (Test-Path -LiteralPath $signingKey -PathType Leaf)) {
    Fail "LIFELINK_UPDATE_SIGNING_KEY zeigt auf keinen privaten Schlüssel. Neu erzeugen: node tools\update-signing.mjs keygen --out <pfad> --write-public"
}
$pubLines = @(Get-Content -LiteralPath "$root\server\update-signing-key.pub" -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') })
if ($pubLines.Count -eq 0) { Fail 'server\update-signing-key.pub enthält keinen öffentlichen Schlüssel – ein Release ohne ihn würde alle weiteren Updates blockieren.' }

# 2) Nur aus sauberem, committetem Stand bauen
$dirty = git -C $root status --porcelain
if ($dirty) {
    Write-Host '  Nicht committete Änderungen:' -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Fail 'Erst committen.'
}
$commit = (git -C $root rev-parse --short HEAD).Trim()

# 3) Abhängigkeiten, Typprüfung, Build
Write-Host '  npm ci …' -ForegroundColor Gray
Run 'npm' @('ci', '--no-audit', '--no-fund')
Write-Host '  Typprüfung …' -ForegroundColor Gray
Run 'npm' @('run', 'typecheck')
Write-Host '  Build (Server + Weboberfläche) …' -ForegroundColor Gray
Run 'npm' @('run', 'build')

# 4) Paketinhalt zusammenstellen (nur was die Laufzeit braucht – keine Quellen, keine Daten, keine .env)
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "lifelink-build-$version-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    $copy = @(
        'VERSION', 'package.json', 'package-lock.json',
        'server\package.json', 'server\update-signing-key.pub',
        'web\package.json'
    )
    foreach ($f in $copy) {
        $dst = Join-Path $staging $f
        New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $f) -Destination $dst
    }
    foreach ($d in @('server\dist', 'server\migrations', 'web\dist', 'wordpress-plugin\lifelink')) {
        $src = Join-Path $root $d
        if (-not (Test-Path $src)) { Fail "$d fehlt." }
        Copy-Item -LiteralPath $src -Destination (Join-Path $staging $d) -Recurse
    }
    $notes = "LifeLink $version"
    if (Test-Path "$root\release_notes.txt") {
        $all = [System.IO.File]::ReadAllText("$root\release_notes.txt", $utf8)
        $notes = (($all -split '\r?\n---(?:\r?\n|$)')[0]).Trim()
    }
    [System.IO.File]::WriteAllText((Join-Path $staging 'release_notes.txt'), $notes, $utf8)
    $manifest = [ordered]@{ product = 'LifeLink'; version = $version; minImageVersion = $minImage; commit = $commit; builtAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $manifest, $utf8)

    # Sicherheitscheck: nichts Sensibles im Paket
    $bad = Get-ChildItem -LiteralPath $staging -Recurse -File -Force | Where-Object { $_.Name -eq '.env' -or $_.Name -like '*.pem' -or $_.Name -like '*.key' -or $_.FullName -match '\\node_modules\\' }
    if ($bad) { Fail "Sensible Dateien im Paket: $($bad.FullName -join ', ')" }

    # 5) ZIP (Einträge mit / als Trenner)
    New-Item -ItemType Directory -Force -Path $updatesDir | Out-Null
    Remove-Item -LiteralPath $zipPath, "$zipPath.sha256", "$zipPath.sig" -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
    $count = 0
    try {
        Get-ChildItem -LiteralPath $staging -Recurse -File -Force | ForEach-Object {
            $entry = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            $count++
        }
    } finally { $zip.Dispose() }
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

# 6) Prüfsumme + Signatur
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$zipPath.sha256", "$hash  $zipName", $utf8)
Run 'node' @("$root\tools\update-signing.mjs", 'sign', $zipPath, '--key', $signingKey)

Write-Host ''
Write-Host "  Erstellt:  UPDATES\$zipName ($count Dateien)" -ForegroundColor Green
Write-Host "  SHA-256:   $hash" -ForegroundColor Gray
Write-Host "  Signatur:  UPDATES\$zipName.sig" -ForegroundColor Gray
Write-Host "  Min. Image: $minImage · Commit $commit" -ForegroundColor Gray

if (-not $Publish) {
    Write-Host ''
    Write-Host '  Nicht veröffentlicht (ohne -Publish). Manuell in LifeLink unter Updates hochladen oder mit -Publish erneut ausführen.' -ForegroundColor Yellow
    exit 0
}

# 7) GitHub-Release
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh (GitHub-CLI) nicht gefunden.' }
$repoSlug = 'thisislennard/LifeLink'
$tag = "v$version"
$origin = (git -C $root remote get-url origin).Trim()
if ($origin -notmatch '(?i)github\.com[:/]thisislennard/LifeLink(\.git)?$') { Fail "origin ($origin) passt nicht zu $repoSlug." }
$head = (git -C $root rev-parse HEAD).Trim()
$prev = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
$tagCommit = git -C $root rev-parse -q --verify "refs/tags/$tag^{commit}" 2>$null
$ErrorActionPreference = $prev
if ($tagCommit) {
    if ($tagCommit.Trim() -ne $head) { Fail "Tag $tag existiert bereits und zeigt nicht auf HEAD." }
} else {
    Run 'git' @('tag', $tag)
}
Run 'git' @('push', 'origin', $tag)
$notesFile = "$zipPath.notes.md"
$fence = '```'
[System.IO.File]::WriteAllText($notesFile, "$notes`n`n### Prüfsumme (SHA-256)`n${fence}text`n$hash  $zipName`n$fence`n`nDas Paket ist mit dem LifeLink-Update-Schlüssel (Ed25519) signiert.", $utf8)
try {
    $ErrorActionPreference = 'SilentlyContinue'
    gh release view $tag --repo $repoSlug 2>$null | Out-Null
    $exists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if ($exists) { Fail "Release $tag existiert bereits – Version erhöhen." }
    Run 'gh' @('release', 'create', $tag, $zipPath, "$zipPath.sha256", "$zipPath.sig", '--repo', $repoSlug, '--title', "LifeLink $version", '--notes-file', $notesFile)
    Write-Host "  Release: https://github.com/$repoSlug/releases/tag/$tag" -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
}
