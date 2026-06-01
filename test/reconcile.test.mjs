// odpeek v0.2 단계 1 통합테스트 보강 — 고아 cloudflared 회수(reconcile) + false-negative 종료 breadcrumb.
// 외부 의존성 없이 node:assert/strict + stdlib만 쓰는 standalone 실행 파일(기존 smoke.mjs / timing.test.mjs 스타일).
// 통과 시 각 케이스에 PASS를 출력하고 마지막에 exit 0, 실패 시 exit 1.
//
// 시나리오(계획서 §2.4·§2.5·§4):
//   (R1) false-negative 고아 exit + breadcrumb:
//        __exposeInternals로 scheduleShutdown을 in-process로 얻고, tunnel.json의 cfPid를
//        살아있지만 cloudflared가 아닌 PID로 세팅 → processMatches 불일치(matched=false) →
//        (a) exitFn 호출 (b) clearTunnel 실행(tunnel.json 제거) (c) auth.log에
//        `TUNNEL_KILL cfPid=<N> matched=false`가 정확히 1회 기록됨을 단언.
//   (R2) reconcile auto-kill:
//        readTunnel()===null 상태에서 `--url http://localhost:<authPort>` argv를 가진
//        더미 "cloudflared-유사" 프로세스를 실제 spawn → reconcileOrphanTunnel이 협소 시그니처
//        일치로 그 PID를 kill함을 단언(이후 isAlive로 사망 확인).
//   (R3) reconcile report-only(불일치):
//        `--url http://localhost:<다른포트>` argv를 가진 더미 프로세스 →
//        reconcileOrphanTunnel이 kill하지 않고 생존함을 단언(무차별 kill 안 함 증명).
//   (R4) reconcile 두 열거기 동시 실패:
//        listCandidates 주입이 null을 반환(pgrep·ps 둘 다 실패 조건) → 크래시 없음(throw 안 함) +
//        report-only no-kill + 수동 점검 힌트 출력 단언.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';

import { reconcileOrphanTunnel } from '../src/cli.mjs';
import { runAuthProxy } from '../src/authProxy.mjs';

const USER = 'od';
const PASS = 's3cret-pass';

// readTunnel/saveTunnel/clearTunnel과 인증 프록시 로그는 고정 경로(~/.odpeek/{tunnel.json,auth.log})를 쓴다.
// 통합 테스트가 이 파일들을 만들고 지우므로, 사용자 상태를 백업했다가 끝에 반드시 복원한다(클로버 금지).
const STATE_DIR = join(homedir(), '.odpeek');
const STATE_FILE = join(STATE_DIR, 'tunnel.json');
const AUTH_LOG = join(STATE_DIR, 'auth.log');
const TUNNEL_BACKUP = join(tmpdir(), `odpeek-reconcile-tunnel-backup-${process.pid}.json`);
const AUTH_LOG_BACKUP = join(tmpdir(), `odpeek-reconcile-authlog-backup-${process.pid}.log`);
let hadTunnel = false;
let hadAuthLog = false;

/** 사용자 tunnel.json·auth.log를 백업하고 상태 디렉토리를 보장한다. */
function backupUserState() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(STATE_FILE)) {
    hadTunnel = true;
    copyFileSync(STATE_FILE, TUNNEL_BACKUP);
  }
  if (existsSync(AUTH_LOG)) {
    hadAuthLog = true;
    copyFileSync(AUTH_LOG, AUTH_LOG_BACKUP);
  }
}

/** 백업한 사용자 상태를 복원하고(없었으면 제거) 임시 백업 파일을 정리한다. */
function restoreUserState() {
  if (hadTunnel) {
    copyFileSync(TUNNEL_BACKUP, STATE_FILE);
    rmSync(TUNNEL_BACKUP, { force: true });
  } else if (existsSync(STATE_FILE)) {
    rmSync(STATE_FILE, { force: true });
  }
  if (hadAuthLog) {
    copyFileSync(AUTH_LOG_BACKUP, AUTH_LOG);
    rmSync(AUTH_LOG_BACKUP, { force: true });
  } else if (existsSync(AUTH_LOG)) {
    rmSync(AUTH_LOG, { force: true });
  }
}

