// 시험용 가짜 ACP 에이전트 — Gemini CLI(--experimental-acp)가 보내는 모양을 흉내 낸다.
// 사용: node fake-acp.mjs [normal|auth|silent]
//  - "write" 가 들어간 질문: 도구 실행 전에 승인 요청 → 허용이면 completed, 거부면 failed
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let turn = 0;
let mcpNames = []; // session/new 로 받은 MCP 서버(시험 확인용)
let nextId = 1000;
const waiting = new Map();
let cancelTurn = null;

const ask = (method, params) => new Promise((ok) => {
  const id = nextId++;
  waiting.set(id, ok);
  out({ jsonrpc: '2.0', id, method, params });
});

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.result ?? { error: m.error });
    waiting.delete(m.id);
    return;
  }
  if (mode === 'silent') return;
  switch (m.method) {
    case 'session/cancel':
      cancelTurn?.();
      return;
    case 'initialize':
      out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
      return;
    case 'session/new':
      if (mode === 'auth') return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } });
      mcpNames = (m.params.mcpServers ?? []).map((s) => `${s.name}(${s.type ?? 'stdio'})`);
      out({
        jsonrpc: '2.0',
        id: m.id,
        result: { sessionId: 'acp-s1', models: { availableModels: [{ modelId: 'fake-pro', name: 'Fake Pro' }, { modelId: 'fake-mini', name: 'Fake Mini' }], currentModelId: 'fake-pro' } },
      });
      return;
    case 'session/prompt': {
      const sid = m.params.sessionId;
      const imgs = m.params.prompt.filter((c) => c.type === 'image').length; const txt0 = m.params.prompt.find((c) => c.type === 'text')?.text ?? ''; const text = imgs ? `[이미지 ${imgs}] ${txt0}` : txt0;
      turn += 1;
      if (text.includes('slow')) {
        await new Promise((done) => { cancelTurn = done; });
        cancelTurn = null;
        out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } });
        return;
      }
      if (text.includes('write')) {
        const r = await ask('session/request_permission', {
          sessionId: sid,
          options: [
            { optionId: 'proceed_always', name: 'Allow All', kind: 'allow_always' },
            { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: { toolCallId: 'w1', status: 'pending', title: 'WriteFile a.txt', kind: 'edit', locations: [{ path: 'a.txt' }], content: [] },
        });
        const allowed = r.outcome?.outcome === 'selected' && r.outcome.optionId === 'proceed_once';
        update(sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'w1',
          status: allowed ? 'completed' : 'failed',
          content: [{ type: 'content', content: { type: 'text', text: allowed ? 'wrote a.txt' : `canceled (${r.outcome?.optionId ?? r.outcome?.outcome})` } }],
        });
      }
      const reply = text === 'mcp?' ? `mcp: ${mcpNames.join(',')}` : `turn ${turn}: ${text}`;
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '생각 중' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, 5) } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(5) } });
      // 광고하지 않은 기능을 요청해 보고, 거절 응답이 오는지 본다
      const fsr = await ask('fs/read_text_file', { sessionId: sid, path: 'x' });
      if (!fsr.error) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' [fs 거절 안 됨]' } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      return;
    }
    default:
      // Gemini 0.23 처럼 session/set_model 등을 모르는 에이전트 흉내
      if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
});
