#!/usr/bin/env node
// 단축 지시 실행 UI 서버. node 내장 모듈만 쓴다.
//   node runner-ui/server.js            → http://127.0.0.1:4173
//   PORT=5000 node runner-ui/server.js
// 버튼 정의는 runner-ui/commands.json, 실행 이력은 runner-ui/history.json 에 쌓인다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// .env 는 서버 환경에 주입하지 않고(테스트 프로세스가 직접 읽음) 패널 표시용으로만 파싱한다.
function readDotEnv() {
    try {
        const dotenv = require('dotenv');
        return dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
    } catch {
        return {};
    }
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMMANDS_FILE = path.join(__dirname, 'commands.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const PORT = Number(process.env.PORT) || 4174;
const HOST = '127.0.0.1';
const MAX_HISTORY = 50;
const MAX_LOG_LINES = 4000;

// ===== 명령 정의 =====
function loadCommands() {
    const data = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf-8'));
    const byId = new Map();

    for (const group of data.groups) {
        for (const command of group.commands) {
            byId.set(command.id, { ...command, groupId: group.id, groupTitle: group.title });
        }
    }

    return { data, byId };
}

// ===== 이력 =====
function loadHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, MAX_HISTORY), null, 2));
}

// ===== 실행 상태 =====
const state = {
    current: null, // { id, label, startedAt, child, headed, logLines }
    clients: new Set(),
    schedules: loadSchedules(), // [{ sid, commandId, label, groupTitle, headed, runAt, remaining, intervalMinutes, createdAt }]
};

// ===== 예약 =====
function loadSchedules() {
    try {
        return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function saveSchedules() {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(state.schedules, null, 2));
}

function schedulesPayload() {
    return { type: 'schedules', schedules: state.schedules.map((item) => ({ ...item })) };
}

function addSchedule(command, { delayMinutes, headed, repeatCount, intervalMinutes }) {
    const delay = Math.max(0, Number(delayMinutes) || 0);
    const repeat = Math.max(1, Math.min(50, Number(repeatCount) || 1));
    const interval = Math.max(1, Number(intervalMinutes) || 20);
    const schedule = {
        sid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        commandId: command.id,
        label: command.label,
        groupTitle: command.groupTitle,
        headed: Boolean(headed) && !command.noHeaded,
        runAt: new Date(Date.now() + delay * 60000).toISOString(),
        remaining: repeat,
        total: repeat,
        intervalMinutes: interval,
        createdAt: new Date().toISOString(),
    };
    state.schedules.push(schedule);
    saveSchedules();
    broadcast(schedulesPayload());
    return schedule;
}

function cancelSchedule(sid) {
    const before = state.schedules.length;
    state.schedules = state.schedules.filter((item) => item.sid !== sid);

    if (state.schedules.length === before) {
        return { error: '해당 예약이 없습니다.' };
    }

    saveSchedules();
    broadcast(schedulesPayload());
    return { ok: true };
}

// 5초마다 시간이 된 예약을 확인한다. 실행 중이면 끝날 때까지 기다렸다가 돌린다.
function tickSchedules() {
    if (state.current || state.schedules.length === 0) {
        return;
    }

    const now = Date.now();
    const due = state.schedules
        .filter((item) => new Date(item.runAt).getTime() <= now)
        .sort((a, b) => new Date(a.runAt) - new Date(b.runAt))[0];

    if (!due) {
        return;
    }

    const { byId } = loadCommands();
    const command = byId.get(due.commandId);

    if (!command) {
        pushLog(`예약 취소: 명령 "${due.label}" 이(가) 더 이상 없습니다.`);
        cancelSchedule(due.sid);
        return;
    }

    const result = startRun(command, { headed: due.headed, scheduled: due });

    if (result.error) {
        return;
    }

    due.remaining -= 1;

    if (due.remaining > 0) {
        // 다음 회차는 "이번 실행 종료 시각 + 간격" 으로 잡는다 (close 핸들러에서 확정)
        state.current.schedule = due;
    } else {
        state.schedules = state.schedules.filter((item) => item.sid !== due.sid);
    }

    saveSchedules();
    broadcast(schedulesPayload());
}

setInterval(tickSchedules, 5000);

function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of state.clients) {
        client.write(payload);
    }
}

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const NOISE_PATTERN = /injected env|dotenv@|^\s*$/;

