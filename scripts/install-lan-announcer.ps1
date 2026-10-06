# Start the Wi-Fi play announcer (scripts/lan-announce.ts) at every Windows sign-in, hidden, and
# start it now. It lets Java players on your home network see worlds with Wi-Fi play on under
# "LAN worlds". No admin rights needed: it's a shortcut in your Startup folder.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-lan-announcer.ps1             install + start
#   powershell -ExecutionPolicy Bypass -File scripts\install-lan-announcer.ps1 -Uninstall  stop + remove

param([switch]$Uninstall)

$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\lan-announce.ts"
$shortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "WorldSmith Wi-Fi play.lnk"

# Stop a running copy first (install restarts it, uninstall stops it).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match [regex]::Escape("lan-announce.ts") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if ($Uninstall) {
  Remove-Item $shortcut -ErrorAction SilentlyContinue
  Write-Host "Wi-Fi play announcer stopped and removed from startup."
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$conhost = Join-Path $env:WINDIR "System32\conhost.exe"
$args = "--headless `"$node`" `"$script`""

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath = $conhost
$lnk.Arguments = $args
$lnk.WorkingDirectory = $repo
$lnk.WindowStyle = 7
$lnk.Description = "WorldSmith: lists Wi-Fi play worlds under LAN worlds for Java players at home"
$lnk.Save()

Start-Process -FilePath $conhost -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden
Write-Host "Wi-Fi play announcer installed ($shortcut) and running."
