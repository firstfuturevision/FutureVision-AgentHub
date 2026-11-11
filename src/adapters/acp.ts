import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SessionInfo } from '../protocol.ts';
import type { AgentAdapter, Emit, ImagePart, StartContext } from './types.ts';
import { spawnCli } from './spawn.ts';

export interface AcpOptions {
  label: string; // 화면·오류 문구용 이름 (Gemini, Codex)
  command: string;
  args: string[];
  startTimeoutMs?: number; // initialize + session/new 가 이 안에 안 오면 로그인 문제로 본다
  modelArg?: string; // 모델을 CLI 인자로 지정하는 경우(예: gemini 의 '--model'). 없으면 ACP session/set_model
}

interface PermissionOption { optionId: string; name: string; kind: string }
interface Pending { resolve: (v: any) => void; reject: (e: any) => void }

const PROTOCOL_VERSION = 1;

/**
 * Agent Client Protocol (JSON-RPC 2.0, 줄 단위 JSON over stdio) 어댑터.
 * Gemini CLI(--experimental-acp)와 Codex(codex-acp)가 같은 코드를 탄다.
 * 승인 요청(session/request_permission)을 화면의 허용·거부 버튼으로 잇는다.
 * (Gemini 0.23.0 / @agentclientprotocol/sdk PROTOCOL_VERSION 1 에서 확인)
 */
export class AcpAdapter implements AgentAdapter {
  private opts: AcpOptions;
  private proc: ChildProcess | null = null;
  private emit: Emit = () => {};
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private acpSessionId: string | null = null;
  private stopped = false;
  private ended = false;
  private stderrTail: string[] = [];
  private text = ''; // 지금 쓰는 중인 에이전트 문장
  private queue: { text: string; images: ImagePart[] }[] = []; // ACP 는 한 번에 한 차례 — 새 prompt 가 앞 것을 취소하므로 줄 세운다
  private busy = false;
  private permissions = new Map<string, { rpcId: number | string; options: PermissionOption[] }>();
  private permSeq = 0;

  constructor(opts: AcpOptions) {
    this.opts = opts;
  }

  async start(session: SessionInfo, emit: Emit, ctx: StartContext = {}) {
    this.emit = emit;
    const args = [...this.opts.args];
    if (session.model && this.opts.modelArg) args.push(this.opts.modelArg, session.model);
    this.proc = spawnCli(this.opts.command, args, session.workdir, ctx.env);
    createInterface({ input: this.proc.stdout! }).on('line', (l) => this.onLine(l));
    createInterface({ input: this.proc.stderr! }).on('line', (l) => {
      this.stderrTail.push(l);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.proc.on('error', (err) => this.end(`${this.opts.label} 실행 실패: ${err.message}`));
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject({ message: '프로세스 종료' });
      this.pending.clear();
      const tail = this.stderrTail.slice(-3).join(' / ');
      this.end(this.stopped ? '사용자가 종료함' : `${this.opts.label} 프로세스 종료 (code ${code})${tail ? `: ${tail}` : ''}`);
    });

    const timeoutMs = this.opts.startTimeoutMs ?? 60000;
    try {
      await withTimeout(
        (async () => {
          await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            // 파일·터미널은 에이전트가 직접 다룬다(작업 폴더 안에서). 호스트가 대신 읽고 쓰지 않는다.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });
          // 연동이 API 키면 그 인증 방식을 고른다(키는 환경 변수로 이미 들어가 있음)
          if (ctx.authMethod) await this.request('authenticate', { methodId: ctx.authMethod });
          // 메인이면 hub(clink·프리셋) + 설정의 툴을 붙인다 (ACP McpServer 형식: http 는 type·url·headers, stdio 는 command·args·env)
          const mcpServers: unknown[] = ctx.mcp ? [{ type: 'http', name: ctx.mcp.name, url: ctx.mcp.url, headers: [] }] : [];
          for (const t of ctx.tools ?? []) {
            mcpServers.push(t.type === 'http' ? { type: 'http', name: t.name, url: t.url, headers: [] } : { name: t.name, command: t.command, args: t.args ?? [], env: [] });
          }
          const extra = ctx.extraDirs?.length ? { additionalDirectories: ctx.extraDirs } : {}; // 연결 폴더(지원하는 에이전트만 씀)
          const res = await this.request('session/new', { cwd: session.workdir, mcpServers, ...extra });
          this.acpSessionId = res.sessionId;
          // 쓸 수 있는 모델 목록을 알려 주면(ACP models) 화면 드롭다운을 실제 목록으로 바꾼다
          const avail = res?.models?.availableModels;
          if (Array.isArray(avail) && avail.length) {
            this.emit({
              type: 'agent.models',
              agent: session.agent,
              models: avail.filter((m: any) => typeof m?.modelId === 'string').map((m: any) => ({ id: m.modelId, name: m.name ?? m.modelId })),
              current: typeof res.models.currentModelId === 'string' ? res.models.currentModelId : null,
            });
          }
          if (session.model && !this.opts.modelArg) {
            try {
              await this.request('session/set_model', { sessionId: this.acpSessionId, modelId: session.model });
            } catch (err: any) {
              this.emit({ type: 'error', message: `${this.opts.label} 모델 지정 실패(${session.model}) — 기본 모델로 진행: ${err?.message ?? err}` });
            }
          }
        })(),
        timeoutMs,
      );
    } catch (err: any) {
      const reason =
        err === TIMEOUT
          ? `${this.opts.label} 가 ${timeoutMs / 1000}초 동안 응답 없음 — 공용 PC 터미널에서 ${this.opts.command} 를 직접 실행해 로그인 상태를 확인`
          : isAuthRequired(err)
            ? `${this.opts.label} 로그인 필요 — 공용 PC에서 로그인하거나 API 키를 설정`
            : `${this.opts.label} 시작 실패: ${err?.message ?? String(err)}`;
      this.end(reason);
      this.kill();
    }
  }

