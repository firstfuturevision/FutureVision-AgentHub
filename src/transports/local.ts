import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import type { AutoStart } from '../autostart.ts';
import { isPrivateAddress, isOwnHost, type RemoteAccess } from '../remote.ts';
import type { Peers } from '../peers.ts';
import type { MemoryStore } from '../memory.ts';
import type { CliUpdater } from '../cliupdate.ts';
import { probeClaudeLimits } from '../limits.ts';
import type { Author, CommandOrigin } from '../protocol.ts';
import { networkInterfaces } from 'node:os';
import type { ScreenControl } from '../screen.ts';
import type { ClaudeCli } from '../models.ts';
import { listFolders, createFolder, browseFolders } from '../folders.ts';
import { pickFolderNative } from '../pickfolder.ts';
import type { SessionManager } from '../sessions.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const STATIC = new Set(['/index.html', '/app.js', '/md.js', '/style.css', '/screen.js']);

/**
 * 공용 PC 앞 "직접 작업" 화면. 127.0.0.1 에만 열린다.
 * 화면 → 호스트: POST /cmd (JSON), 호스트 → 화면: GET /events (SSE)
 */
export function startLocalServer(opts: { port: number; uiDir: string; sessions: SessionManager; info: Record<string, unknown>; presets?: PresetStore; tools?: ToolStore; auth?: AuthStore; github?: GitHub; updater?: Updater; openInstall?: (title: string, command: string) => Promise<void>; clis?: () => Record<string, { installed: boolean; missing: string[] }>; hubSkills?: HubSkillStore; workPresets?: WorkPresetStore; schedules?: ScheduleStore; shared?: SharedRepo; autostart?: AutoStart; remote?: RemoteAccess; screen?: ScreenControl; claudeCli?: ClaudeCli; peers?: Peers; memory?: MemoryStore; cliUpdater?: CliUpdater; relayToken?: string }): Promise<Server> {
  const { port, uiDir, sessions, info, presets, tools, auth, github, updater, openInstall, clis, hubSkills, workPresets, schedules, shared, autostart, remote, screen, claudeCli, peers, memory, cliUpdater, relayToken } = opts;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  /**
   * 요청 처리 — 이 PC 화면과 원격(같은 사무실 네트워크)이 똑같이 쓴다. 비밀번호도 권한 구분도 없다(사용자 결정 2026-11-12).
   */
  // 나눠 올리는 중인 큰 파일(id → 자리·크기·받은 만큼). 1시간 넘게 멈춘 것은 버린다(파일은 남음)
  const uploads = new Map<string, { abs: string; path: string; name: string; mime: string; size: number; got: number; at: number }>();
  setInterval(() => { for (const [k, u] of uploads) if (Date.now() - u.at > 3600_000) uploads.delete(k); }, 600_000).unref();
  // 연결 상태(화면이 받는 모양 하나로): 이 PC 이름·원격 접속 주소(다른 PC 작업이 이 PC 아래에 있는지 알아보는 데 씀)·다른 PC 들
  const peerState = async (fresh = false) => ({ me: peers!.summary().name, myUrls: remote?.enabled ? remote.urls() : [], peers: await peers!.all(fresh) });

  const route = async (req: IncomingMessage, res: ServerResponse, lanReq = false) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/events') return events(req, res, sessions);
      if (req.method === 'GET' && url.pathname === '/info') return json(res, 200, info);
      // 다른 PC 의 Agent Hub(왼쪽 "연결"): 이 PC 요약은 다른 PC 가 원격 접속으로 가져간다
      // 다른 PC 작업을 이 PC 작업 아래에: 그 PC 가 하위 작업 공유를 보낸다 / 이 PC 작업을 다른 PC 작업 아래로 둔다
      if (req.method === 'POST' && url.pathname === '/peer/share') {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        try { sessions.receiveRemoteShare(String(body?.to ?? ''), String(body?.fromPc ?? ''), String(body?.fromId ?? ''), String(body?.title ?? ''), String(body?.text ?? '')); } catch (err) { return send(res, 400, (err as Error).message); }
        return json(res, 200, { ok: true });
      }
      // 다른 PC 가 이 PC 를 연결 목록에 더하거나 뺐다고 알려 옴 → 이 PC 목록에도(양방향). 원격 접속으로만 들어온다
      if (req.method === 'POST' && (url.pathname === '/peer/hello' || url.pathname === '/peer/bye') && peers) {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        const bye = url.pathname === '/peer/bye';
        const u = peers.greeted(req.socket.remoteAddress ?? '', body?.port, bye);
        const who = String(body?.name ?? '').slice(0, 60) || u;
        if (u) sessions.notice(bye ? `${who} PC 가 연결을 뺐어요 — 이 PC 연결 목록에서도 뺐어요` : `${who} PC 가 연결했어요 — 이 PC 연결 목록에도 더했어요(왼쪽 위 연결)`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/peer/parent') {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        const p = body?.parent;
        const parent = p && typeof p.url === 'string' && typeof p.id === 'string' ? { url: p.url.slice(0, 80), id: p.id.slice(0, 60), pc: String(p.pc ?? '').slice(0, 60) } : null;
        try { sessions.setRemoteParent(String(body?.taskId ?? ''), parent); } catch (err) { return send(res, 400, (err as Error).message); }
        return json(res, 200, { ok: true });
      }
      // 다른 PC 작업을 이 화면에서: 그 PC 의 소식을 그 작업(과 그 작업이 맡긴 작업자) 것만 골라 이어 준다 / 명령을 그 PC 로
      if (req.method === 'GET' && url.pathname === '/peers/events' && peers) {
        const target = peers.urls().find((u) => u === url.searchParams.get('url'));
        const id = url.searchParams.get('id') ?? '';
        if (!target || !id) return send(res, 400, '연결된 PC 와 작업을 주세요');
        return remoteEvents(req, res, target, id);
      }
      if (req.method === 'POST' && url.pathname === '/peers/cmd' && peers) {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        const target = peers.urls().find((u) => u === body?.url);
        const cmd = parseCommand(body?.cmd);
        if (!target || !cmd) return send(res, 400, '연결된 PC 와 명령을 주세요');
        // 사람이 이 화면에서 보낸 지시는 그 PC 기록에 "Agent Hub <이 PC> · 사람"으로
        const out = cmd.type === 'user.message' ? { ...cmd, via: { app: `Agent Hub ${peers.summary().name}`.slice(0, 40), label: '사람' } } : cmd;
        try {
          const r = await fetch(`${target}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out), signal: AbortSignal.timeout(10000) });
          if (!r.ok) return send(res, 502, `${r.status} ${(await r.text()).slice(0, 200)}`);
        } catch (err) { return send(res, 502, `그 PC 에 못 보냄: ${(err as Error).message}`); }
        return send(res, 202, 'ok');
      }
      if (req.method === 'POST' && url.pathname === '/peers/parent' && peers) {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        try { await peers.setParent(String(body?.url ?? ''), String(body?.taskId ?? ''), body?.parentId ? String(body.parentId) : null, peers.summary().name); } catch (err) { return send(res, 400, (err as Error).message); }
        return json(res, 200, await peerState(true));
      }
      if (req.method === 'GET' && url.pathname === '/peer/summary') return json(res, 200, peers ? peers.summary() : { name: '', tasks: [] });
      if (url.pathname === '/peers' && peers) {
        if (req.method === 'GET') return json(res, 200, await peerState(url.searchParams.has('fresh')));
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          let added: string;
          try { added = peers.add(body?.url); } catch (err) { return send(res, 400, (err as Error).message); }
          void peers.hello(added); // 상대 목록에도 이 PC 를
          return json(res, 200, await peerState());
        }
        if (req.method === 'DELETE') { const u = url.searchParams.get('url'); peers.remove(u); if (u) void peers.hello(u, true); return json(res, 200, await peerState()); }
      }
      // 다른 PC 의 입력 세션 모델·기억 맞추기(그 PC 의 원격 접속으로)
      if (url.pathname === '/peers/settings' && peers && req.method === 'POST') {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        try {
          if (body?.action === 'intake') return json(res, 200, await peers.post(String(body.url ?? ''), '/intake', { model: body.model }));
          if (body?.action === 'reconcile') return json(res, 200, { started: await sessions.reconcileMemory(true) });
          return send(res, 400, '모르는 요청');
        } catch (err) { return send(res, 400, (err as Error).message); }
      }
      if (url.pathname === '/peers/send' && peers && req.method === 'POST') {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        const text = String(body?.text ?? '').trim().slice(0, 20000);
        if (!text || !Array.isArray(body?.ids)) return send(res, 400, '보낼 글과 작업이 필요함');
        try { return json(res, 200, { sent: await peers.sendIds(String(body.url ?? ''), body.ids.map(String).slice(0, 300), text) }); } catch (err) { return send(res, 400, (err as Error).message); }
      }
      // 설정 → 기억 → 입력 세션: 모델
      if (url.pathname === '/intake' && sessions.intake) {
        if (req.method === 'GET') return json(res, 200, sessions.intake.public());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            if (body?.model !== undefined) await sessions.setIntakeModel(body.model);
            if (body?.newTasksOn !== undefined) sessions.intake.setNewTasksOn(body.newTasksOn);
            if (typeof body?.allOn === 'boolean') sessions.setIntakeMany(body.allOn, undefined, true);
          } catch (err) { return send(res, 400, (err as Error).message); }
          return json(res, 200, sessions.intake.public());
        }
      }
      // 설정 → 기억: 취향·고쳐 준 것(모든 작업이 받는다), 공통 지침
      if (url.pathname === '/memory' && memory) {
        if (req.method === 'GET') return json(res, 200, memory.public());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            if (body?.action === 'add') memory.add(body.text, '사람', body.scope);
            else if (body?.action === 'scope') memory.setScope(body.id, body.scope);
            else if (body?.action === 'replaceShared') memory.replaceShared(body.guide, body.items, String(body.by ?? '맞추기').slice(0, 60), body.dates);
            else if (body?.action === 'edit') memory.edit(body.id, body.text);
            else if (body?.action === 'remove') memory.remove(body.id);
            else if (body?.action === 'guide') memory.setGuide(body.text);
            else return send(res, 400, '모르는 요청');
          } catch (err) { return send(res, 400, (err as Error).message); }
          return json(res, 200, memory.public());
        }
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, sessions.health); // AI 마다 연결 상태
      if (req.method === 'POST' && url.pathname === '/cmd') return await command(req, res, sessions, { via: 'local', user: 'local', author: authorOf(req, lanReq, relayToken) });
      // 원격 접속 — 켜기·끄기
      if (url.pathname === '/remote' && remote) {
        if (req.method === 'GET') return json(res, 200, { ...remote.public(), error: lanError, local: `http://127.0.0.1:${port}` });
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            remote.set(body ?? {});
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          // 끌 때는 답을 먼저 보내고 닫는다(사무실 주소로 연 이 PC 화면이 답을 받고 127.0.0.1 로 옮겨 가게)
          if (!remote.enabled) {
            res.once('finish', () => void syncLan());
            return json(res, 200, { ...remote.public(), error: null, local: `http://127.0.0.1:${port}` });
          }
          await syncLan();
          return json(res, 200, { ...remote.public(), error: lanError, local: `http://127.0.0.1:${port}` });
        }
      }
      // 권한 묻지 않기(모든 작업) — PC 앞·원격 접속(같은 권한)에서만. 대시보드는 이 서버를 거치지 않는다
      if (url.pathname === '/permissions') {
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          if (typeof body?.autoApproveAll !== 'boolean') return send(res, 400, 'autoApproveAll 은 true/false');
          sessions.setAutoApproveAll(body.autoApproveAll);
        }
        return json(res, 200, { autoApproveAll: sessions.autoApproveAll });
      }
      // 화면 제어 — 이 PC 화면 보기·마우스·키보드(원격 접속처럼 구분 없음, 따로 켜고 끈다)
      if ((url.pathname === '/screen' || url.pathname.startsWith('/screen/')) && screen) return await screenRoute(req, res, url, screen);
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
      // 큰 파일 나눠 올리기(동영상 등, 4GB 까지): start → chunk(순서대로, 16MB 까지) → finish. 조각은 파일에 바로 이어 써서 메모리를 쓰지 않고,
      // 조각 하나가 작아 바깥 중계(Cloudflare 요청 100MB 제한 등)를 거쳐도 올라간다
      if (req.method === 'POST' && url.pathname === '/attach/start') {
        const body = (await readJson(req, res)) as any;
        if (body === undefined) return;
        const size = Number(body?.size);
        if (!Number.isFinite(size) || size <= 0 || size > 4 * 1024 ** 3) return send(res, 413, '파일 크기는 4GB 까지');
        try {
          const a = sessions.newAttachment(String(url.searchParams.get('sessionId') ?? ''), String(body?.name ?? ''), String(body?.mime ?? ''));
          const id = randomBytes(12).toString('hex');
          uploads.set(id, { ...a, size, got: 0, at: Date.now() });
          return json(res, 200, { id });
        } catch (err) { return send(res, 400, (err as Error).message); }
      }
      if (req.method === 'POST' && url.pathname === '/attach/chunk') {
        const u = uploads.get(url.searchParams.get('id') ?? '');
        if (!u) return send(res, 404, '없는 올리기(다시 시작하세요)');
        if (Number(url.searchParams.get('offset')) !== u.got) return send(res, 409, `이어 쓸 자리가 맞지 않음(${u.got})`);
        let n = 0;
        for await (const c of req) {
          n += c.length;
          if (n > 16 * 1024 * 1024 || u.got + n > u.size) return send(res, 413, '조각이 너무 큼');
          appendFileSync(u.abs, c);
        }
        u.got += n;
        u.at = Date.now();
        return json(res, 200, { got: u.got });
      }
      if (req.method === 'POST' && url.pathname === '/attach/finish') {
        const id = url.searchParams.get('id') ?? '';
        const u = uploads.get(id);
        if (!u) return send(res, 404, '없는 올리기');
        uploads.delete(id);
        if (u.got !== u.size) return send(res, 400, `덜 올라옴(${u.got}/${u.size})`);
        return json(res, 200, { path: u.path, name: u.name, mime: u.mime, size: u.size });
      }
      // 이 PC 의 Claude Code 세션 — 가져와 이어 가기(PC 앞에서만: 개인 대화가 들어 있다)
      if (req.method === 'GET' && url.pathname === '/claude-code') return json(res, 200, sessions.claudeCodeSessions());
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
        if (req.method === 'GET') return json(res, 200, url.searchParams.get('all') ? schedules.list() : schedules.forSession(url.searchParams.get('sessionId') ?? '')); // all=1: 왼쪽 예약 탭
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
            else if (body?.action === 'restart') setTimeout(() => updater.restartNow(), 300); // 답을 보낸 뒤
            else if (body?.action === 'restart-code') setTimeout(() => updater.restartForCode(body?.now === true), 300); // 바뀐 코드로: 지금 또는 작업이 끝난 뒤
            else updater.set(body ?? {});
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
          return json(res, 200, updater.public());
        }
      }
      // 연동의 설치 — AI CLI 가 있는지, 없으면 터미널 창에서 npm 설치
      // Claude CLI — 버전·새 버전·CLI 가 아는 모델. 업데이트는 터미널 창에서 `claude update`
      if (url.pathname === '/claude-cli' && claudeCli) {
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          if (body?.action === 'update') {
            try { await openInstall?.('Claude Code 업데이트', `${String(info.claudeCommand ?? 'claude')} update`); } catch (err) { return send(res, 400, (err as Error).message); }
            // 업데이트가 끝날 즈음 다시 묻는다(모델 목록이 새 CLI 기준으로 바뀐다)
            for (const ms of [45_000, 120_000, 300_000]) setTimeout(() => void claudeCli.refresh(), ms).unref();
          } else if (body?.action === 'refresh') await claudeCli.refresh();
          else return send(res, 400, '알 수 없는 동작');
        } else {
          const st = claudeCli.public();
          // 10분 넘게 안 물었으면 뒤에서 다시 묻는다(이번 답은 저장된 것)
          if (!st.checking && (!st.checkedAt || Date.now() - Date.parse(st.checkedAt) > 10 * 60 * 1000)) void claudeCli.refresh();
        }
        return json(res, 200, claudeCli.public());
      }
      // 연결별 사용 한도(설정 → 연동): 모아 둔 것, "지금 확인"은 그 로그인으로 아주 작은 요청을 보내 받는다
      if (url.pathname === '/limits' && sessions.limits) {
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          const account = body?.account === 'agent' ? 'agent' : body?.account === 'apikey' ? 'apikey' : 'default';
          try { sessions.limits.record('claude', account, await probeClaudeLimits(String(info.claudeCommand ?? 'claude'), sessions.claudeEnvFor(account))); } catch (err) { return send(res, 502, (err as Error).message); }
        }
        return json(res, 200, sessions.limits.public());
      }
      // 작업자 프로그램 자동 업데이트(왼쪽 "예약" 맨 위): 켜기·끄기·시각, 지금 확인
      if (url.pathname === '/cli-update' && cliUpdater) {
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          try {
            if (body?.action === 'check') void cliUpdater.check();
            else cliUpdater.set(body ?? {});
          } catch (err) { return send(res, 400, (err as Error).message); }
        }
        return json(res, 200, cliUpdater.public());
      }
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
      // 자동 실행 — 이 PC 에 로그인하면 뒤에서 켜기. PC 앞 화면에서만(이 서버가 그렇다)
      if (url.pathname === '/autostart' && autostart) {
        if (req.method === 'GET') return json(res, 200, autostart.status());
        if (req.method === 'POST') {
          const body = (await readJson(req, res)) as any;
          if (body === undefined) return;
          if (typeof body?.enabled !== 'boolean') return send(res, 400, 'enabled 는 true/false');
          try {
            return json(res, 200, await autostart.set(body.enabled));
          } catch (err) {
            return send(res, 400, (err as Error).message);
          }
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
      // 에이전트가 채팅에 띄운 그림(show_image)
      const img = req.method === 'GET' && url.pathname.match(/^\/images\/([^/]+)\/([^/]+)$/);
      if (img) {
        const found = sessions.imagePath(img[1], img[2]);
        if (!found) return send(res, 404, '없음');
        res.writeHead(200, { 'content-type': found.type, 'cache-control': 'private, max-age=86400' });
        return res.end(await readFile(found.path));
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
      if (!res.headersSent) send(res, 500, String((err as Error).message));
    }
  };

  const server = createServer((req, res) => {
    // DNS 리바인딩·다른 사이트의 요청 차단: Host 와 Origin 이 이 서버여야 한다.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, '허용되지 않은 Host');
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, '허용되지 않은 Origin');
    // 원격 접속이 켜져 있으면 화면은 사무실 주소로 연다 — 주소창 주소를 그대로 다른 사람에게 알려 줄 수 있게
    const lanUrl = lan && remote ? remote.urls()[0] : undefined;
    if (lanUrl && req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(302, { location: `${lanUrl}/`, 'cache-control': 'no-store' });
      return res.end();
    }
    void route(req, res);
  });
  // clink 는 작업자가 끝날 때까지(사람 승인 포함) 응답을 붙잡고 있으므로 요청 제한 시간을 끈다.
  server.requestTimeout = 0;

  // ── 원격 접속(사무실 네트워크): 켜져 있을 때만 0.0.0.0:<원격 포트> 에 하나 더 연다 ──
  let lan: Server | null = null;
  let lanPort = 0;
  let lanError: string | null = null;
  const lanHandle = async (req: IncomingMessage, res: ServerResponse) => {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    if (!remote?.enabled || !isPrivateAddress(ip)) return send(res, 403, '사무실 네트워크에서만 들어올 수 있음');
    // 비밀번호가 없으니 이것이 문이다: Host 는 이 PC 의 주소·이름 그대로여야 한다.
    // 다른 이름(evil.example)이 이 PC 주소를 가리키게 해서 그 사이트가 사람 브라우저로 들어오는 것(DNS 리바인딩)을 막는다.
    if (!isOwnHost(req.headers.host, lanPort)) return send(res, 403, '허용되지 않은 Host');
    // 다른 사이트에서 이 주소로 보내는 요청 차단: Origin 이 있으면 이 주소와 같아야 한다
    const origin = req.headers.origin;
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return send(res, 403, '허용되지 않은 Origin');
    return route(req, res, true);
  };
  const syncLan = async () => {
    if (!remote) return;
    if (lan && (!remote.enabled || lanPort !== remote.port)) {
      const old = lan;
      lan = null;
      old.closeAllConnections?.();
      await new Promise((ok) => old.close(() => ok(null)));
    }
    if (!remote.enabled || lan) return;
    const s = createServer((req, res) => void lanHandle(req, res));
    s.requestTimeout = 0;
    try {
      await new Promise((ok, fail) => { s.once('error', fail); s.listen(remote.port, '0.0.0.0', () => ok(null)); });
      lan = s;
      lanPort = remote.port;
      lanError = null;
    } catch (err) {
      lanError = `원격 접속을 열지 못함: ${(err as Error).message}`;
    }
  };
  server.on('close', () => { lan?.closeAllConnections?.(); lan?.close(); screen?.stop(); });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { void syncLan().then(() => ok(server)); });
  });
}

