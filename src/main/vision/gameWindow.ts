import { execFile } from 'node:child_process'

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where Hearthstone's window is on the desktop.
 *
 * Shelled out to PowerShell for GetWindowRect, in the same spirit as the
 * existing `reg.exe` and `tasklist` calls — no native module for one number.
 * The client area is used rather than the window rect so a title bar in
 * windowed mode doesn't shift everything down.
 */
const SCRIPT = `
Add-Type @'
using System;using System.Runtime.InteropServices;
public class W{
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
 public struct R{public int L,T,Rr,B;}
 public struct P{public int X,Y;}
}
'@
$p = Get-Process Hearthstone -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'none'; exit }
$h = $p.MainWindowHandle
$r = New-Object W+R; [void][W]::GetClientRect($h, [ref]$r)
$o = New-Object W+P; [void][W]::ClientToScreen($h, [ref]$o)
Write-Output "$($o.X) $($o.Y) $($r.Rr) $($r.B)"
`

export function getGameWindowRect(): Promise<WindowRect | undefined> {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(undefined)
      const m = stdout.trim().match(/^(-?\d+) (-?\d+) (\d+) (\d+)$/m)
      if (!m) return resolve(undefined)
      const [, x, y, width, height] = m
      const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
      resolve(rect.width > 0 && rect.height > 0 ? rect : undefined)
    })
  })
}
