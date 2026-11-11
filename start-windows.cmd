@echo off
chcp 65001 >nul
rem Agent Hub 시작 — 꺼져 있으면 뒤에서 켜고 브라우저로 연다. 켜져 있으면 브라우저만 연다.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 없습니다. 22.6 이상을 설치한 뒤 다시 실행하세요.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)"
if errorlevel 1 (
  echo Node.js 가 오래됐습니다. 22.6 이상으로 올린 뒤 다시 실행하세요.
  start "" https://nodejs.org
  pause
  exit /b 1
)
echo Agent Hub 를 켜는 중...
node scripts/launch.mjs --background --open
if errorlevel 1 pause
