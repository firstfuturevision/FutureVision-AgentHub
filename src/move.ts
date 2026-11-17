import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * 작업을 다른 PC 로 옮기기 — 작업 폴더를 묶는 것(보내는 PC)과 푸는 것(받는 PC)의 도우미.
 * 묶기는 tar(리눅스 · 맥 · 윈도우 10 이상에 다 있음) + gzip. 폴더 안 상대 경로로만 담아 받는 PC 의 폴더 구조 · 운영체제에 맞게 풀린다.
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

/** 폴더를 tar.gz 파일로(빼는 폴더 · 고르지 않은 비밀 파일은 빼고) */
export function packFolder(folder: string, outFile: string, excludeFiles: string[]) {
  const args = ['-czf', outFile];
  for (const d of SKIP_DIRS) args.push(`--exclude=${d}`);
  for (const f of excludeFiles) args.push(`--exclude=./${f}`);
  args.push('-C', folder, '.');
  execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** 받은 tar.gz 를 폴더에 푼다(폴더 밖으로 나가는 경로는 tar 가 막는다) */
export function unpackTo(file: string, dest: string) {
  execFileSync('tar', ['-xzf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function sizeOf(p: string) { try { return statSync(p).size; } catch { return 0; } }
