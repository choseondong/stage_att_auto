# stage_att_auto

네이버 WORKS **스테이지** 홈의 출퇴근 위젯을 계정 6개(고정/선택/시차/교대/탄력/개인별일정근무)로 자동 실행하는 Playwright 테스트 두 개.

| 파일 | 하는 일 |
| --- | --- |
| `stage_att.spec.js` | 계정별 로그인 → 출근 → 퇴근(옵션으로 뒤이어 초기화). 결과 캡처는 `results/` |
| `stage_att_reset.spec.js` | 계정별 출퇴근 기록 초기화 (다시 출근할 수 있는 상태로 되돌림) |

위젯 버튼 문구가 관리자 설정에 따라 달라도(출근/ON/IN/시작, 퇴근/OFF/OUT/종료, PAUSE) 동작한다.

## 설치

```bash
git clone https://github.com/choseondong/stage_att_auto.git
cd stage_att_auto
npm install
npx playwright install chromium
cp .env.example .env      # 계정 값을 채운다
```

## 실행

```bash
npm run att             # 여섯 계정 출근 → 퇴근 (headless)
npm run att:headed      # 브라우저를 보면서
npm run reset           # 여섯 계정 초기화
```

일부 계정만, 또는 모드를 바꿔서:

```bash
STAGE_ATT_ACCOUNTS=1,5 npm run att                 # 1번(고정)·5번(탄력)만
STAGE_ATT_MODE=in npm run att                      # 출근만
STAGE_ATT_MODE=out STAGE_ATT_RESET_AFTER=1 npm run att   # 퇴근만 하고 바로 초기화
STAGE_ATT_ACCOUNTS=고정 npm run reset              # 이름 일부로도 지정 가능
```

| 환경변수 | 값 | 뜻 |
| --- | --- | --- |
| `STAGE_ATT_ACCOUNTS` | `1,3` / `고정,탄력` / `work1` | 돌릴 계정 (번호, 이름 일부, 아이디 앞부분). 없으면 전부 |
| `STAGE_ATT_MODE` | `in` / `out` / `both` | 출근만 / 퇴근만 / 출근 후 퇴근 (기본 both) |
| `STAGE_ATT_RESET_AFTER` | `1` | 퇴근을 마친 계정을 바로 초기화 (출근만 모드에는 적용 안 함) |

## 패널로 실행 (버튼)

```bash
npm run ui        # 또는 runner-ui/start.command 더블클릭
```

브라우저에 계정 6개가 표로 뜨고, 줄마다 출근 / 퇴근 / 출퇴근 / 초기화 버튼이 있다. 자세한 건 `runner-ui/README.md`.

## 알아 둘 것

- 사내 IP 제한이 있는 계정은 "현재 IP 주소에서는 출퇴근을 체크할 수 없습니다" 토스트 캡처를 남기고 건너뛴다.
- 탄력근무처럼 출근만 기록하는 근무제는 퇴근 버튼이 없어 출근만으로 정상 처리한다.
- 모든 계정이 건너뛰어져 처리 0건이면 실패로 끝난다(위젯 구조나 계정 상태 확인 신호).
- 실패 캡처·리포트는 `.playwright/` 아래에 생기며 git 에 올라가지 않는다.