function pushLog(line) {
    const clean = line.replace(ANSI_PATTERN, '').replace(/\r/g, '');

    if (NOISE_PATTERN.test(clean)) {
        return;
    }

    if (state.current) {
        state.current.logLines.push(clean);

        if (state.current.logLines.length > MAX_LOG_LINES) {
            state.current.logLines.splice(0, state.current.logLines.length - MAX_LOG_LINES);
        }
    }

    broadcast({ type: 'log', line: clean });
}

function summarize(logLines) {
    const text = logLines.join('\n');
    const pick = (pattern) => {
        const match = pattern.exec(text);
        return match ? Number(match[1]) : 0;
    };

    return {
        passed: pick(/(\d+) passed/),
        failed: pick(/(\d+) failed/),
        skipped: pick(/(\d+) skipped/),
        flaky: pick(/(\d+) flaky/),
        didNotRun: pick(/(\d+) did not run/),
    };
}

function statusPayload() {
    const { current } = state;

    return {
        type: 'status',
        running: Boolean(current),
        current: current ? {
            id: current.id,
            label: current.label,
            headed: current.headed,
            startedAt: current.startedAt,
            command: current.commandLine,
        } : null,
    };
}

function startRun(command, options) {
    if (state.current) {
        return { error: `이미 "${state.current.label}" 이(가) 실행 중입니다. 끝나거나 중지한 뒤 다시 눌러 주세요.` };
    }

    const headed = command.noHeaded ? false : Boolean(options.headed);
    const args = ['playwright', 'test', ...command.args, ...(headed ? ['--headed'] : [])];
    // 패널에서 넘긴 환경변수는 허용된 접두사(STAGE_ATT_, TC_)만 받는다.
    const extraEnv = Object.fromEntries(Object.entries(options.env || {})
        .filter(([key, value]) => /^(STAGE_ATT_|TC_)[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value.length <= 200));
    const env = { ...process.env, ...(command.env || {}), ...extraEnv, FORCE_COLOR: '0' };
    const envNote = Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`).join(' ');
    const commandLine = `${envNote ? `${envNote} ` : ''}npx ${args.join(' ')}`;
    const displayLabel = typeof options.label === 'string' && options.label.trim() ? options.label.trim().slice(0, 80) : command.label;

    const child = spawn('npx', args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = {
        id: command.id,
        label: displayLabel,
        groupTitle: command.groupTitle,
        headed,
        startedAt: new Date().toISOString(),
        commandLine,
        child,
        logLines: [],
    };
    state.current = run;

    broadcast(statusPayload());
    const scheduledNote = options.scheduled ? ` [예약 ${options.scheduled.total - options.scheduled.remaining + 1}/${options.scheduled.total}회차]` : '';
    pushLog(`▶ ${command.groupTitle} > ${displayLabel} 시작 (${headed ? '브라우저 보기' : 'headless'})${scheduledNote}`);
    pushLog(`$ ${commandLine}`);

    let buffer = '';
    const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(pushLog);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('close', (code, signal) => {
        if (buffer) {
            pushLog(buffer);
        }

        const endedAt = new Date().toISOString();
        const summary = summarize(run.logLines);
        const stopped = signal === 'SIGTERM' || signal === 'SIGKILL' || run.stopped;
        const result = stopped ? 'stopped' : code === 0 ? 'passed' : 'failed';
        pushLog(stopped
            ? `■ 중지됨 (${run.label})`
            : `■ 종료 (exit ${code}) — 통과 ${summary.passed}, 실패 ${summary.failed}, 건너뜀 ${summary.skipped}${summary.didNotRun ? `, 미실행 ${summary.didNotRun}` : ''}`);

        const history = loadHistory();
        history.unshift({
            id: run.id,
            label: run.label,
            groupTitle: run.groupTitle,
            headed,
            startedAt: run.startedAt,
            endedAt,
            durationSec: Math.round((new Date(endedAt) - new Date(run.startedAt)) / 1000),
            exitCode: code,
            result,
            summary,
            commandLine,
        });
        saveHistory(history);

        if (run.schedule && run.schedule.remaining > 0) {
            run.schedule.runAt = new Date(Date.now() + run.schedule.intervalMinutes * 60000).toISOString();
            saveSchedules();
            pushLog(`⏰ 다음 회차(${run.schedule.total - run.schedule.remaining + 1}/${run.schedule.total}) 예약: ${run.schedule.intervalMinutes}분 뒤`);
            broadcast(schedulesPayload());
        }

        state.current = null;
        broadcast({ type: 'done', run: history[0] });
        broadcast(statusPayload());
    });

    child.on('error', (error) => {
        pushLog(`실행 오류: ${error.message}`);
    });

    return { ok: true, run: statusPayload().current };
}

function stopRun() {
    const { current } = state;

    if (!current) {
        return { error: '실행 중인 작업이 없습니다.' };
    }

    current.stopped = true;
    pushLog('■ 중지 요청 — 브라우저와 테스트 프로세스를 종료합니다.');

    try {
        // detached 로 띄웠으므로 프로세스 그룹 전체(npx → playwright → 브라우저)를 종료한다.
        process.kill(-current.child.pid, 'SIGTERM');
    } catch (error) {
        current.child.kill('SIGTERM');
    }

    setTimeout(() => {
        if (state.current === current) {
            try {
                process.kill(-current.child.pid, 'SIGKILL');
            } catch {
                /* 이미 종료됨 */
            }
        }
    }, 5000);

    return { ok: true };
}

function openFolder(relativeDir) {
    const dir = path.resolve(ROOT, relativeDir);

    if (!dir.startsWith(ROOT)) {
        return { error: '프로젝트 밖의 폴더는 열 수 없습니다.' };
    }

    fs.mkdirSync(dir, { recursive: true });
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, dir };
}

// 결과 초기화: commands.json 의 cleanupOnShutdown 폴더 내용을 비우고 실행 이력을 지운다.
function cleanupResults() {
    const { data } = loadCommands();
    const dirs = Array.isArray(data.cleanupOnShutdown) ? data.cleanupOnShutdown : [];
    const cleared = [];
    let removedFiles = 0;

    for (const relative of dirs) {
        const dir = path.resolve(ROOT, relative);

        if (!dir.startsWith(ROOT + path.sep) || !fs.existsSync(dir)) {
            continue;
        }

        for (const entry of fs.readdirSync(dir)) {
            const target = path.join(dir, entry);
            const stat = fs.lstatSync(target);
            removedFiles += stat.isDirectory() ? countFiles(target) : 1;
            fs.rmSync(target, { recursive: true, force: true });
        }

        cleared.push(relative);
    }

    saveHistory([]);
    console.log(`결과 초기화: ${cleared.join(', ') || '(대상 폴더 없음)'} / 파일 ${removedFiles}개 삭제, 실행 이력 삭제`);
    return { ok: true, cleared, removedFiles };
}

function countFiles(dir) {
    let count = 0;

    for (const entry of fs.readdirSync(dir)) {
        const target = path.join(dir, entry);
        count += fs.lstatSync(target).isDirectory() ? countFiles(target) : 1;
    }

    return count;
}

function openReport() {
    spawn('npx', ['playwright', 'show-report', '.playwright/report'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
}

// ===== HTTP =====
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                resolve({});
            }
        });
    });
}

function serveStatic(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);

    if (url.pathname === '/api/commands') {
        const { data } = loadCommands();
        const history = loadHistory();
        const lastById = {};

        for (const entry of history) {
            if (!lastById[entry.id]) {
                lastById[entry.id] = entry;
            }
        }

        const dotEnv = readDotEnv();

        for (const group of data.groups) {
            for (const account of group.accounts || []) {
                account.id = dotEnv[account.envId] || '';
            }
        }

        return sendJson(res, 200, { groups: data.groups, lastById, root: ROOT });
    }

    if (url.pathname === '/api/status') {
        return sendJson(res, 200, { ...statusPayload(), logLines: state.current ? state.current.logLines : [] });
    }

    if (url.pathname === '/api/history') {
        return sendJson(res, 200, loadHistory());
    }

    if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(statusPayload())}\n\n`);
        res.write(`data: ${JSON.stringify(schedulesPayload())}\n\n`);

        if (state.current) {
            res.write(`data: ${JSON.stringify({ type: 'log-bulk', lines: state.current.logLines })}\n\n`);
        }

        state.clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
            clearInterval(heartbeat);
            state.clients.delete(res);
        });
        return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readBody(req);
        const { byId } = loadCommands();
        const command = byId.get(body.id);

        if (!command) {
            return sendJson(res, 404, { error: `알 수 없는 명령: ${body.id}` });
        }

        const result = startRun(command, { headed: body.headed, env: body.env, label: body.label });
        return sendJson(res, result.error ? 409 : 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
        const result = stopRun();
        return sendJson(res, result.error ? 409 : 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
        const body = await readBody(req);
        const { byId } = loadCommands();
        const command = byId.get(body.id);

        if (!command || !command.resultsDir) {
            return sendJson(res, 404, { error: '결과 폴더가 정의되지 않은 명령입니다.' });
        }

        return sendJson(res, 200, openFolder(command.resultsDir));
    }

    if (req.method === 'POST' && url.pathname === '/api/open-report') {
        return sendJson(res, 200, openReport());
    }

    if (url.pathname === '/api/schedules') {
        return sendJson(res, 200, state.schedules);
    }

    if (req.method === 'POST' && url.pathname === '/api/schedule') {
        const body = await readBody(req);
        const { byId } = loadCommands();
        const command = byId.get(body.id);

        if (!command) {
            return sendJson(res, 404, { error: `알 수 없는 명령: ${body.id}` });
        }

        return sendJson(res, 200, { ok: true, schedule: addSchedule(command, body) });
    }

    if (req.method === 'POST' && url.pathname === '/api/schedule/cancel') {
        const body = await readBody(req);
        const result = cancelSchedule(body.sid);
        return sendJson(res, result.error ? 404 : 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/cleanup') {
        if (state.current) {
            return sendJson(res, 409, { error: '테스트가 실행 중일 때는 초기화할 수 없습니다. 먼저 중지해 주세요.' });
        }

        return sendJson(res, 200, cleanupResults());
    }

    // 패널 끄기: 실행 중인 테스트가 있으면 먼저 중지하고, 결과(오류 스크린샷·이력)를 비운 뒤 서버를 종료한다. (2026-11-14 사용자 지시)
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (state.current) {
            stopRun();
        }

        const cleanup = cleanupResults();
        sendJson(res, 200, { ok: true, cleanup });
        console.log('패널 끄기 요청으로 서버를 종료합니다.');
        setTimeout(() => process.exit(0), 700);
        return undefined;
    }

    return serveStatic(req, res);
});

