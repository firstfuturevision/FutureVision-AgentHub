import { parseCommand } from '../protocol.ts';
import type { SessionManager } from '../sessions.ts';

export interface DashboardOptions {
  enabled: boolean;
  url: string; // 예: wss://<대시보드 주소>/ws/agent-host/  (대시보드 쪽 구현 필요)
  tokenEnv: string; // 워커 전용 계정 토큰을 담은 환경 변수 이름
}

/**
 * 대시보드 연결 (스텁). 호스트가 먼저 접속해 연결을 유지하고(아웃바운드),
 * 대시보드는 폰 브라우저와 이 연결 사이를 실시간으로 중계한다.
 *
 * 주고받는 봉투 (대시보드 쪽 구현이 맞춰야 할 계약):
 *   대시보드 → 호스트 {kind:'command', user:'<로그인한 직원>', command: ClientCommand}
 *   호스트 → 대시보드 {kind:'event', event: HostEvent}
 * 로그인·권한 확인은 대시보드 몫이다. 호스트는 대시보드가 보낸 user 를 기록에 남긴다.
 */
export function startDashboardLink(opts: DashboardOptions, sessions: SessionManager): () => void {
  if (!opts.enabled) {
    console.log('[dashboard] 꺼짐 — config.json 의 dashboard.enabled 로 켠다');
    return () => {};
  }
  const token = process.env[opts.tokenEnv];
  if (!token) {
    console.warn(`[dashboard] 환경 변수 ${opts.tokenEnv} 가 없어 연결하지 않음`);
    return () => {};
  }

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  let unsubscribe = () => {};

  const connect = () => {
    // 브라우저 표준 WebSocket(Node 22 내장)은 헤더를 못 붙여서 토큰을 첫 메시지로 보낸다.
    ws = new WebSocket(opts.url);
    ws.addEventListener('open', () => {
      retry = 1000;
      ws!.send(JSON.stringify({ kind: 'hello', token, role: 'agent-host' }));
      unsubscribe = sessions.subscribe((event) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ kind: 'event', event })));
      console.log('[dashboard] 연결됨');
    });
    ws.addEventListener('message', (msg) => {
      let env: any;
      try {
        env = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (env?.kind !== 'command' || typeof env.user !== 'string') return;
      const cmd = parseCommand(env.command);
      if (cmd) void sessions.handle(cmd, { via: 'dashboard', user: env.user });
    });
    ws.addEventListener('close', () => {
      unsubscribe();
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60000);
    });
    ws.addEventListener('error', () => {}); // close 에서 재접속
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