async function screenRoute(req: IncomingMessage, res: ServerResponse, url: URL, screen: ScreenControl) {
  const q = (k: string) => Number(url.searchParams.get(k) ?? NaN);
  if (url.pathname === '/screen') {
    if (req.method === 'POST') {
      const body = (await readJson(req, res)) as any;
      if (body === undefined) return;
      try { screen.set(body ?? {}); } catch (err) { return send(res, 400, (err as Error).message); }
    } else if (req.method !== 'GET') return send(res, 405, '허용되지 않은 방식');
    let monitors: unknown[] = [];
    // 상태 확인은 오래 기다리지 않는다(도우미가 연결을 기다리는 중이면 모니터는 빈 목록)
    if (screen.enabled) { try { monitors = await screen.monitors(3000); } catch (err) { screen.error = (err as Error).message; } }
    return json(res, 200, { ...screen.public(), monitors });
  }
  if (!screen.enabled) return send(res, 403, '화면 제어가 꺼져 있음');
  if (req.method === 'GET' && url.pathname === '/screen/frame') {
    try {
      const f = await screen.frame(q('m'), q('w'), q('q'), url.searchParams.get('v') ?? '');
      // 관리자 확인 창·잠금 화면: 찍을 수 없다(관리자 권한 없이)
      // 리눅스 Wayland: 허용 대기·거절 같은 까닭이 함께 온다
      if (f.kind === 'secure') return send(res, 423, f.message ?? '관리자 확인 창이나 잠금 화면 — PC 앞에서 눌러야 함');
      res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store', 'content-length': f.data.length });
      return res.end(f.data);
    } catch (err) {
      return send(res, 503, (err as Error).message);
    }
  }
  // 클립보드: 보는 사람이 이 PC 클립보드 글을 가져가고(GET), 자기 글을 넣는다(POST {text}, 그다음 원격 화면에서 Ctrl+V)
  if (url.pathname === '/screen/clipboard') {
    if (req.method === 'GET') {
      try { return json(res, 200, { text: await screen.clipboard.get() }); } catch (err) { return send(res, 503, (err as Error).message); }
    }
    if (req.method === 'POST') {
      const body = (await readJson(req, res)) as any;
      if (body === undefined) return;
      try { await screen.clipboard.set(body?.text); return json(res, 200, { ok: true }); } catch (err) { return send(res, 400, (err as Error).message); }
    }
    return send(res, 405, '허용되지 않은 방식');
  }
  if (req.method === 'POST' && url.pathname === '/screen/input') {
    const body = (await readJson(req, res)) as any;
    if (body === undefined) return;
    try { return json(res, 200, { sent: await screen.input(body?.m, body?.events) }); } catch (err) { return send(res, 400, (err as Error).message); }
  }
  send(res, 404, '없음');
}