/** OS가 비어있는 TCP 포트를 골라 반환한다. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 더미 upstream(OD 역할) HTTP 서버를 띄운다. */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok-upstream');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** 해당 PID가 살아있는지 확인한다(테스트 로컬 헬퍼 — signal 0). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID가 죽을 때까지 짧게 폴링한다(kill 비동기 반영 대비). */
async function waitDead(pid, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

/**
 * 더미 "cloudflared-유사" 프로세스를 실제 spawn한다.
 * 실제 cloudflared 바이너리 없이도 동일한 argv 시그니처(`--url http://localhost:<port>`)를
 * 가지도록, node에 'cloudflared' 문자열과 그 argv를 함께 실어 sleep시킨다.
 * processMatches는 ps -ww의 전체 명령줄을 includes로 검사하므로(tunnel.mjs:114), argv에 시그니처가
 * 들어가면 odpeek가 띄운 것으로 식별된다(R2는 일치, R3는 불일치 포트로 검증).
 * @param {number} urlPort `--url http://localhost:<urlPort>`에 들어갈 포트
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnCloudflaredLike(urlPort) {
  // 첫 인자로 'tunnel'·'--url ...'을 명령줄에 실어 processMatches가 시그니처를 찾도록 한다.
  // 'cloudflared' 토큰도 함께 실어 listCloudflaredCandidates의 후보 수집 로직과도 정합하게 둔다.
  return spawn(
    process.execPath,
    ['-e', 'setTimeout(()=>{}, 60000)', 'cloudflared', 'tunnel', '--url', `http://localhost:${urlPort}`],
    { stdio: 'ignore' },
  );
}

/** 자식 프로세스의 종료를 기다린다(타임아웃 무시). */
function waitExit(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ============================== R1 ==============================

/**
 * (R1) false-negative 고아 exit + durable breadcrumb.
 * scheduleShutdown을 in-process로 구동하되 exitFn을 스텁해 실제 프로세스 종료를 막는다.
 * cfPid를 살아있는 무관 PID(비-cloudflared)로 세팅 → processMatches 불일치 → matched=false →
 * kill은 건너뛰지만 (a)exitFn 호출 (b)clearTunnel (c)TUNNEL_KILL ... matched=false 1회 기록.
 */
async function testFalseNegativeOrphanBreadcrumb() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();

  // 무관한 살아있는 프로세스(node sleep). 이 PID는 cloudflared가 아니므로 processMatches가 false.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200)); // bystander가 뜰 시간
  assert.ok(bystander.pid > 0, 'bystander PID 확보');

  // auth.log를 비운 상태에서 시작해 TUNNEL_KILL 라인을 깨끗이 카운트한다(백업은 main에서 이미 수행).
  rmSync(AUTH_LOG, { force: true });
  // cfPid를 bystander로 위장. processMatches('cloudflared') 불일치 → matched=false.
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ cfPid: bystander.pid, authPort: listenPort, targetPort, url: null }),
    { mode: 0o600 },
  );

  let exitCalls = 0;
  let scheduleShutdown = null;
  let server = null;
  // logFile을 실제 ~/.odpeek/auth.log로 지정해 breadcrumb 기록 경로를 그대로 검증한다.
  runAuthProxy(listenPort, targetPort, USER, PASS, {
    idleMs: 0,
    ttlMs: 0,
    logFile: AUTH_LOG,
    exitFn: () => { exitCalls += 1; },
    __exposeInternals: (internals) => {
      scheduleShutdown = internals.scheduleShutdown;
      server = internals.server;
    },
  });

  try {
    assert.equal(typeof scheduleShutdown, 'function', 'scheduleShutdown이 노출되어야 함');
    assert.equal(existsSync(STATE_FILE), true, 'scheduleShutdown 전 tunnel.json 존재');
    assert.equal(isAlive(bystander.pid), true, 'scheduleShutdown 전 bystander 생존');

    scheduleShutdown('TTL_SHUTDOWN after 0min cap');

    // (a) exitFn 호출(스텁이 실제 exit을 막으므로 카운트로 관측).
    assert.equal(exitCalls, 1, '(a) false-negative여도 exitFn이 호출되어야 함');
    // (b) clearTunnel 실행 → tunnel.json 제거.
    assert.equal(existsSync(STATE_FILE), false, '(b) false-negative여도 clearTunnel이 수행되어야 함');
    // bystander는 시그니처 불일치라 죽지 않았어야 한다(엉뚱 PID 비살해).
    assert.equal(isAlive(bystander.pid), true, '무관 PID(비-cloudflared)는 살해되지 않아야 함');

    // (c) auth.log에 TUNNEL_KILL cfPid=<bystander.pid> matched=false가 정확히 1회.
    const logText = readFileSync(AUTH_LOG, 'utf8');
    const expected = `TUNNEL_KILL cfPid=${bystander.pid} matched=false`;
    const occurrences = logText.split('\n').filter((line) => line.includes(expected)).length;
    assert.equal(occurrences, 1, `(c) '${expected}' 라인이 정확히 1회 기록되어야 함(실제 ${occurrences}회)`);

    console.log('PASS (R1): false-negative 고아 → exit + clearTunnel + TUNNEL_KILL matched=false 1회 기록');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    bystander.kill();
    await waitExit(bystander);
  }
}

