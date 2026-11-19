import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, mkdirSync, createReadStream, createWriteStream, utimesSync } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { join, relative, sep, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * 작업을 다른 PC 로 옮기기 — 작업 폴더를 묶는 것(보내는 PC)과 푸는 것(받는 PC)의 도우미.
 * 묶기는 Node 로 직접(AHPK1 · gzip, 이름은 UTF-8). 폴더 안 상대 경로로만 담아 받는 PC 의 폴더 구조 · 운영체제에 맞게 풀린다.
 * git 저장소는 .git 까지 그대로 담아 커밋 안 된 변경도 같이 간다.
 */

/** 옮기지 않는 큰 것 · 다시 만들 수 있는 것(받는 PC 에서 설치 명령으로 다시 만든다) */
export const SKIP_DIRS = ['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'target', '.gradle', 'Library', 'Temp', 'obj', 'coverage'];
/** 비밀일 수 있는 파일(이름만 보이고, 옮길지 사람이 고른다) */
const SECRET_RE = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|.*secret.*|.*token.*|\.npmrc|\.pypirc|\.netrc)$/i;
const SECRET_OK = /^\.env\.(example|sample|template)$/i;

export interface MovePlan {
  folder: string; // 이 PC 작업 폴더
  own: boolean; // 이 작업만 쓰는 폴더인가(아니면 폴더는 옮기지 않고 대화 · 첨부만)
  why?: string; // own 이 아닌 까닭
  files: number;
  bytes: number;
  git: boolean;
  skipped: string[]; // 빼는 폴더(상대 경로)
  secrets: string[]; // 비밀일 수 있는 파일(상대 경로) — 내용은 읽지 않는다
  setup: string[]; // 받는 PC 에서 돌릴 설치 명령
  cannot: string[]; // 옮길 수 없는 것 — 받는 PC 에서 할 일
}

/** 폴더를 훑어 크기 · 뺄 것 · 비밀 파일을 센다(심볼릭 링크는 따라가지 않음) */
export function scanFolder(folder: string, limit = 200_000): Pick<MovePlan, 'files' | 'bytes' | 'skipped' | 'secrets' | 'git'> {
  let files = 0, bytes = 0;
  const skipped: string[] = [], secrets: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (files > limit) return;
      const p = join(dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      const rel = relative(folder, p).split(sep).join('/');
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.includes(n)) { skipped.push(rel); continue; }
        walk(p);
      } else if (st.isFile()) {
        if (SECRET_RE.test(n) && !SECRET_OK.test(n) && !rel.startsWith('.git/')) secrets.push(rel);
        files++;
        bytes += st.size;
      }
    }
  };
  walk(folder);
  return { files, bytes, skipped, secrets, git: existsSync(join(folder, '.git')) };
}