/** 다른 PC 의 /events 를 받아 그 작업(id)과 그 작업이 맡긴 작업자 소식만 넘긴다 */
async function remoteEvents(req: IncomingMessage, res: ServerResponse, url: string, id: string) {
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let up: Response;
  try { up = await fetch(`${url}/events`, { signal: ac.signal }); } catch (err) { return send(res, 502, `그 PC 에 연결 못 함: ${(err as Error).message}`); }
  if (!up.ok || !up.body) return send(res, 502, `그 PC 응답: ${up.status}`);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const ids = new Set([id]); // 그 작업 + 그 작업이 맡긴 작업자
  const dec = new TextDecoder();
  let buf = '';
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    for await (const chunk of up.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'session.created' && ev.session?.parentId && ids.has(ev.session.parentId)) ids.add(ev.session.id);
        const sid = ev.type === 'session.created' ? ev.session?.id : ev.sessionId;
        if (ev.type === 'replay.done' || (sid && ids.has(sid))) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    }
  } catch {} finally {
    clearInterval(ping);
    res.end();
  }
}

function events(req: IncomingMessage, res: ServerResponse, sessions: SessionManager) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  // at: 일어난 시각(화면의 경과 시간·안 읽음 계산용). 기록을 다 보내면 replay.done — 그 뒤 것만 새 소식이라 알림을 띄운다
  const unsubscribe = sessions.subscribe((ev) => res.write(`data: ${JSON.stringify({ ...ev, at: sessions.timeOf(ev) })}\n\n`));
  res.write(`data: ${JSON.stringify({ type: 'replay.done' })}\n\n`);
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