// ============================== R2 ==============================

/**
 * (R2) reconcile auto-kill: state 소실(readTunnel()===null)인데 odpeek 협소 시그니처
 * (`--url http://localhost:<authPort>`)를 가진 더미 cloudflared-유사 프로세스가 살아 있으면,
 * reconcileOrphanTunnel이 후보 주입을 통해 그 PID를 kill한다.
 */
async function testReconcileAutoKill() {
  rmSync(STATE_FILE, { force: true }); // readTunnel()===null 보장
  const authPort = await freePort();
  const orphan = spawnCloudflaredLike(authPort);
  await new Promise((resolve) => setTimeout(resolve, 200)); // orphan이 뜰 시간
  assert.ok(orphan.pid > 0, 'orphan PID 확보');
  assert.equal(isAlive(orphan.pid), true, 'reconcile 전 orphan 생존');

  let killed = false;
  try {
    // signature가 `--url http://localhost:<authPort>`가 되도록 env로 authPort를 고정한다.
    const prevEnv = process.env.ODPEEK_AUTH_PORT;
    process.env.ODPEEK_AUTH_PORT = String(authPort);
    try {
      // 후보 열거기를 주입해 결정론적으로 orphan PID를 후보로 공급한다(실제 pgrep/ps 비의존).
      reconcileOrphanTunnel({ listCandidates: () => [orphan.pid] });
    } finally {
      if (prevEnv === undefined) delete process.env.ODPEEK_AUTH_PORT;
      else process.env.ODPEEK_AUTH_PORT = prevEnv;
    }

    killed = await waitDead(orphan.pid);
    assert.equal(killed, true, '협소 시그니처 일치 orphan은 auto-kill되어야 함');
    console.log('PASS (R2): reconcile auto-kill — 협소 시그니처 일치 cloudflared-유사 프로세스 kill');
  } finally {
    if (!killed) {
      orphan.kill();
      await waitExit(orphan);
    }
  }
}

// ============================== R3 ==============================

/**
 * (R3) reconcile report-only(불일치): 더미가 `--url http://localhost:<다른포트>`를 가져
 * 협소 시그니처와 불일치하면 reconcileOrphanTunnel은 kill하지 않고 생존시킨다(무차별 kill 금지).
 */
