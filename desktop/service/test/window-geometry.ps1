param([Parameter(Mandatory=$true)][int]$OwnedProcessId)
# Read only the two windows belonging to the isolated acceptance executable.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MikLayoutProbe {
  public delegate bool Callback(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor,Work; public int Flags; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h, ref MonitorInfo info);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out Rect rect, int size);
}
'@
[MikLayoutProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$taskWindows=[Collections.Generic.List[object]]::new()
$taskCallback=[MikLayoutProbe+Callback]{param($handle,$data)
  [uint32]$taskId=0
  [MikLayoutProbe]::GetWindowThreadProcessId($handle,[ref]$taskId) | Out-Null
  if($taskId -ne $OwnedProcessId){return $true}
  $taskTitle=[Text.StringBuilder]::new(256)
  [MikLayoutProbe]::GetWindowText($handle,$taskTitle,256) | Out-Null
  $taskLabel=if($taskTitle.ToString().EndsWith('Chats')){'chats'}elseif($taskTitle.ToString().EndsWith('Workspace')){'workspace'}else{''}
  if(-not $taskLabel){return $true}
  $taskRect=[MikLayoutProbe+Rect]::new()
  if([MikLayoutProbe]::DwmGetWindowAttribute($handle,9,[ref]$taskRect,16) -ne 0){return $true}
  $taskMonitor=[MikLayoutProbe+MonitorInfo]::new();$taskMonitor.Size=40
  [MikLayoutProbe]::GetMonitorInfo([MikLayoutProbe]::MonitorFromWindow($handle,2),[ref]$taskMonitor) | Out-Null
  $taskWindows.Add(@{label=$taskLabel;left=$taskRect.Left;top=$taskRect.Top;right=$taskRect.Right;bottom=$taskRect.Bottom;dpi=[MikLayoutProbe]::GetDpiForWindow($handle);workLeft=$taskMonitor.Work.Left;workTop=$taskMonitor.Work.Top;workRight=$taskMonitor.Work.Right;workBottom=$taskMonitor.Work.Bottom})
  return $true
}
[MikLayoutProbe]::EnumWindows($taskCallback,[IntPtr]::Zero) | Out-Null
ConvertTo-Json -InputObject @($taskWindows.ToArray()) -Compress
