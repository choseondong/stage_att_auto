#!/bin/zsh
# 더블클릭하면 출퇴근 패널 서버를 켜고 브라우저를 연다. 이미 켜져 있으면 브라우저만 연다. 끝내려면 이 창에서 Ctrl+C 또는 패널의 "패널 끄기".
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-4174}"
URL="http://127.0.0.1:${PORT}/?env=stage&view=attendance"
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "이미 실행 중입니다: $URL"
  open "$URL"
  exit 0
fi
echo "스테이지 출퇴근 패널을 켭니다: $URL"
( sleep 1.2; open "$URL" ) &
PORT="$PORT" node runner-ui/server.js