async function testReconcileReportOnlyMismatch() {
  rmSync(STATE_FILE, { force: true }); // readTunnel()===null 보장
  const authPort = await freePort();
  // 시그니처(authPort)와 명확히 다른 포트를 쓴다. processMatches는 ps 명령줄을 includes로 검사하므로
  // `localhost:${authPort}`가 `localhost:${otherPort}`의 부분문자열이면(예: 5000 ⊂ 50001) 우연 일치한다.
  // 따라서 단순 부등호가 아니라 "부분문자열 관계 부재"까지 보장하도록 후보를 다시 고른다.
  const sig = `localhost:${authPort}`;
  let otherPort = await freePort();
  while (`localhost:${otherPort}`.includes(sig)) otherPort = await freePort();
  const stranger = spawnCloudflaredLike(otherPort);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(stranger.pid > 0, 'stranger PID 확보');
  assert.equal(isAlive(stranger.pid), true, 'reconcile 전 stranger 생존');

  try {
    const prevEnv = process.env.ODPEEK_AUTH_PORT;
    process.env.ODPEEK_AUTH_PORT = String(authPort);
    try {
      reconcileOrphanTunnel({ listCandidates: () => [stranger.pid] });
    } finally {
      if (prevEnv === undefined) delete process.env.ODPEEK_AUTH_PORT;
      else process.env.ODPEEK_AUTH_PORT = prevEnv;
    }

    // kill이 비동기 반영될 수 있으니 잠깐 기다린 뒤에도 살아 있어야 한다(잘못 죽였다면 사망).
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(isAlive(stranger.pid), true, '협소 시그니처 불일치 프로세스는 kill되지 않고 생존해야 함');
    console.log('PASS (R3): reconcile report-only — 협소 시그니처 불일치 프로세스 비살해(무차별 kill 안 함)');
  } finally {
    stranger.kill();
    await waitExit(stranger);
  }
}

// ============================== R4 ==============================

/**
 * (R4) 두 열거기 동시 실패: listCandidates 주입이 null을 반환(pgrep·ps 둘 다 실패 조건)하면
 * reconcileOrphanTunnel은 throw하지 않고, kill을 시도하지 않으며, 수동 점검 힌트를 출력한다.
 * console.log를 일시 캡처해 힌트 라인 출력을 단언한다.
 */
function testReconcileBothEnumeratorsFail() {
  rmSync(STATE_FILE, { force: true }); // readTunnel()===null 보장

  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => { captured.push(args.join(' ')); };

  let threw = false;
  try {
    // 두 열거기 동시 실패를 null 반환으로 주입(throw·추측 kill 없이 report-only no-kill 강등).
    reconcileOrphanTunnel({ listCandidates: () => null });
  } catch {
    threw = true;
  } finally {
    console.log = originalLog;
  }

  assert.equal(threw, false, '(no throw) 두 열거기 동시 실패에도 크래시하지 않아야 함');
  const hint = captured.join('\n');
  assert.match(
    hint,
    /프로세스 목록을 열거하지 못했습니다/,
    '수동 점검 힌트(열거 실패 안내)가 출력되어야 함',
  );
  assert.match(hint, /ps aux \| grep cloudflared/, '수동 점검 명령 힌트가 포함되어야 함');
  console.log('PASS (R4): 두 열거기 동시 실패 → 크래시 없음 + report-only no-kill + 수동 점검 힌트');
}

async function main() {
  backupUserState();
  try {
    await testFalseNegativeOrphanBreadcrumb();
    await testReconcileAutoKill();
    await testReconcileReportOnlyMismatch();
    testReconcileBothEnumeratorsFail();
  } finally {
    restoreUserState();
  }
  console.log('\n모든 reconcile 테스트 통과 ✅');
  process.exit(0);
}

main().catch((error) => {
  restoreUserState();
  console.error('reconcile 테스트 실패 ✗:', error.message);
  process.exit(1);
});
