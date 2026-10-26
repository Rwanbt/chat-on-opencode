# Read/close only the OpenCode GUI HWND owned by the EXACT disposable
# process launched by the official Windows Desktop acceptance test.
param(
  [Parameter(Mandatory=$true)][int]$OwnerProcessId,
  [switch]$CloseOwnedWindow
)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $OwnerProcessId -ErrorAction Stop
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) {
  if ($CloseOwnedWindow) { throw 'official_desktop_owned_window_missing' }
  Write-Output 'NO_WINDOW'
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OfficialDesktopWindowProbe {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool PostMessageW(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
}
'@
[uint32]$owner = 0
[void][OfficialDesktopWindowProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
if ($owner -ne $OwnerProcessId) { throw 'official_desktop_foreign_window_owner' }
if (-not [OfficialDesktopWindowProbe]::IsWindowVisible($handle)) {
  throw 'official_desktop_window_not_visible'
}
if ($process.MainWindowTitle -notlike 'OpenCode*') {
  throw 'official_desktop_window_unexpected_title'
}
if ($CloseOwnedWindow) {
  if (-not [OfficialDesktopWindowProbe]::PostMessageW(
    $handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'official_desktop_owned_wm_close_failed'
  }
  Write-Output 'OWNED_WM_CLOSE_SENT'
} else {
  Write-Output 'OWNED_OPEN_CODE_WINDOW_VISIBLE'
}
