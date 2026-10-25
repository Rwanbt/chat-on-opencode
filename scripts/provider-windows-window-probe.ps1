# Native, read-only enumeration except an explicit WM_CLOSE to one verified owned window.
# Only called by verify-provider-packaged-sign-in.mjs with the PID of the child it spawned.
param(
  [Parameter(Mandatory=$true)][int]$OwnerProcessId,
  [long]$CloseHandle = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProviderWindowProbe {
  private delegate bool EnumCallback(IntPtr handle, IntPtr context);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr context);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr handle, StringBuilder buffer, int capacity);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  public class WindowInfo { public long handle {get;set;} public string title {get;set;} }
  public static WindowInfo[] Enumerate(uint pid) {
    var windows = new List<WindowInfo>();
    if (!EnumWindows((handle, unused) => {
      uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner == pid && IsWindowVisible(handle)) {
        var title = new StringBuilder(512);
        GetWindowTextW(handle, title, title.Capacity);
        windows.Add(new WindowInfo { handle = handle.ToInt64(), title = title.ToString() });
      }
      return true;
    }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed");
    return windows.ToArray();
  }
}
'@
$owned = @([ProviderWindowProbe]::Enumerate([uint32]$OwnerProcessId))
if ($CloseHandle -ne 0) {
  $match = @($owned | Where-Object { $_.handle -eq $CloseHandle -and $_.title -like '*Chat On Steroids browser*' })
  if ($match.Count -ne 1) { throw 'Refusing WM_CLOSE: expected owned browser handle not found' }
  if (-not [ProviderWindowProbe]::PostMessageW([IntPtr]::new($CloseHandle), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
    throw 'PostMessage WM_CLOSE failed'
  }
}
ConvertTo-Json -InputObject @($owned) -Compress -Depth 3