// 포트가 이미 쓰이고 있으면(다른 패널이 켜져 있는 경우 등) 안내하고 다음 포트로 옮겨 띄운다.
let listenPort = PORT;
let listenAttempts = 0;

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && listenAttempts < 10) {
        console.log(`포트 ${listenPort} 은(는) 이미 사용 중입니다 (다른 패널이 켜져 있을 수 있습니다: http://${HOST}:${listenPort}). 다음 포트로 옮깁니다.`);
        listenPort += 1;
        listenAttempts += 1;
        setTimeout(() => server.listen(listenPort, HOST), 200);
        return;
    }

    console.error(`서버를 켤 수 없습니다: ${error.message}`);
    process.exit(1);
});

server.listen(listenPort, HOST, () => {
    console.log(`단축 지시 실행 UI: http://${HOST}:${listenPort}  (프로젝트: ${ROOT})`);

    if (listenPort !== PORT) {
        console.log(`※ 기본 포트 ${PORT} 대신 ${listenPort} 에서 켜졌습니다. 브라우저에서 위 주소를 열어 주세요.`);
    }

    console.log('종료하려면 Ctrl+C 또는 패널의 "패널 끄기"');

    // 켜지면 브라우저를 연다 (NO_OPEN=1 이면 열지 않음). 여는 경로는 commands.json 의 openPath.
    if (process.env.NO_OPEN !== '1') {
        let openPath = '/';

        try {
            openPath = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf-8')).openPath || '/';
        } catch {
            /* 기본 경로 사용 */
        }

        const url = `http://${HOST}:${listenPort}${openPath}`;
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        spawn(opener, openerArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        console.log(`브라우저에서 열었습니다: ${url}`);
    }
});

process.on('SIGINT', () => {
    if (state.current) {
        stopRun();
    }

    setTimeout(() => process.exit(0), 300);
});
