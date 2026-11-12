// 가짜 화면 도우미 — 실제 도우미와 같은 형식. 받은 입력 줄을 파일에 적는다(시험이 확인).
//   argv[2] = 기록 파일, argv[3] = 'raw' 면 리눅스처럼 날 픽셀, 'secure' 면 관리자 확인 창 흉내
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [log, mode] = process.argv.slice(2);
const write = (t, data = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(t, 0, 'ascii');
  head.writeInt32LE(data.length, 1);
  process.stdout.write(Buffer.concat([head, data]));
};
let sent = false; // rawU: 한 번 보낸 뒤로는 U
let lockedFrames = mode === 'locked' ? 1 : 0; // 'locked': 첫 프레임은 잠김(K), 그다음은 풀림
createInterface({ input: process.stdin }).on('line', (line) => {
  const a = line.trim().split(' ');
  if (mode === 'hang' && (a[0] === 'info' || a[0] === 'frame')) return appendFileSync(log, line + '\n'); // 답하지 않는다
  if (a[0] === 'frame' && lockedFrames > 0) { lockedFrames--; return write('K', Buffer.from('화면이 잠겨 있음')); }
  if (a[0] === 'info') return write('J', Buffer.from(JSON.stringify({ monitors: [{ x: 0, y: 0, w: 40, h: 20, primary: true }, { x: 40, y: 0, w: 30, h: 20, primary: false }] })));
  if (a[0] === 'frame') {
    if (mode === 'secure') return write('S');
    if (mode === 'rawU' && sent && a[4] !== 'force') { appendFileSync(log, 'U\n'); return write('U'); } // 화면이 안 바뀜
    if (mode === 'raw' || mode === 'rawU') {
      sent = true;
      // 4×2 화면, 한 줄 16바이트, 커서 (1,0)
      const head = Buffer.alloc(20);
      head.writeUInt32LE(4, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(16, 8); head.writeInt32LE(1, 12); head.writeInt32LE(0, 16);
      return write('R', Buffer.concat([head, Buffer.alloc(32, 200)]));
    }
    return write('F', Buffer.from(`jpeg ${a.slice(1).join(' ')}`));
  }
  if (a[0] === 'bad') return write('L', Buffer.from('무시')); // 답을 기다리지 않는 명령의 실패
  appendFileSync(log, line + '\n');
});
