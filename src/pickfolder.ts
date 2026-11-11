import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * 운영체제 폴더 선택 창을 이 PC 화면에 띄운다(Windows 탐색기 창, macOS Finder 창, 리눅스 zenity/kdialog).
 * 이 PC 앞에서 연 화면(로컬)에서만 부른다. 원격에서 부르면 PC 앞에 창이 떠 버리므로 쓰지 않는다.
 *   { path }        고른 폴더의 절대 경로
 *   { cancel: true } 사용자가 취소
 *   { unsupported }  띄울 수 없음(화면 없음, 도구 없음) — 화면은 자체 찾아보기 창으로 넘어간다
 */
export type PickResult = { path: string } | { cancel: true } | { unsupported: string };

const TITLE = '연결할 폴더';

// Vista 이후의 탐색기형 폴더 선택 창(IFileOpenDialog + FOS_PICKFOLDERS). 옛 트리 창(FolderBrowserDialog)은 쓰지 않는다.
// 값은 명령줄이 아니라 환경 변수(AH_START)로 받는다.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AhPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(string title, string ok, string start, IntPtr owner) {
    IFileDialog d = (IFileDialog)new FileOpenDialogRCW();
    uint o; d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle(title);
    d.SetOkButtonLabel(ok);
    if (!String.IsNullOrEmpty(start)) {
      try { IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out si); d.SetFolder(si); } catch {}
    }
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // 사용자가 취소
    if (hr != 0) throw new Exception("폴더 창 오류 0x" + hr.ToString("X8"));
    IShellItem r; d.GetResult(out r);
    string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}
'@
# 브라우저 위로 뜨도록 보이지 않는 맨 위 창을 주인으로 삼는다
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
try {
  $p = [AhPicker]::Pick($env:AH_TITLE, $env:AH_OK, $env:AH_START, $owner.Handle)
} finally { $owner.Close() }
if ($p) { [Console]::Out.Write($p) }
`;

function onPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return true;
  }
  return false;
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => done({ code: -1, out, err: String(e) }));
    p.on('close', (code) => done({ code, out, err }));
  });
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

let busy = false;

export async function pickFolderNative(start?: string): Promise<PickResult | { busy: true }> {
  if (busy) return { busy: true }; // 이미 떠 있는 창이 있다
  busy = true;
  try {
    const from = start && isDir(start) ? start : '';
    if (process.platform === 'win32') {
      const enc = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { AH_TITLE: TITLE, AH_OK: '연결', AH_START: from });
      if (r.code !== 0) return { unsupported: (r.err.trim().split('\n')[0] || `powershell ${r.code}`).slice(0, 200) };
      const p = r.out.trim();
      return p ? { path: p } : { cancel: true };
    }
    if (process.platform === 'darwin') {
      const script = ['on run argv', 'if (count of argv) > 0 then', `return POSIX path of (choose folder with prompt "${TITLE}" default location (POSIX file (item 1 of argv)))`, 'end if', `return POSIX path of (choose folder with prompt "${TITLE}")`, 'end run'];
      const r = await run('osascript', [...script.flatMap((l) => ['-e', l]), ...(from ? [from] : [])]);
      if (r.code === 0 && r.out.trim()) return { path: r.out.trim().replace(/\/$/, '') || '/' };
      if (/-128/.test(r.err)) return { cancel: true }; // 사용자가 취소
      return { unsupported: r.err.trim().slice(0, 200) || 'osascript 실패' };
    }
    // 리눅스: 화면이 있어야 한다
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { unsupported: '화면 없음' };
    let r;
    if (onPath('zenity')) r = await run('zenity', ['--file-selection', '--directory', `--title=${TITLE}`, ...(from ? [`--filename=${from}/`] : [])]);
    else if (onPath('kdialog')) r = await run('kdialog', ['--getexistingdirectory', from || process.env.HOME || '/', '--title', TITLE]);
    else return { unsupported: 'zenity·kdialog 없음' };
    if (r.code === 0 && r.out.trim()) return { path: r.out.trim() };
    if (r.code === 1) return { cancel: true };
    return { unsupported: r.err.trim().slice(0, 200) || '폴더 창 실패' };
  } finally {
    busy = false;
  }
}
