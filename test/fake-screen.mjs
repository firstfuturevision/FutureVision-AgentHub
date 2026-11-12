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
createInterface({ input: process.stdin }).on('line', (line) => {
  const a = line.trim().split(' ');
  if (a[0] === 'info') return write('J', Buffer.from(JSON.stringify({ monitors: [{ x: 0, y: 0, w: 40, h: 20, primary: true }, { x: 40, y: 0, w: 30, h: 20, primary: false }] })));
  if (a[0] === 'frame') {
    if (mode === 'secure') return write('S');
    if (mode === 'raw') {
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
