# runner-ui — 스테이지 출퇴근 패널

버튼으로 계정별 출근 / 퇴근 / 출퇴근 / 초기화를 실행하고 로그를 실시간으로 보는 로컬 웹 화면. node 내장 모듈만 쓴다.

```bash
npm run ui                      # → http://127.0.0.1:4174/?env=stage&view=attendance
```

Finder 에서 `runner-ui/start.command` 를 더블클릭해도 된다. 끄려면 화면 오른쪽 위 "패널 끄기" 또는 터미널 Ctrl+C.

포트 4174 가 이미 쓰이고 있으면 자동으로 다음 포트(4175…)에서 켜지고 터미널에 주소가 찍힌다. 다른 포트를 쓰려면 `PORT=5000 npm run ui`.

- 줄마다 출근(출근만) · 퇴근(퇴근만) · 출퇴근(출근→퇴근) · 초기화 버튼. 위의 "퇴근 후 초기화" 체크(기본 켬)는 퇴근·출퇴근 뒤 바로 초기화한다.
- 상단 "브라우저 보기(headed)" 토글을 켜면 브라우저를 띄워 실행한다.
- 예약 실행: 명령을 골라 N분 후 / N회 / 간격 N분으로 예약할 수 있다.
- 폴더 버튼은 출퇴근 확인 캡처 폴더(`results/`)를 연다. "패널 끄기"는 Playwright 산출물(.playwright/)과 실행 이력만 지우고 캡처는 남긴다.
- 실행 이력은 `runner-ui/history.json`, 예약은 `runner-ui/schedule.json` (둘 다 git 제외).

## 바탕화면 앱 (선택)

```bash
P="$(pwd)"
printf 'do shell script "open -a Terminal " & quoted form of "%s/runner-ui/start.command"\n' "$P" > /tmp/launcher_stage.applescript
osacompile -o "$HOME/Desktop/stage 자동화 실행 패널.app" /tmp/launcher_stage.applescript
cp runner-ui/icons/stage.icns "$HOME/Desktop/stage 자동화 실행 패널.app/Contents/Resources/applet.icns"
```
