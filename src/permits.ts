/**
 * 작업별 권한 "데이터만"(permMode: 'data') — 파일은 못 고치고, 허락한 주소로만 요청을 보낸다.
 * 채팅으로 일을 받는 작업처럼 사람이 승인 버튼을 볼 수 없는 작업에 건다. 묻지 않고 여기서 바로 허용·거절한다.
 *  - 파일 쓰기·고치기 도구와 화면 제어 도구는 CLI 를 띄울 때 아예 뺀다(DATA_DISALLOWED).
 *  - 셸 명령은 읽기 명령과, 허락한 주소(permAllow, 앞부분이 같으면)로 보내는 curl 만. 파일로 쓰기(>, tee, -o)·다른 명령은 거절.
 *  - $( ) 안도 같은 규칙(읽기 명령만 — 예: 토큰 파일 읽기).
 */
export const DATA_DISALLOWED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'mcp__hub__screen_click', 'mcp__hub__screen_drag', 'mcp__hub__screen_scroll', 'mcp__hub__screen_type', 'mcp__hub__screen_key'];

/** 묻지 않고 늘 되는 읽기 도구 */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch']);
/** 셸에서 허용하는 읽기 명령 */
const READ_CMDS = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'rg', 'jq', 'wc', 'echo', 'printf', 'date', 'pwd', 'cd', 'true', 'sort', 'uniq', 'cut', 'tr']);
/** curl 이 파일을 쓰거나 읽어 보내는 옵션 */
const CURL_BAD = /^(-o|--output|-O|--remote-name|--remote-name-all|-T|--upload-file|-K|--config|--output-dir|-D|--dump-header|-c|--cookie-jar)$/;

export interface Verdict { ok: boolean; why: string }

/** 따옴표를 지키며 낱말로 나눈다(대략) */
function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 셸 명령 한 줄이 "데이터만"에서 되는가 */
export function dataBashAllows(command: string, allow: string[], readOnly = false): Verdict {
  let cmd = command.trim();
  if (!cmd) return { ok: false, why: '빈 명령' };
  if (cmd.includes('`')) return { ok: false, why: '` 명령 끼워 넣기는 안 됨' };
  // $( … ) 는 안쪽부터 읽기 명령인지 보고 지운다
  for (let i = 0; i < 20 && /\$\(/.test(cmd); i++) {
    const m = cmd.match(/\$\(([^()]*)\)/);
    if (!m) return { ok: false, why: '$( ) 가 맞지 않음' };
    const inner = dataBashAllows(m[1], allow, true);
    if (!inner.ok) return { ok: false, why: `$( ) 안: ${inner.why}` };
    cmd = cmd.replace(m[0], 'X');
  }
  // 따옴표 밖의 > < & 는 파일 쓰기·읽어 넣기·뒤로 돌리기라 막는다(따옴표 안의 글은 괜찮다)
  const bare = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  if (/[<>]/.test(bare)) return { ok: false, why: '파일로 쓰기·읽어 넣기(> <)는 안 됨' };
  if (/(^|[^&])&($|[^&])/.test(bare)) return { ok: false, why: '뒤에서 돌리기(&)는 안 됨' };
  const segs = bare.split(/\|\||&&|;|\||\n/);
  const realSegs = cmd.split(/\|\||&&|;|\||\n/); // 따옴표 안을 지키며 나누기 위해 같은 자리에서
  if (segs.length !== realSegs.length) return { ok: false, why: '명령을 나눌 수 없음' };
  for (const raw of realSegs) {
    const w = words(raw.trim());
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // 앞의 VAR=값
    if (!w.length) continue;
    const head = w[0].split('/').pop()!;
    if (READ_CMDS.has(head)) continue;
    if (head === 'curl' && !readOnly) {
      if (w.some((x) => CURL_BAD.test(x))) return { ok: false, why: 'curl 로 파일 쓰기·올리기는 안 됨' };
      if (w.some((x) => /^-[a-zA-Z]*[oOTKcD]$/.test(x) && !x.startsWith('--'))) return { ok: false, why: 'curl 로 파일 쓰기·올리기는 안 됨' }; // -so 처럼 붙여 쓴 것도
      if (w.some((x) => /^@/.test(x) || /^--data[a-z-]*=@/.test(x))) return { ok: false, why: 'curl 로 파일 내용 보내기는 안 됨' };
      const urls = w.filter((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(x));
      if (!urls.length) return { ok: false, why: 'curl 주소가 없음' };
      const bad = urls.find((u) => !allow.some((p) => p && u.startsWith(p)));
      if (bad) return { ok: false, why: `허락하지 않은 주소: ${bad.slice(0, 80)}` };
      continue;
    }
    return { ok: false, why: `허락하지 않은 명령: ${head}` };
  }
  return { ok: true, why: '' };
}

/** 도구 하나(묻는 요청)가 "데이터만"에서 되는가 */
export function dataAllows(tool: string | undefined, command: string | undefined, allow: string[]): Verdict {
  if (!tool) return { ok: false, why: '무슨 도구인지 알 수 없음' };
  if (READ_TOOLS.has(tool)) return { ok: true, why: '' };
  if (tool === 'Bash') return dataBashAllows(command ?? '', allow);
  if (tool === 'WebFetch') {
    const u = (command ?? '').trim();
    return allow.some((p) => p && u.startsWith(p)) ? { ok: true, why: '' } : { ok: false, why: `허락하지 않은 주소: ${u.slice(0, 80)}` };
  }
  return { ok: false, why: `데이터만인 작업에서 못 쓰는 도구: ${tool}` };
}
