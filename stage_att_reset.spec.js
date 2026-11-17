import { test, expect } from '@playwright/test';

// 위젯 버튼 문구는 관리자 설정에 따라 바뀐다(출근/ON/IN/시작, 퇴근/OFF/OUT/종료, 휴게 시작·종료/PAUSE). 2026-11-17 스테이지가 ON/OFF 로 바뀌어 반영.
// 문구 대신 버튼의 data-ntm-key(timeclock.clockin / clockout)로 먼저 찾고, 문구는 보조로 모두 허용한다.
const CLOCK_IN_LABEL_PATTERN = /^\s*(출근|ON|IN|시작)\s*$/i;
const CLOCK_OUT_LABEL_PATTERN = /^\s*(퇴근|OFF|OUT|종료)\s*$/i;
const PAUSE_LABEL_PATTERN = /^\s*(휴게 시작|휴게 종료|휴게|PAUSE)\s*$/i;

function clockInButtonOf(buttonArea) {
    return buttonArea.locator('button[data-ntm-key="timeclock.clockin"]')
        .or(buttonArea.getByRole('button', { name: CLOCK_IN_LABEL_PATTERN }))
        .first();
}

function clockOutButtonOf(buttonArea) {
    return buttonArea.locator('button[data-ntm-key="timeclock.clockout"]')
        .or(buttonArea.getByRole('button', { name: CLOCK_OUT_LABEL_PATTERN }))
        .first();
}

