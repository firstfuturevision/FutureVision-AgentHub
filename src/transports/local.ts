import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parseCommand } from '../protocol.ts';
import { handleMcp } from '../mcp.ts';
import type { PresetStore } from '../presets.ts';
import type { ToolStore } from '../tools.ts';
import type { AuthStore } from '../auth.ts';
import type { GitHub } from '../github.ts';
import { installCommand } from '../install.ts';
import type { Updater } from '../update.ts';
import type { HubSkillStore } from '../hubskills.ts';
import type { WorkPresetStore } from '../workpresets.ts';
import type { ScheduleStore } from '../schedules.ts';
import { SHARED_KINDS, type SharedRepo, type SharedKind } from '../shared.ts';
import { listFolders, createFolder, browseFolders } from '../folders.ts';
import { pickFolderNative } from '../pickfolder.ts';
import type { SessionManager } from '../sessions.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const STATIC = new Set(['/index.html', '/app.js', '/md.js', '/style.css']);

/**
 * 공용 PC 앞 "직접 작업" 화면. 127.0.0.1 에만 열린다.
 * 화면 → 호스트: POST /cmd (JSON), 호스트 → 화면: GET /events (SSE)
 */
export function startLocalServer(opts: { port: number; uiDir: string; sessions: SessionManager; info: Record<string, unknown>; presets?: PresetStore; tools?: ToolStore; auth?: AuthStore; github?: GitHub; updater?: Updater; openInstall?: (title: string, command: string) => Promise<void>; clis?: () => Record<string, { installed: boolean; missing: string[] }>; hubSkills?: HubSkillStore; workPresets?: WorkPresetStore; schedules?: ScheduleStore; shared?: SharedRepo }): Promise<Server> {
  const { port, uiDir, sessions, info, presets, tools, auth, github, updater, openInstall, clis, hubSkills, workPresets, schedules, shared } = opts;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    // DNS 리바인딩·다른 사이트의 요청 차단: Host 와 Origin 이 이 서버여야 한다.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, '허용되지 않은 Host');
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, '허용되지 않은 Origin');

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/events') return events(req, res, sessions);
      if (req.method === 'GET' && url.pathname === '/info') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(info));
      }
      if (req.method === 'POST' && url.pathname === '/cmd') return await command(req, res, sessions);
      if (url.pathname.startsWith('/mcp/')) return await mcp(req, res, sessions, url.pathname.slice(5));
      // 첨부 업로드: 본문 = 파일 그대로, x-file-name 헤더 = 파일 이름(encodeURIComponent).
      // 사용자 정의 헤더가 있어 다른 사이트의 요청은 브라우저 사전 확인에서 막힌다.
      if (req.method === 'POST' && url.pathname === '/attach') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const rawName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        if (!req.headers['x-file-name']) return send(res, 400, 'x-file-name 헤더 필요');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 50 * 1024 * 1024) return send(res, 413, '파일이 너무 큼(최대 50MB)');
          chunks.push(c);
        }
        try {
          return json(res, 200, sessions.saveAttachment(sessionId, rawName, String(req.headers['content-type'] ?? ''), Buffer.concat(chunks)));
        } catch (err) {
          return send(res, 400, (err as Error).message);
        }
      }
      // 작업 폴더 — 새 작업마다 고른다(뿌리 바로 아래). 새 폴더도 여기서 만든다.
      if (url.pathname === '/folders' && typeof info.workspaceRoot === 'string') {
        const root = info.workspaceRoot;
        if (req.method === 'GET') return json(res, 200, listFolders(root));
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            createFolder(root, body?.name);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, listFolders(root));
        }
      }
      // 폴더 찾아보기 — 연결할 폴더를 고르는 창(폴더 이름만, 파일은 안 보임)
      if (req.method === 'GET' && url.pathname === '/browse') {
        try {
          return json(res, 200, browseFolders(url.searchParams.get('path') ?? undefined));
        } catch (err) {
          return send(res, 400, (err as Error).message);
        }
      }
      // 운영체제 폴더 선택 창(탐색기·Finder) — 이 PC 화면에 뜬다. 못 띄우면 화면이 자체 찾아보기 창을 쓴다
      if (req.method === 'POST' && url.pathname === '/pick-folder') {
        const body = (await readJson(req, res)) as any;
        if (res.writableEnded) return;
        const start = typeof body?.start === 'string' ? body.start : undefined;
        return json(res, 200, await pickFolderNative(start));
      }
      // 세션 지침: 그 CLI 가 읽는 스킬 목록(보기 전용)
      if (req.method === 'GET' && url.pathname === '/skills') {
        const id = url.searchParams.get('sessionId') ?? '';
        if (!sessions.info(id)) return send(res, 404, '없는 세션');
        return json(res, 200, sessions.skillsOf(id));
      }
      // 예약 — 작업마다 정한 시각에 지시를 보낸다
      if (url.pathname === '/schedules' && schedules) {
        if (req.method === 'GET') return json(res, 200, schedules.forSession(url.searchParams.get('sessionId') ?? ''));
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          const s = sessions.info(String(body?.sessionId ?? ''));
          if (!s) return send(res, 404, '없는 작업');
          if (s.role === 'worker') return send(res, 400, '하위 에이전트에는 예약을 걸 수 없음');
          try {
            schedules.save(body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          sessions.schedulesChanged();
          return json(res, 200, schedules.forSession(s.id));
        }
        if (req.method === 'DELETE') {
          schedules.remove(url.searchParams.get('id') ?? '');
          sessions.schedulesChanged();
          return json(res, 200, schedules.forSession(url.searchParams.get('sessionId') ?? ''));
        }
      }
      // 프리셋(작업 환경) — 폴더·지침
      if (url.pathname === '/work-presets' && workPresets) {
        if (req.method === 'GET') return json(res, 200, workPresets.list());
        if (req.method === 'POST') {
          const body = await readJson(req, res);
          if (body === undefined) return;
          try {
            workPresets.save(body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, workPresets.list());
        }
        if (req.method === 'DELETE') {
          try { workPresets.remove(url.searchParams.get('id') ?? ''); } catch (err) { return send(res, 400, (err as Error).message); }
          return json(res, 200, workPresets.list());
        }
      }
      // Agent Hub 스킬 — 에이전트 세션이 쓰는 회사 스킬
      if (url.pathname === '/hub-skills' && hubSkills) {
        if (req.method === 'GET') return json(res, 200, hubSkills.list());
        if (req.method === 'POST') {
          const body = await readJson(req, res);
          if (body === undefined) return;
          try {
            hubSkills.save(body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, hubSkills.list());
        }
        if (req.method === 'DELETE') {
          try { hubSkills.remove(url.searchParams.get('name') ?? ''); } catch (err) { return send(res, 400, (err as Error).message); }
          return json(res, 200, hubSkills.list());
        }
      }
      // 연동 — AI 마다 로그인 / API 키. 키 값은 돌려주지 않는다. 새 작업부터 적용.
      if (url.pathname === '/auth' && auth) {
        if (req.method === 'GET') return json(res, 200, auth.public());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          if (!['claude', 'codex', 'gemini'].includes(body?.agent)) return send(res, 400, 'AI 이름이 맞지 않음');
          try {
            auth.set(body.agent, body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, auth.public());
        }
      }
      // 업데이트 — 레포 주소, 자동/수동, 지금 확인, 받기
      if (url.pathname === '/update' && updater) {
        if (req.method === 'GET') return json(res, 200, updater.public());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            if (body?.action === 'check') void updater.check();
            else if (body?.action === 'apply') void updater.apply();
            else updater.set(body ?? {});
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, updater.public());
        }
      }
      // 연동의 설치 — AI CLI 가 있는지, 없으면 터미널 창에서 npm 설치
      if (url.pathname === '/clis' && clis) {
        if (req.method === 'GET') return json(res, 200, clis());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          if (!['claude', 'codex', 'gemini'].includes(body?.agent)) return send(res, 400, 'AI 이름이 맞지 않음');
          try {
            await openInstall?.(`${{ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[body.agent as 'claude']} CLI 설치`, installCommand(body.agent));
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, clis());
        }
      }
      // 연동의 GitHub — 상태(계정 이름만), 설치 터미널, 로그인(일회용 코드), 로그아웃. 토큰은 내보내지 않는다.
      if (url.pathname === '/github' && github) {
        if (req.method === 'GET') return json(res, 200, await github.status());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            if (body?.action === 'install') await openInstall?.('GitHub CLI 설치', github.installCommand());
            else if (body?.action === 'login') await github.startLogin();
            else if (body?.action === 'cancel') github.cancelLogin();
            else if (body?.action === 'logout') await github.logout();
            else return send(res, 400, '알 수 없는 동작');
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, await github.status());
        }
      }
      // 공유 레포 — 설정(레포·종류), 지금 받기, 올리기, 내리기. PC 앞 화면에서만(이 서버가 그렇다)
      if (url.pathname === '/shared' && shared) {
        if (req.method === 'GET') return json(res, 200, shared.public());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            const kind = body?.kind as SharedKind;
            if (body?.action === 'pull') await shared.pull();
            else if (body?.action === 'push' || body?.action === 'unshare') {
              if (!SHARED_KINDS.includes(kind) || typeof body.id !== 'string') return send(res, 400, '종류와 대상을 정해 주세요');
              await (body.action === 'push' ? shared.push(kind, body.id) : shared.unshare(kind, body.id));
            } else await shared.set(body ?? {});
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, shared.public());
        }
      }
      // 툴 — 모든 세션에 붙이는 MCP 서버. 새 작업부터 적용.
      if (url.pathname === '/tools' && tools) {
        if (req.method === 'GET') return json(res, 200, tools.list());
        if (req.method === 'POST') {
          const body = await readJson(req, res);
          if (body === undefined) return;
          try {
            tools.save(body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, tools.list());
        }
        if (req.method === 'DELETE') {
          try { tools.remove(url.searchParams.get('id') ?? ''); } catch (err) { return send(res, 400, (err as Error).message); }
          return json(res, 200, tools.list());
        }
      }
      // 에이전트 프리셋 — PC 화면에서 만들고 고친다. 메인 에이전트가 clink 로 고른다.
      if (url.pathname === '/presets' && presets) {
        if (req.method === 'GET') return json(res, 200, presets.list());
        if (req.method === 'POST') {
          const body = await readJson(req, res);
          if (body === undefined) return;
          try {
            presets.save(body);
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          sessions.presetsChanged();
          return json(res, 200, presets.list());
        }
        if (req.method === 'DELETE') {
          try { presets.remove(url.searchParams.get('id') ?? ''); } catch (err) { return send(res, 400, (err as Error).message); }
          sessions.presetsChanged();
          return json(res, 200, presets.list());
        }
      }
      if (req.method === 'GET') {
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        if (!STATIC.has(path)) return send(res, 404, '없음');
        const body = await readFile(join(uiDir, path));
        res.writeHead(200, { 'content-type': TYPES[extname(path)], 'cache-control': 'no-store' });
        return res.end(body);
      }
      send(res, 405, '허용되지 않은 방식');
    } catch (err) {
      send(res, 500, String((err as Error).message));
    }
  });

  // clink 는 작업자가 끝날 때까지(사람 승인 포함) 응답을 붙잡고 있으므로 요청 제한 시간을 끈다.
  server.requestTimeout = 0;
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

