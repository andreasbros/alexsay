# Installs the alexsay speaker on Windows: irm https://alexsay.com/install.ps1 | iex
$ErrorActionPreference = "Stop"
$repo = if ($env:ALEXSAY_REPO) { $env:ALEXSAY_REPO } else { "andreasbros/alexsay" }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "alexsay: only x64 Windows has a build yet"
}
$asset = "alexsay-x86_64-pc-windows-msvc.zip"
$base = "https://github.com/$repo/releases/latest/download"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("alexsay-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
Write-Host "Downloading $asset..."
Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset)
Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")
$expected = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" }) -split "\s+" | Select-Object -First 1
$actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "checksum mismatch for $asset" }
$dir = Join-Path $env:LOCALAPPDATA "alexsay\bin"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $dir -Force
Remove-Item -Recurse -Force $tmp
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if (($path -split ";") -notcontains $dir) {
  [Environment]::SetEnvironmentVariable("Path", "$path;$dir", "User")
  Write-Host "Added $dir to your PATH (open a new terminal)"
}
Write-Host "Installed $dir\alexsay.exe"
Write-Host ""
Write-Host "Next:  alexsay setup            (shows the id to add in the app, checks the audio)"
Write-Host "       alexsay run              (start listening; Ctrl-C stops)"
Write-Host "       alexsay service install  (run at logon)"