  send(text: string, images: ImagePart[] = []) {
    if (this.ended) return;
    this.queue.push({ text, images });
    void this.pump();
  }

  respondPermission(requestId: string, allow: boolean) {
    const p = this.permissions.get(requestId);
    if (!p) return;
    this.permissions.delete(requestId);
    const want = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    const opt = want.map((k) => p.options.find((o) => o.kind === k)).find(Boolean);
    const outcome = opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
    this.write({ jsonrpc: '2.0', id: p.rpcId, result: { outcome } });
  }

  /** 멈춤: session/cancel — 하던 prompt 가 stopReason 'cancelled' 로 끝나고 세션은 그대로 */
  interrupt() {
    this.queue.length = 0;
    for (const id of [...this.permissions.keys()]) this.respondPermission(id, false);
    if (this.busy && this.acpSessionId) this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpSessionId } });
  }

  stop() {
    this.stopped = true;
    if (this.busy && this.acpSessionId) this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpSessionId } });
    for (const id of [...this.permissions.keys()]) this.respondPermission(id, false);
    this.proc?.stdin?.end();
    const p = this.proc;
    setTimeout(() => { if (p && p.exitCode === null) p.kill(); }, 3000);
  }

  // ── 차례 진행 ─────────────────────────────
  private async pump() {
    if (this.busy || !this.acpSessionId) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      // ACP ContentBlock: 이미지는 {type:'image', mimeType, data}
      const prompt = [...next.images.map((i) => ({ type: 'image', mimeType: i.mime, data: i.data })), { type: 'text', text: next.text }];
      const res = await this.request('session/prompt', { sessionId: this.acpSessionId, prompt });
      this.flushText();
      this.emit({ type: 'turn.done', durationMs: Date.now() - t0, costUsd: null, isError: res?.stopReason === 'refusal' });
    } catch (err: any) {
      this.flushText();
      if (!this.ended) {
        this.emit({ type: 'error', message: `${this.opts.label}: ${err?.message ?? String(err)}` });
        this.emit({ type: 'turn.done', durationMs: Date.now() - t0, costUsd: null, isError: true });
      }
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private flushText() {
    if (!this.text) return;
    this.emit({ type: 'agent.text', text: this.text, partial: false });
    this.text = '';
  }

  // ── JSON-RPC ─────────────────────────────
  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: unknown) {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    // 응답
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(m.error);
      else p.resolve(m.result);
      return;
    }
    // 에이전트 → 호스트 알림·요청
    switch (m.method) {
      case 'session/update':
        this.onUpdate(m.params?.update);
        return;
      case 'session/request_permission':
        this.onPermission(m.id, m.params);
        return;
      default:
        // 광고하지 않은 기능(fs/*, terminal/*)이나 모르는 요청은 거절한다.
        if (m.id !== undefined) this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `지원하지 않음: ${m.method}` } });
    }
  }

  private onUpdate(u: any) {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') {
          this.text += u.content.text;
          this.emit({ type: 'agent.text', text: this.text, partial: true });
        }
        return;
      case 'tool_call':
        this.flushText();
        this.emit({ type: 'agent.tool', toolId: u.toolCallId, name: u.title ?? u.kind ?? '도구', input: { kind: u.kind, locations: u.locations } });
        return;
      case 'usage_update':
        // ACP 의 컨텍스트 사용량(used 토큰 / size 컨텍스트 창). 보내 주는 CLI 만 막대가 뜬다
        if (typeof u.used === 'number') this.emit({ type: 'context.usage', used: u.used, window: typeof u.size === 'number' ? u.size : null });
        return;
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') {
          this.emit({ type: 'agent.tool_result', toolId: u.toolCallId, ok: u.status === 'completed', summary: summarizeContent(u.content) });
        }
        return;
      // agent_thought_chunk, plan, available_commands_update 등은 지금은 화면에 올리지 않는다.
    }
  }

  private onPermission(rpcId: number | string, params: any) {
    this.flushText();
    const requestId = `p${++this.permSeq}`;
    const tc = params?.toolCall ?? {};
    this.permissions.set(requestId, { rpcId, options: params?.options ?? [] });
    const where = (tc.locations ?? []).map((l: any) => l.path).filter(Boolean).join(', ');
    const diff = (tc.content ?? []).find((c: any) => c.type === 'diff');
    const detail = [tc.kind, where || diff?.path].filter(Boolean).join(' · ');
    this.emit({ type: 'permission.request', requestId, tool: tc.title ?? '도구 실행', detail });
  }

  private end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.flushText();
    this.emit({ type: 'session.ended', reason });
  }

  private kill() {
    const p = this.proc;
    p?.stdin?.end();
    if (p && p.exitCode === null) p.kill();
  }
}

const TIMEOUT = Symbol('timeout');
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(TIMEOUT), ms);
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
  });
}

function isAuthRequired(err: any): boolean {
  return err?.code === -32000 || /auth/i.test(String(err?.message ?? ''));
}

function summarizeContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = content.map((c: any) => {
    if (c?.type === 'content' && c.content?.type === 'text') return c.content.text;
    if (c?.type === 'diff') return `${c.path} 수정`;
    return '';
  });
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