/** 받는 PC 에서 다시 세팅할 명령(폴더 맨 위의 파일로 짐작) */
export function setupCommands(folder: string, win = process.platform === 'win32'): string[] {
  const has = (f: string) => existsSync(join(folder, f));
  const out: string[] = [];
  if (has('package.json')) out.push(has('pnpm-lock.yaml') ? 'pnpm install' : has('yarn.lock') ? 'yarn install' : has('package-lock.json') ? 'npm ci' : 'npm install');
  if (has('requirements.txt')) out.push(win ? 'python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt' : 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
  else if (has('pyproject.toml') && has('uv.lock')) out.push('uv sync');
  return out;
}

/** 옮길 수 없는 것: 이 폴더를 쓰는 사용자 systemd 서비스, 폴더 안 cloudflared 설정 등 — 받는 PC 에서 할 일로 남긴다 */
export function cannotMove(folder: string, text: string, home = homedir()): string[] {
  const out: string[] = [];
  const unitDir = join(home, '.config', 'systemd', 'user');
  try {
    for (const f of readdirSync(unitDir)) {
      if (!f.endsWith('.service')) continue;
      const body = readFileSync(join(unitDir, f), 'utf8');
      if (body.includes(folder)) out.push(`systemd 서비스 ${f} — 받는 PC 에서 다시 만들어 켠다`);
    }
  } catch {}
  if (existsSync(join(folder, '.cloudflared')) || /trycloudflare\.com|cloudflared/.test(text)) out.push('cloudflared 임시 주소 — 받는 PC 에서 다시 띄우면 주소가 바뀐다');
  const ports = [...new Set([...text.matchAll(/(?:localhost|127\.0\.0\.1):(\d{4,5})/g)].map((m) => m[1]))].slice(0, 6);
  if (ports.length) out.push(`이 PC 에서 띄운 서버 포트(${ports.join(', ')}) — 받는 PC 에서 다시 띄운다`);
  out.push('이 PC 에만 있는 로그인(Chrome 프로필 · CLI 로그인 · 토큰 파일) — 받는 PC 에서 다시 로그인');
  return out;
}

/**
 * 묶음 형식(AHPK1): gzip 안에 [이름 길이 4B][이름 UTF-8][종류 1B: 0 파일 · 1 폴더][크기 8B][mtime 8B][내용] 이 이어진다.
 * 시스템 tar 를 쓰지 않는 까닭: 윈도우 tar(bsdtar)가 리눅스 GNU tar 가 만든 한글 경로(첨부/…)를 지역 문자셋으로 읽어
 * "Invalid empty pathname" 으로 풀기에 실패했다. 이름은 늘 UTF-8 로 담고, 풀 때 그 PC 에서 못 쓰는 이름은 바꿔 푼다.
 */
const MAGIC = Buffer.from('AHPK1\n');
const WIN_BAD = /[<>:"|?*\x00-\x1f]/g;

/** 그 PC 에서 쓸 수 있는 이름으로(윈도우: 못 쓰는 글자 → _, 끝 점 · 빈칸 → _, 예약 이름 앞에 _) */
export function safeName(seg: string, win = process.platform === 'win32'): string {
  if (!win) return seg;
  let s = seg.replace(WIN_BAD, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s || '_';
}

function writeAll(out: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  return new Promise((res) => { if (out.write(buf)) res(); else out.once('drain', () => res()); });
}

function header(rel: string, kind: 0 | 1, size: number, mtime: number): Buffer {
  const name = Buffer.from(rel, 'utf8');
  const h = Buffer.alloc(4 + name.length + 1 + 8 + 8);
  h.writeUInt32BE(name.length, 0);
  name.copy(h, 4);
  h.writeUInt8(kind, 4 + name.length);
  h.writeBigUInt64BE(BigInt(size), 5 + name.length);
  h.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(mtime))), 13 + name.length);
  return h;
}

/** 파일 목록(폴더 기준 상대 경로, / 구분)을 묶음 파일로 */
async function packList(folder: string, outFile: string, rels: string[]) {
  const gz = createGzip({ level: 6 });
  const file = createWriteStream(outFile);
  const done = new Promise<void>((res, rej) => { file.on('finish', () => res()); file.on('error', rej); gz.on('error', rej); });
  gz.pipe(file);
  await writeAll(gz, MAGIC);
  for (const rel of rels) {
    const abs = join(folder, ...rel.split('/'));
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isDirectory()) { await writeAll(gz, header(rel, 1, 0, st.mtimeMs)); continue; }
    if (!st.isFile()) continue;
    await writeAll(gz, header(rel, 0, st.size, st.mtimeMs));
    let left = st.size;
    for await (const chunk of createReadStream(abs)) {
      const c = chunk as Buffer;
      const part = c.length > left ? c.subarray(0, left) : c; // 묶는 사이 커진 파일은 처음 잰 크기까지만
      left -= part.length;
      await writeAll(gz, part);
      if (left <= 0) break;
    }
    if (left > 0) await writeAll(gz, Buffer.alloc(left)); // 묶는 사이 줄어든 파일은 0 으로 채워 묶음이 어긋나지 않게
  }
  gz.end();
  await done;
}

