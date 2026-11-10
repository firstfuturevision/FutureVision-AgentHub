import { readdirSync, mkdirSync, statSync, existsSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * 작업 폴더 — 새 작업마다 workspaceRoot 바로 아래 폴더 하나를 고른다.
 * 목록은 한 단계만 보여 주고, 새 폴더도 뿌리 바로 아래에만 만든다(경로 탈출 불가).
 */
export interface Folder { name: string; path: string } // name '' = 뿌리

export function listFolders(root: string): Folder[] {
  const out: Folder[] = [{ name: '', path: root }];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names.sort((a, b) => a.localeCompare(b, 'ko'))) {
    if (name.startsWith('.')) continue;
    const p = join(root, name);
    try {
      if (statSync(p).isDirectory()) out.push({ name, path: p });
    } catch {}
  }
  return out;
}

/**
 * 폴더 찾아보기 — 작업에 연결할 폴더를 고르는 창에 쓴다(PC 앞 화면에서만). 폴더만, 숨김 폴더는 빼고.
 * roots: Windows 는 있는 드라이브들, 그 밖은 '/'
 */
export interface Browse { path: string; parent: string | null; dirs: Folder[]; roots: string[]; home: string }
export function browseFolders(raw?: string): Browse {
  const home = homedir();
  const path = resolve(raw && raw.trim() ? raw.trim() : home);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`없는 폴더: ${path}`);
  const dirs: Folder[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new Error(`열 수 없는 폴더(권한): ${path}`);
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$') || /^(System Volume Information|node_modules)$/i.test(e.name)) continue;
    dirs.push({ name: e.name, path: join(path, e.name) });
  }
  const roots = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => existsSync(d))
    : ['/'];
  const up = dirname(path);
  return { path, parent: up === path ? null : up, dirs, roots, home };
}

/** 폴더 이름: 경로 구분자·상위 이동·윈도우 금지 문자 없이, 앞뒤 공백·점 없이 */
const BAD = /[\\/:*?"<>|\x00-\x1f]/;
export function createFolder(root: string, raw: unknown): Folder {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 60) throw new Error('폴더 이름은 1~60자');
  if (BAD.test(name) || name === '.' || name === '..' || name.startsWith('.') || name.endsWith('.')) throw new Error(`쓸 수 없는 폴더 이름: ${name}`);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) throw new Error(`윈도우에서 쓸 수 없는 이름: ${name}`);
  const p = join(root, name);
  if (existsSync(p)) throw new Error(`이미 있는 폴더: ${name}`);
  mkdirSync(p);
  return { name, path: p };
}
