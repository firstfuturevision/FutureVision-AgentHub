#!/bin/sh
# Agent Hub 시작 — 꺼져 있으면 뒤에서 켜고 브라우저로 연다. 켜져 있으면 브라우저만 연다.
cd "$(dirname "$0")" || exit 1
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 없습니다. 22.6 이상을 설치한 뒤 다시 실행하세요: https://nodejs.org"
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)"; then
  echo "Node.js 가 오래됐습니다. 22.6 이상으로 올린 뒤 다시 실행하세요: https://nodejs.org"
  exit 1
fi
echo "Agent Hub 를 켜는 중..."
exec node scripts/launch.mjs --background --open
