// 시험용 가짜 gh — GH_CONFIG_DIR/hosts.yml 이 있으면 로그인된 것으로 본다
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).join(' ');
const hosts = join(process.env.GH_CONFIG_DIR ?? '.', 'hosts.yml');

if (args === '--version') {
  console.log('gh version 9.9.9 (2026-01-01)');
} else if (args.startsWith('auth status')) {
  console.log(JSON.stringify({ hosts: existsSync(hosts) ? { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'fv-bot' }] } : {} }));
} else if (args.startsWith('auth login')) {
  process.stderr.write('! One-time code (ABCD-1234) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
  // 사람이 승인한 셈 치고 잠시 뒤 로그인 완료
  setTimeout(() => writeFileSync(hosts, 'github.com:\n  user: fv-bot\n'), 400);
} else if (args.startsWith('auth logout')) {
  rmSync(hosts, { force: true });
} else {
  process.exit(1);
}
