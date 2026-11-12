// 시험용 가짜 Claude CLI — 실제 claude -p stream-json 과 같은 모양의 줄을 낸다.
// 입력 한 줄마다: (처음만) system init → 글자 조각 → 완성 문장 → ("tool" 이 들어 있으면) 도구 사용·결과 → result
// --mcp-config 를 받으면 메인 에이전트처럼 동작: "@codex 할일" / "@gemini:모델 할일" 이면 실제로 MCP clink 를 부른다.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const argv = process.argv;
// --resume 이면 그 대화 id 그대로(실제 CLI 와 같이), 아니면 새 대화 id
const sid = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : randomUUID();
let turn = 0;

const cfgPath = argv.includes('--mcp-config') ? argv[argv.indexOf('--mcp-config') + 1] : null;
// 메인일 때만 hub(clink) 서버가 있다. 툴만 있거나 비어 있으면 일반 세션.
const mcpUrl = cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers?.hub?.url ?? null : null;
const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null;
let rpcId = 0;
const rpc = async (method, params) => {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return res.json();
};
let lastContinuation = null;

const queue = [];
let busy = false;
// 승인: --permission-prompt-tool stdio 면 "perm " 으로 시작하는 지시에 control_request 를 보내고 control_response 를 기다린다
const askTool = argv.includes('--permission-prompt-tool') ? argv[argv.indexOf('--permission-prompt-tool') + 1] : null;
const waiting = new Map();
let abortTurn = null; // "slow " 차례를 멈춤(interrupt)으로 끝낸다
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch {}
  if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
    abortTurn?.();
    return;
  }
  if (msg?.type === 'control_response') { waiting.get(msg.response?.request_id)?.(msg.response.response); waiting.delete(msg.response?.request_id); return; }
  queue.push(line);
  pump();
});

async function pump() {
  if (busy) return;
  const line = queue.shift();
  if (line === undefined) return;
  busy = true;
  try {
    const content = JSON.parse(line).message.content; const imgs = content.filter((c) => c.type === 'image').length; const txt = content.find((c) => c.type === 'text')?.text ?? ''; await handle(imgs ? `[이미지 ${imgs}] ${txt}` : txt);
  } finally {
    busy = false;
    pump();
  }
}