/** 폴더 전체를 묶음으로(빼는 폴더 · 고르지 않은 비밀 파일 · 심볼릭 링크는 빼고). 빼는 폴더는 어느 깊이든 */
export async function packFolder(folder: string, outFile: string, excludeFiles: string[]) {
  const skip = new Set(excludeFiles);
  const rels: string[] = [];
  const walk = (dir: string, pre: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const rel = pre ? `${pre}/${n}` : n;
      let st;
      try { st = lstatSync(join(dir, n)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.includes(n)) continue;
        rels.push(rel);
        walk(join(dir, n), rel);
      } else if (st.isFile() && !skip.has(rel)) rels.push(rel);
    }
  };
  walk(folder, '');
  await packList(folder, outFile, rels);
}

/** 고른 파일만 묶음으로(여러 작업이 함께 쓰는 폴더면 그 작업 첨부만) */
export async function packFiles(folder: string, outFile: string, files: string[]) {
  const rels = new Set<string>();
  for (const f of files) {
    const parts = f.split(/[\\/]/).filter(Boolean);
    for (let i = 1; i < parts.length; i++) rels.add(parts.slice(0, i).join('/'));
    rels.add(parts.join('/'));
  }
  await packList(folder, outFile, [...rels]);
}

/** 받은 묶음을 폴더에 푼다. 폴더 밖으로 나가는 이름은 버리고, 그 PC 에서 못 쓰는 이름은 바꿔 푼다. 예전 PC 가 보낸 tar.gz 도 푼다 */
export async function unpackTo(file: string, dest: string, win = process.platform === 'win32'): Promise<{ renamed: string[] }> {
  const gun = createReadStream(file).pipe(createGunzip());
  const it = gun[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let ended = false;
  const need = async (n: number) => {
    while (buf.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else buf = buf.length ? Buffer.concat([buf, r.value as Buffer]) : (r.value as Buffer);
    }
    return buf.length >= n;
  };
  const take = (n: number) => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };
  if (!(await need(MAGIC.length)) || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    gun.destroy();
    execFileSync('tar', ['-xzf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] }); // 예전 형식
    return { renamed: [] };
  }
  take(MAGIC.length);
  const renamed: string[] = [];
  const root = resolve(dest);
  while (await need(4)) {
    const len = buf.readUInt32BE(0);
    if (!(await need(4 + len + 17))) throw new Error('묶음이 중간에 끊김');
    take(4);
    const rel = take(len).toString('utf8');
    const kind = take(1).readUInt8(0);
    const size = Number(take(8).readBigUInt64BE(0));
    const mtime = Number(take(8).readBigUInt64BE(0));
    const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..');
    const safe = parts.map((p) => safeName(p, win));
    if (safe.join('/') !== parts.join('/')) renamed.push(rel);
    const abs = resolve(root, ...safe);
    const inside = parts.length > 0 && (abs === root || abs.startsWith(root + sep));
    if (kind === 1) { if (inside) mkdirSync(abs, { recursive: true }); continue; }
    let out: ReturnType<typeof createWriteStream> | null = null;
    if (inside) { mkdirSync(dirname(abs), { recursive: true }); out = createWriteStream(abs); }
    let left = size;
    while (left > 0) {
      if (!buf.length && !(await need(1))) throw new Error('묶음이 중간에 끊김');
      const part = take(Math.min(left, buf.length));
      left -= part.length;
      if (out) await writeAll(out, part);
    }
    if (out) {
      await new Promise<void>((res, rej) => { out!.end(() => res()); out!.on('error', rej); });
      try { const d = new Date(mtime); utimesSync(abs, d, d); } catch {}
    }
  }
  return { renamed };
}

export function sizeOf(p: string) { try { return statSync(p).size; } catch { return 0; } }