function events(req: IncomingMessage, res: ServerResponse, sessions: SessionManager) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const unsubscribe = sessions.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

/** application/json 본문 읽기. 실패하면 응답을 보내고 undefined. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  // application/json 강제 → 다른 사이트의 단순 폼 전송(CSRF)은 브라우저가 사전 확인에서 막는다.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return void send(res, 415, 'JSON 만 받음');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return void send(res, 413, '너무 큼');
  }
  try {
    return JSON.parse(raw);
  } catch {
    return void send(res, 400, 'JSON 형식 오류');
  }
}

/** 메인 에이전트용 MCP (Streamable HTTP, JSON 응답만). 토큰이 메인 세션을 가리킨다. */
async function mcp(req: IncomingMessage, res: ServerResponse, sessions: SessionManager, token: string) {
  const mainId = sessions.mainForToken(token);
  if (!mainId) return send(res, 404, '없는 MCP 주소');
  if (req.method === 'GET') return send(res, 405, 'SSE 스트림 없음'); // 스펙상 허용: 서버가 먼저 보낼 것이 없다
  if (req.method === 'DELETE') return send(res, 200, 'ok');
  if (req.method !== 'POST') return send(res, 405, '허용되지 않은 방식');
  const body = await readJson(req, res);
  if (body === undefined) return;
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handleMcp(m as object, mainId, sessions)))).filter(Boolean);
  if (out.length === 0) {
    res.writeHead(202);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
}

async function command(req: IncomingMessage, res: ServerResponse, sessions: SessionManager) {
  const parsed = await readJson(req, res);
  if (parsed === undefined) return;
  const cmd = parseCommand(parsed);
  if (!cmd) return send(res, 400, '모르는 명령');
  await sessions.handle(cmd, { via: 'local', user: 'local' });
  send(res, 202, 'ok');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function send(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