/** 머리말 값: 한글 등은 encodeURIComponent 로 넘긴다 */
function headerText(v: string | string[] | undefined, max: number): string {
  const raw = (Array.isArray(v) ? v[0] : v ?? '').trim();
  let t = raw;
  try { t = decodeURIComponent(raw); } catch {}
  return t.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * 화면에서 온 사람 글을 누가 · 어디서 썼는지.
 *  - 앞단 중계(로그인을 맡는 웹 등)가 X-Agent-Hub-Relay: <data/relay-token 내용> 와 X-Agent-Hub-User: <이름>(URL 인코딩, 선택 X-Agent-Hub-Via: <길 이름>)을 붙이면 그 이름
 *  - 키가 없거나 틀리면 이름은 받지 않는다(같은 망 누구나 원격 접속에 머리말을 적어 보낼 수 있어서)
 *  - 그 밖: 이 PC 화면이면 "이 PC", 원격 접속이면 "원격 접속 · <주소>"(이 PC 안의 중계가 루프백으로 붙으면 "원격 연결")
 */
export function authorOf(req: IncomingMessage, lanReq: boolean, relayToken?: string): Author {
  const key = headerText(req.headers['x-agent-hub-relay'], 200);
  const name = headerText(req.headers['x-agent-hub-user'], 60);
  if (relayToken && key && name && key.length === relayToken.length && timingSafeEqual(Buffer.from(key), Buffer.from(relayToken))) {
    return { name, path: headerText(req.headers['x-agent-hub-via'], 40) || '원격 연결' };
  }
  if (!lanReq) return { path: '이 PC' };
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
  if (ip === '::1' || ip.startsWith('127.')) return { path: '원격 연결' };
  const mine = Object.values(networkInterfaces()).some((l) => l?.some((n) => n.address.replace(/^::ffff:/i, '') === ip));
  return mine ? { path: '이 PC' } : { path: `원격 접속 · ${ip}` };
}

async function command(req: IncomingMessage, res: ServerResponse, sessions: SessionManager, origin: CommandOrigin) {
  const parsed = await readJson(req, res);
  if (parsed === undefined) return;
  const cmd = parseCommand(parsed);
  if (!cmd) return send(res, 400, '모르는 명령');
  await sessions.handle(cmd, origin);
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
