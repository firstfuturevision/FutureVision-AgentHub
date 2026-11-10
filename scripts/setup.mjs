// Agent Hub 시작 설정 — 운영체제에 맞는 시작 아이콘과 "로그인하면 자동 시작"을 만든다(관리자 권한 없이 이 사용자만).
//   npm run setup               만들기
//   npm run setup -- --remove   지우기
//
//   Windows : 바탕화면·시작 메뉴 바로가기 "Agent Hub", 시작프로그램 바로가기(창 없이 뒤에서)
//   macOS   : 바탕화면 "Agent Hub.command", ~/Library/LaunchAgents 의 LaunchAgent
//   리눅스  : 앱 목록 아이콘(~/.local/share/applications), 바탕화면 아이콘, ~/.config/autostart
// 아이콘을 누르면 꺼져 있을 때만 뒤에서 켜고, 브라우저로 화면을 연다.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.firstfuturevision.agenthub';

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// .desktop 의 Exec: 인자마다 큰따옴표, 그 안의 " ` $ \ 는 역슬래시로
const deskArg = (s) => `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 만들 파일 목록(macOS·리눅스). Windows 는 바로가기라 windowsScript 로 */
export function plan({ platform = process.platform, home = homedir(), root = ROOT, node = process.execPath } = {}) {
  if (platform === 'win32') return [];
  const join = posix.join; // 맥·리눅스 경로
  const launch = join(root, 'scripts', 'launch.mjs');
  if (platform === 'darwin') {
    const log = join(root, 'data', 'logs', 'hub.log');
    return [
      {
        path: join(home, 'Desktop', 'Agent Hub.command'),
        mode: 0o755,
        content: `#!/bin/sh\n# Agent Hub — 꺼져 있으면 뒤에서 켜고 브라우저로 연다\nexec ${sh(node)} ${sh(launch)} --background --open\n`,
      },
      {
        path: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(launch)}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
      },
    ];
  }
  // 리눅스(Ubuntu 등): freedesktop 표준 .desktop
  const entry = (exec, extra = '') => `[Desktop Entry]
Type=Application
Name=Agent Hub
Comment=Claude·Codex·Gemini 에이전트 호스트
Exec=${exec}
Path=${root}
Terminal=false
Categories=Development;
${extra}`;
  const open = `${deskArg(node)} ${deskArg(launch)} --background --open`;
  return [
    { path: join(home, '.local', 'share', 'applications', 'agent-hub.desktop'), mode: 0o755, content: entry(open) },
    ...(existsSync(join(home, 'Desktop')) ? [{ path: join(home, 'Desktop', 'agent-hub.desktop'), mode: 0o755, content: entry(open) }] : []),
    { path: join(home, '.config', 'autostart', 'agent-hub.desktop'), content: entry(`${deskArg(node)} ${deskArg(launch)} --background`, 'X-GNOME-Autostart-enabled=true\n') },
  ];
}

/**
 * Windows 바로가기 만들기·지우기 PowerShell. 값은 환경 변수로만 넘긴다(따옴표 주입 없음).
 * AH_DESKTOP·AH_PROGRAMS·AH_STARTUP 이 있으면 그 폴더에(시험용).
 */
export function windowsScript(remove = false) {
  return `$ErrorActionPreference = 'Stop'
function Get-AhFolder($over, $name) { if ($over) { $over } else { [Environment]::GetFolderPath($name) } }
$dirs = @((Get-AhFolder $env:AH_DESKTOP 'Desktop'), (Get-AhFolder $env:AH_PROGRAMS 'Programs'), (Get-AhFolder $env:AH_STARTUP 'Startup'))
${remove ? `foreach ($d in $dirs) { $p = Join-Path $d 'Agent Hub.lnk'; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $p } }` : `$sh = New-Object -ComObject WScript.Shell
$launch = '"' + (Join-Path $env:AH_ROOT 'scripts\\launch.mjs') + '"'
for ($i = 0; $i -lt 3; $i++) {
  $p = Join-Path $dirs[$i] 'Agent Hub.lnk'
  $l = $sh.CreateShortcut($p)
  $l.TargetPath = $env:AH_NODE
  $l.Arguments = if ($i -eq 2) { "$launch --background" } else { "$launch --background --open" }
  $l.WorkingDirectory = $env:AH_ROOT
  $l.WindowStyle = 7
  $l.Description = 'Agent Hub'
  $l.Save()
  $p
}`}
`;
}

export function runWindows({ remove = false, root = ROOT, node = process.execPath, env = {} } = {}) {
  const encoded = Buffer.from(windowsScript(remove), 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, AH_ROOT: root, AH_NODE: node, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function apply(files) {
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    if (f.mode) chmodSync(f.path, f.mode);
  }
  return files.map((f) => f.path);
}

export function removeFiles(files) {
  const gone = [];
  for (const f of files) if (existsSync(f.path)) { rmSync(f.path, { force: true }); gone.push(f.path); }
  return gone;
}

// npm run setup 으로 바로 실행했을 때
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const remove = process.argv.includes('--remove');
  let paths;
  if (process.platform === 'win32') paths = runWindows({ remove });
  else {
    const files = plan();
    paths = remove ? removeFiles(files) : apply(files);
    // macOS 는 Gatekeeper 가 .command 를 막지 않도록 격리 표시를 지운다(없으면 무시)
    if (process.platform === 'darwin' && !remove) try { execFileSync('xattr', ['-d', 'com.apple.quarantine', files[0].path], { stdio: 'ignore' }); } catch {}
  }
  if (!paths.length) console.log(remove ? '지울 것이 없음' : '만든 것이 없음');
  for (const p of paths) console.log(`${remove ? '지움' : '만듦'}: ${p}`);
  if (!remove) {
    console.log('\n아이콘 "Agent Hub" 를 누르면 켜지고 브라우저가 열립니다. 다음 로그인부터는 저절로 켜집니다.');
    if (process.platform === 'linux') console.log('바탕화면 아이콘은 처음 한 번 오른쪽 클릭 → "실행 허용" 이 필요할 수 있습니다.');
    console.log('끄기: npm run stop');
  }
}