async function handle(text) {
  turn += 1;
  if (turn === 1) out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model });

  // "@codex 할일", "@gemini:모델 할일", "@again 이어서", "@role:프리셋이름 할일"
  // 띄어쓰기 있는 프리셋 이름은 "@role:코드 리뷰어 -- 할일"
  // 프리셋 관리 도구: "@preset-save {json}", "@preset-delete 이름", "@preset-list"
  const pm = mcpUrl && text.match(/^@preset-(save|delete|list)\s*([\s\S]*)$/);
  if (pm) {
    if (turn === 1) await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    const name = `agent_${pm[1]}`;
    const args = pm[1] === 'save' ? JSON.parse(pm[2]) : pm[1] === 'delete' ? { preset: pm[2].trim() } : {};
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_p${turn}`, name: `mcp__hub__${name}`, input: args }] }, parent_tool_use_id: null, session_id: sid });
    const r = await rpc('tools/call', { name, arguments: args });
    const t = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_p${turn}`, content: t, is_error: !!r.result?.isError }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `프리셋 결과: ${t}` }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.001, session_id: sid });
    return;
  }

  // "@tool 이름 {json}" — 메인의 MCP 도구를 그대로 부른다(프리셋·공유 도구 시험용)
  const tm = mcpUrl && text.match(/^@tool (\w+)\s*([\s\S]*)$/);
  if (tm) {
    if (turn === 1) await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    const args = tm[2].trim() ? JSON.parse(tm[2]) : {};
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_t${turn}`, name: `mcp__hub__${tm[1]}`, input: args }] }, parent_tool_use_id: null, session_id: sid });
    const r = await rpc('tools/call', { name: tm[1], arguments: args });
    const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_t${turn}`, content: t, is_error: !!r.result?.isError }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `도구 결과: ${t}` }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.001, session_id: sid });
    return;
  }

  // "@default 할일" 은 AI 를 지정하지 않고 맡긴다(사람이 고른 기본 작업자)
  const m = mcpUrl && (text.match(/^@(role):(.+?)\s+--\s+([\s\S]+)$/) ?? text.match(/^@(claude|gemini|codex|again|role|default)(?::(\S+))?\s+([\s\S]+)$/));
  if (m) {
    if (turn === 1) await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    const args =
      m[1] === 'again' ? { prompt: m[3], continuation_id: lastContinuation }
      : m[1] === 'role' ? { prompt: m[3], preset: m[2] }
      : m[1] === 'default' ? { prompt: m[3] }
      : { prompt: m[3], cli_name: m[1], ...(m[2] ? { model: m[2] } : {}) };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_c${turn}`, name: 'mcp__hub__clink', input: args }] }, parent_tool_use_id: null, session_id: sid });
    let r = await rpc('tools/call', { name: 'clink', arguments: args });
    // 아직 작업 중이면(승인 대기 등) 이어서 기다린다
    while (r.result?.structuredContent?.status === 'working') {
      r = await rpc('tools/call', { name: 'clink', arguments: { continuation_id: r.result.structuredContent.continuation_id } });
    }
    const textOut = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    lastContinuation = r.result?.structuredContent?.continuation_id ?? lastContinuation;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_c${turn}`, content: textOut, is_error: !!r.result?.isError }] }, parent_tool_use_id: null, session_id: sid });
    // 결과는 "[머리줄]\n\n본문" — 오류 문장처럼 머리줄이 없으면 통째로
    const parts = textOut.split('\n\n');
    const body = parts.length > 1 ? parts.slice(1).join('\n\n') : textOut;
    const reply = `${m[1]} 에게 맡긴 결과를 확인했습니다: ${body}`;
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 20, total_cost_usd: 0.002, session_id: sid });
    return;
  }

  // 연동 확인용: API 키 환경 변수가 들어왔는지(값은 말하지 않음)
  if (text === 'env?') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `env: ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? 'set' : 'unset'} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? 'unset'}` }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0, session_id: sid });
    return;
  }
  // 받은 실행 인자를 그대로 돌려준다(시험에서 플래그 확인용)
  if (text === 'argv?') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `argv: ${argv.slice(2).join(' ')}` }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0, session_id: sid });
    return;
  }

  // 멈춤 시험: 멈출 때까지 기다렸다가 실제 CLI 처럼 error_during_execution 으로 끝난다
  if (/^slow /.test(text)) {
    await new Promise((done) => { abortTurn = done; });
    abortTurn = null;
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 3, total_cost_usd: 0, session_id: sid });
    return;
  }
  if (text === 'exit!') process.exit(3); // CLI 가 꺼짐

  if (/^perm /.test(text)) { // 앞 대화에 붙은 "--permission-mode" 같은 글에는 반응하지 않게 맨 앞만
    const input = { file_path: 'C:/밖/a.txt' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu_q${turn}`, name: 'Read', input }] }, parent_tool_use_id: null, session_id: sid });
    let answer = { behavior: 'deny', message: 'stdio 승인 없음' };
    if (askTool === 'stdio') {
      const request_id = `req-${turn}`;
      answer = await new Promise((done) => {
        waiting.set(request_id, done);
        out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: 'Read', display_name: 'Read', input, description: input.file_path, decision_reason_type: 'workingDir', tool_use_id: `tu_q${turn}` } });
      });
    }
    const ok = answer.behavior === 'allow';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_q${turn}`, content: ok ? `읽음 ${answer.updatedInput?.file_path}` : answer.message, is_error: !ok }] }, parent_tool_use_id: null, session_id: sid });
  }

  if (text.includes('tool')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.txt' } }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '파일 내용 한 줄', is_error: false }] }, parent_tool_use_id: null, session_id: sid });
  }

  const reply = `turn ${turn}${model ? ` [${model}]` : ''}: ${text}`;
  for (const piece of [reply.slice(0, 4), reply.slice(4)]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, session_id: sid });
  }
  // 컨텍스트 사용량: 받은 글이 길수록 많이(차례마다 1000 + 글자 수), 창은 20만
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 * turn + text.length - 10, output_tokens: 0 };
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }], usage }, parent_tool_use_id: null, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 12, total_cost_usd: 0.001, session_id: sid, modelUsage: { 'fake-model': { contextWindow: 200000 } } });
}