// 출근 상태: 위젯의 상태 표시(em.attendance_state 의 on/off 클래스)로 판단한다. 없으면 상태 글자, 그것도 없으면 예전 방식(위젯 글자에 ON)으로 본다.
async function readIsOn(widget, fallbackText = '') {
    const stateElement = widget.locator('.attendance_state').first();

    if (await stateElement.count().catch(() => 0)) {
        const className = (await stateElement.getAttribute('class').catch(() => '')) || '';

        if (/(^|\s)on(\s|$)/.test(className)) {
            return true;
        }

        if (/(^|\s)off(\s|$)/.test(className)) {
            return false;
        }

        const stateText = ((await stateElement.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        return CLOCK_IN_LABEL_PATTERN.test(stateText);
    }

    return /\bON\b/.test(fallbackText);
}

const STAGE_HOME_URL = 'https://stage-home.worksmobile.com/';
const STAGE_COMMUTE_URL_PATTERN = /stage-workplace\.worksmobile\.com\/my-space\/commute\/commuteDetail/;

// 스테이지 출퇴근 위젯 계정은 .env 의 stage_worktest1~6_ID/PW 에서 읽는다 (2026-11-17 사용자 지시: 스테이지 계정은 따로 관리).
// 순서: 1 고정 / 2 선택 / 3 시차 / 4 교대 / 5 탄력 / 6 개인별일정근무
const ATTENDANCE_LABELS = ['낮고정근무', '낮선택근무', '낮시차근무', '낮교대근무', '낮탄력근무', '낮개인별일정근무'];
const allAttendanceAccounts = ATTENDANCE_LABELS.map((label, index) => ({
    label: `work${index + 1}`,
    id: process.env[`stage_worktest${index + 1}_ID`],
    password: process.env[`stage_worktest${index + 1}_PW`],
})).filter((account, index) => {
    if (!account.id || !account.password) {
        console.warn(`[계정 누락] .env 에 ${account.label} 계정(stage_worktest${index + 1}_ID/PW)이 없어 건너뜁니다.`);
        return false;
    }

    return true;
});

// 패널/명령줄에서 일부 계정만 돌리고 싶을 때: STAGE_ATT_ACCOUNTS="1,3" (번호) / "고정,탄력" (이름 일부) / "work1,work5" (아이디 앞부분)
function filterAccountsByEnv(accounts) {
    const raw = (process.env.STAGE_ATT_ACCOUNTS || '').trim();

    if (!raw) {
        return accounts;
    }

    const wanted = raw.split(',').map((item) => item.trim()).filter(Boolean);
    const selected = accounts.filter((account, index) => wanted.some((token) => (
        token === String(index + 1)
        || account.label.includes(token)
        || (account.id || '').startsWith(token)
    )));

    console.log(`[계정 선택] STAGE_ATT_ACCOUNTS=${raw} -> ${selected.map((account) => account.label).join(', ') || '(해당 없음)'}`);
    return selected;
}

const attendanceAccounts = filterAccountsByEnv(allAttendanceAccounts);

async function allowPermissionPrompt(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const allowButton = page
            .getByRole('button', { name: '허용', exact: true })
            .or(page.getByRole('link', { name: '허용', exact: true }))
            .first();

        if (!await allowButton.isVisible({ timeout: 500 }).catch(() => false)) {
            return;
        }

        await allowButton.click({ force: true }).catch(() => {});
        await page.waitForTimeout(150);
    }
}

async function loginWithStageAccount(page, account) {
    await page.goto(STAGE_HOME_URL, { waitUntil: 'domcontentloaded' });
    await allowPermissionPrompt(page);
    await page.fill('#user_id', account.id);
    await page.click('#loginStart');
    await page.fill('#user_pwd', account.password);

    await Promise.all([
        page.waitForURL((url) => (
            url.hostname.endsWith('worksmobile.com') && !url.hostname.includes('auth')
        ), { timeout: 60000 }),
        page.click('#loginBtn'),
    ]);

    await page.goto(STAGE_HOME_URL, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/stage-home\.worksmobile\.com/, { timeout: 60000 });
    await allowPermissionPrompt(page);
}

async function waitForCommutePopupReady(commutePage) {
    await commutePage.waitForLoadState('domcontentloaded');
    await expect(commutePage).toHaveURL(STAGE_COMMUTE_URL_PATTERN, { timeout: 60000 });
    await commutePage
        .waitForFunction(() => !window.jQuery || window.jQuery.active === 0, null, { timeout: 5000 })
        .catch(() => {});
}

async function getAttendanceState(page, account) {
    const attendanceWidget = page.locator('.widget_cover[data-widget-code="WG_006"]').first();
    await expect(attendanceWidget, `${account.label} 출퇴근 위젯`).toBeVisible({ timeout: 60000 });

    const attendanceButtonArea = attendanceWidget.locator('.attendance_btn_area').first();

    return {
        attendanceWidget,
        clockInButton: clockInButtonOf(attendanceButtonArea),
        isOn: await readIsOn(attendanceWidget, await attendanceWidget.innerText().catch(() => '')),
    };
}

async function resetAttendanceFromWidget(page, account, state) {
    if (!state.isOn && await state.clockInButton.isEnabled({ timeout: 1000 }).catch(() => false)) {
        console.log(`${account.label} 이미 초기화된 상태이며 출근 버튼이 활성화되어 있습니다.`);
        return true;
    }

    const editTimeButton = state.attendanceWidget.locator('.btn_time_set').first();

    if (!await editTimeButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        throw new Error(`${account.label} 초기화 버튼과 출근 버튼을 확인하지 못했습니다.`);
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await editTimeButton.click().catch(() => {});
    const commutePage = await popupPromise;

    if (!commutePage) {
        console.log(`${account.label} 출퇴근 상세 팝업이 없어 다음 계정으로 넘어갑니다.`);
        return true;
    }

    try {
        await waitForCommutePopupReady(commutePage);
        const initButton = commutePage.locator('#btn_init');

        if (!await initButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log(`${account.label} 초기화 버튼이 없어 다음 계정으로 넘어갑니다.`);
            return true;
        }

        await initButton.click({ force: true });

        const confirmButton = commutePage
            .locator('.modal.show:visible button:visible, .modal.show:visible a:visible, [role="dialog"] button:visible, [role="dialog"] a:visible')
            .filter({ hasText: /확인|초기화/ })
            .last();
        await expect(confirmButton, `${account.label} 출퇴근 초기화 확인 버튼`).toBeVisible({ timeout: 10000 });

        const initResponse = commutePage.waitForResponse((response) => (
            response.url().includes('/my-space/commute/init') && response.status() === 200
        ), { timeout: 10000 }).then((response) => response.json()).catch(() => null);

        await confirmButton.click({ force: true });
        const initBody = await initResponse;

        if (!initBody?.success) {
            throw new Error(`${account.label} 초기화 응답 실패: ${JSON.stringify(initBody)}`);
        }

        console.log(`${account.label} 출퇴근 초기화 완료`);
    } finally {
        await commutePage.close().catch(() => {});
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedWidget = page.locator('.widget_cover[data-widget-code="WG_006"]').first();
    const reloadedClockInButton = clockInButtonOf(reloadedWidget.locator('.attendance_btn_area'));
    await expect(reloadedClockInButton, `${account.label} 초기화 후 출근 버튼`)
        .toBeEnabled({ timeout: 30000 });
    console.log(`${account.label} 초기화 후 출근 버튼 활성화 확인`);
    return true;
}

test.describe('스테이지 출퇴근 초기화', () => {
    test('work1부터 work6까지 출퇴근 초기화', async ({ browser }) => {
        test.setTimeout(900000);
        const failures = [];

        for (const account of attendanceAccounts) {
            await test.step(`${account.label} 출퇴근 초기화`, async () => {
                const context = await browser.newContext({
                    locale: 'ko-KR',
                    permissions: ['geolocation', 'notifications'],
                    geolocation: { latitude: 37.5665, longitude: 126.9780 },
                });
                const page = await context.newPage();
                page.on('dialog', async (dialog) => {
                    await dialog.accept().catch(() => {});
                });

                try {
                    console.log(`${account.label} 로그인 및 출퇴근 초기화 시작`);
                    await loginWithStageAccount(page, account);
                    const state = await getAttendanceState(page, account);
                    await resetAttendanceFromWidget(page, account, state);
                } catch (error) {
                    failures.push(`${account.label}: ${error.message}`);
                    console.error(`${account.label} 실패 후 다음 계정으로 진행: ${error.message}`);
                } finally {
                    await context.close();
                }
            });
        }

        expect(failures, failures.join('\n')).toEqual([]);
    });
});
