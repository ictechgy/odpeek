// odpeek v0.2 단계 1(TTL hard-cap + 생명주기 하드닝) 테스트.
// 외부 의존성 없이 node:assert/strict만 쓰는 standalone 실행 파일(기존 smoke.mjs 스타일).
// 통과 시 각 케이스에 PASS를 출력하고 마지막에 exit 0, 실패 시 exit 1.
//
// Unit:
//   (U1) toTtlMs(0)===0, toTtlMs(2)===120000
//   (U2) parseAuthProxyArgs ttlMs: '-5'→0, 'abc'→0, '120000'→120000, positional[5] 없음→0(하위호환)
//   (U3) runAuthProxy safeTtlMs 음수→0 (즉시 종료 setTimeout 미설정)
//   (U4) 재진입 가드: exitFn 스텁 주입 상태에서 scheduleShutdown 2회 호출 → kill/clearTunnel/exit ≤1회
//        (가드 없으면 2회임을 대조 검증)
// Integration(실 __authproxy spawn, 더미 upstream, smoke 하니스 차용):
//   (I1) TTL fire: ttlMs 작게 → ~1초 내 exit + clearTunnel
//   (I2) precedence: 더 짧은 데드라인이 먼저 종료(TTL<idle 측정; idle 60s 인터벌의 구조적 한계로 idle 단독 발화는 e2e 위임)
//   (I3) TTL<idle + 활성 연결 강제(HTTP in-flight): TTL 데드라인 종료(TTL이 idle 보류 미상속 증명)
//   (I4) idleMs=0 + ttlMs>0: idle setInterval 미생성에도 TTL 단독 종료
//   (I5) 엉뚱 PID 비살해: cfPid를 무관 살아있는 PID로 → processMatches 불일치 → 미살해
//   (I6) 기존 smoke 5케이스 회귀 불변(별도 파일 smoke.mjs가 담당하므로 여기서는 6-인자 spawn만 추가 검증)
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

import { toTtlMs, parseAuthProxyArgs, assertValidOpts } from '../src/cli.mjs';
import { runAuthProxy } from '../src/authProxy.mjs';

const BIN = fileURLToPath(new URL('../bin/odpeek.mjs', import.meta.url));
const USER = 'od';
const PASS = 's3cret-pass';
const LOG_FILE = join(tmpdir(), 'odpeek-timing.log');

// readTunnel/saveTunnel/clearTunnel은 고정 경로(~/.odpeek/tunnel.json)를 쓴다.
// 통합 테스트가 이 파일을 만들고 지우므로, 사용자 상태를 백업했다가 끝에 복원한다.
const STATE_DIR = join(homedir(), '.odpeek');
const STATE_FILE = join(STATE_DIR, 'tunnel.json');
const BACKUP_FILE = join(tmpdir(), `odpeek-timing-tunnel-backup-${process.pid}.json`);
let hadState = false;

/** 사용자 tunnel.json을 백업하고 디렉토리를 보장한다. */
function backupUserState() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(STATE_FILE)) {
    hadState = true;
    copyFileSync(STATE_FILE, BACKUP_FILE);
  }
}

/** 백업한 사용자 tunnel.json을 복원하고(없었으면 제거) 임시 파일을 정리한다. */
function restoreUserState() {
  if (hadState) {
    copyFileSync(BACKUP_FILE, STATE_FILE);
    rmSync(BACKUP_FILE, { force: true });
  } else if (existsSync(STATE_FILE)) {
    rmSync(STATE_FILE, { force: true });
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

/** 더미 upstream(OD 역할) HTTP 서버를 띄운다(요청 처리를 지연시킬 수 있음). */
function startUpstream({ delayMs = 0 } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok-upstream');
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/** 프록시에 GET 요청을 보낸다(선택적 Basic 자격). */
function request(port, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', headers, timeout: 5000, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** 프록시가 401 챌린지로 응답할 때까지 대기한다(준비 확인). */
async function waitReady(port, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await request(port);
      if (res.status === 401) return;
    } catch {
      // 아직 listen 전 — 재시도
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('프록시가 준비되지 않았습니다');
}

/**
 * __authproxy 분리 프로세스를 띄운다.
 * ttlMs를 넘기면 6번째 위치 인자로 append(생략 시 5-인자 하위호환).
 */
function spawnProxy(listenPort, targetPort, env, { ttlMs } = {}) {
  const args = [BIN, '__authproxy', String(listenPort), String(targetPort), '0', LOG_FILE];
  if (ttlMs !== undefined) args.push(String(ttlMs));
  return spawn(
    process.execPath,
    args,
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } },
  );
}

/** idle/ttl을 직접 지정해 __authproxy를 띄운다(통합 시나리오용). */
function spawnProxyWith(listenPort, targetPort, env, { idleMs = 0, ttlMs = 0 } = {}) {
  const args = [BIN, '__authproxy', String(listenPort), String(targetPort), String(idleMs), LOG_FILE, String(ttlMs)];
  return spawn(
    process.execPath,
    args,
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } },
  );
}

/** 자식 프로세스의 종료 코드를 기다린다(타임아웃 시 reject). */
function waitExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exit 타임아웃')), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// ============================== Unit ==============================

/** (U1) toTtlMs 변환 검증. */
function testToTtlMs() {
  assert.equal(toTtlMs(0), 0, 'toTtlMs(0)===0');
  assert.equal(toTtlMs(2), 120000, 'toTtlMs(2)===120000');
  assert.equal(toTtlMs(-1), 0, '음수는 0(toTtlMs는 >0만 변환)');
  console.log('PASS (U1): toTtlMs(0)=0 / toTtlMs(2)=120000');
}

/** (U2) parseAuthProxyArgs의 ttlMs 비음수-정수 강등 + 하위호환. */
function testParseAuthProxyArgsTtl() {
  // positional[0]은 명령('__authproxy'), 그 뒤로 listen/target/idle/log/ttl.
  const base = ['__authproxy', '8765', '8080', '0', LOG_FILE];
  assert.equal(parseAuthProxyArgs([...base, '-5']).ttlMs, 0, "'-5' → 0 (음수 강등)");
  assert.equal(parseAuthProxyArgs([...base, 'abc']).ttlMs, 0, "'abc' → 0 (비정수 강등)");
  assert.equal(parseAuthProxyArgs([...base, '120000']).ttlMs, 120000, "'120000' → 120000");
  assert.equal(parseAuthProxyArgs([...base]).ttlMs, 0, 'positional[5] 없음 → 0 (5-인자 하위호환)');
  // idleMs 기존 동작 회귀 불변 확인.
  assert.equal(parseAuthProxyArgs([...base, '120000']).idleMs, 0, 'idleMs는 기존대로 0');
  console.log("PASS (U2): parseAuthProxyArgs ttlMs '-5'/'abc'→0, '120000'→120000, 5-인자→0");
}

/** assertValidOpts 호출용 기본 유효 opts(ttlMin만 케이스별로 덮어쓴다). */
function baseOpts(overrides) {
  return { port: 8080, authPort: 8765, idleMin: 30, ttlMin: 0, ...overrides };
}

/**
 * (U5) [setTimeout 오버플로] 큰 --ttl이 assertValidOpts에서 throw하는지.
 * 2147483647ms(약 35791.39분)을 ms로 넘기는 ttlMin은 setTimeout 오버플로 위험 → 거부.
 */
function testTtlOverflowRejected() {
  // 2147483647ms / 60000 = 35791.39...분. 35792분 = 2147520000ms > 2147483647 → throw.
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: 35792 })), /너무 큽니다/, '큰 ttl → throw');
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: 100000 })), /너무 큽니다/, '아주 큰 ttl → throw');
  // 경계 직전(35791분 = 2147460000ms ≤ 2147483647)은 통과해야 함.
  assert.doesNotThrow(() => assertValidOpts(baseOpts({ ttlMin: 35791 })), '경계 내 ttl은 통과');
  // ttlMin=0(비활성)도 통과.
  assert.doesNotThrow(() => assertValidOpts(baseOpts({ ttlMin: 0 })), 'ttlMin=0(비활성) 통과');
  console.log('PASS (U5): 큰 --ttl(>2^31-1 ms) → assertValidOpts throw, 경계 내는 통과');
}

/**
 * (U6) [분수 --ttl 계약 불일치] 분수 ttlMin이 assertValidOpts에서 throw하는지.
 * parseAuthProxyArgs가 정수 ms만 받아 분수가 0(비활성)으로 묻히므로 진입점에서 거부.
 */
function testFractionalTtlRejected() {
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: 1.5 })), /정수\(분\)/, '분수 ttl → throw');
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: 0.5 })), /정수\(분\)/, '0.5분 → throw');
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: -1 })), /정수\(분\)/, '음수 ttl → throw');
  assert.throws(() => assertValidOpts(baseOpts({ ttlMin: NaN })), /정수\(분\)/, 'NaN ttl → throw');
  // 정수는 통과(분수만 거부 — idleMin 분수 동작은 별개로 건드리지 않음).
  assert.doesNotThrow(() => assertValidOpts(baseOpts({ ttlMin: 5, idleMin: 1.5 })), '정수 ttl + 분수 idle은 통과(ttl만 정수 강제)');
  console.log('PASS (U6): 분수/음수/NaN --ttl → assertValidOpts throw(정수 분 강제), idle 분수는 불변');
}

/**
 * (U3) runAuthProxy의 safeTtlMs 음수 강등.
 * 음수 ttlMs를 넘겨도 TTL setTimeout이 설정되지 않아 즉시 종료가 발생하지 않음을,
 * exitFn 스텁이 호출되지 않음으로 검증한다(가드 hook으로 서버를 즉시 닫는다).
 */
async function testSafeTtlMsNegative() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  let exitCalls = 0;
  let server = null;
  runAuthProxy(listenPort, targetPort, USER, PASS, {
    idleMs: 0,
    ttlMs: -5, // 음수 → safeTtlMs 0 강등 → setTimeout 미설정
    exitFn: () => { exitCalls += 1; },
    __exposeInternals: ({ server: s }) => { server = s; },
  });
  // setTimeout(-5)가 잘못 설정됐다면 다음 매크로태스크에서 발화한다. 충분히 기다린다.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(exitCalls, 0, '음수 ttlMs는 TTL 타이머를 설정하지 않아 종료가 발생하지 않아야 함');
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  console.log('PASS (U3): 음수 ttlMs → safeTtlMs 0, 즉시 종료 setTimeout 미설정');
}

/**
 * (U3-2) [setTimeout 오버플로 심층 방어] 2^31-1을 초과하는 ttlMs를 runAuthProxy에 넘겨도
 * safeTtlMs가 0으로 강등되어 즉시 종료 setTimeout이 설정되지 않음을 검증한다(authProxy 클램프).
 * (가드 없으면 setTimeout이 오버플로해 즉시 발화 → exitFn이 호출됐을 것이다.)
 */
async function testSafeTtlMsOverflow() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  let exitCalls = 0;
  let server = null;
  runAuthProxy(listenPort, targetPort, USER, PASS, {
    idleMs: 0,
    ttlMs: 2147483648, // 2^31 > 2147483647 → safeTtlMs 0 강등 → setTimeout 미설정(오버플로 즉시발화 방지)
    exitFn: () => { exitCalls += 1; },
    __exposeInternals: ({ server: s }) => { server = s; },
  });
  // 오버플로 setTimeout은 즉시(다음 틱) 발화한다. 충분히 기다려 미발화를 확인한다.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(exitCalls, 0, '2^31-1 초과 ttlMs는 0으로 강등돼 즉시 종료가 발생하지 않아야 함');
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  console.log('PASS (U3-2): 오버플로 ttlMs(>2^31-1) → safeTtlMs 0, 즉시발화 방지');
}

/**
 * (U4) 재진입 가드: exitFn 스텁 주입 상태에서 scheduleShutdown을 2회 호출.
 * clearTunnel/exit가 최대 1회만 수행됨을 단언한다(가드가 두 번째 호출을 실제로 차단).
 * 대조: exit이 no-op으로 막혀 있으므로 가드가 없었다면 2회 수행될 것이다.
 */
async function testReentryGuard() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();

  // tunnel.json을 비워(고아 cfPid 없이) clearTunnel 호출 여부를 파일 존재로 관측한다.
  // 가드 구동 검증이 목적이므로 cfPid 없는 상태로 둔다(kill 분기 미진입).
  writeFileSync(STATE_FILE, JSON.stringify({ authPort: listenPort, targetPort, url: null }), { mode: 0o600 });

  let exitCalls = 0;
  let scheduleShutdown = null;
  let server = null;
  runAuthProxy(listenPort, targetPort, USER, PASS, {
    idleMs: 0,
    ttlMs: 0,
    exitFn: () => { exitCalls += 1; },
    __exposeInternals: (internals) => {
      scheduleShutdown = internals.scheduleShutdown;
      server = internals.server;
    },
  });

  assert.equal(typeof scheduleShutdown, 'function', 'scheduleShutdown이 노출되어야 함');
  // tunnel.json이 존재하는 상태(첫 호출이 clearTunnel로 지움).
  assert.equal(existsSync(STATE_FILE), true, '첫 호출 전 tunnel.json 존재');

  scheduleShutdown('TEST_SHUTDOWN_1');
  scheduleShutdown('TEST_SHUTDOWN_2'); // 가드로 무시되어야 함

  assert.equal(exitCalls, 1, 'exitFn은 정확히 1회만 호출되어야 함(가드가 2번째 차단)');
  assert.equal(existsSync(STATE_FILE), false, 'clearTunnel은 1회만 수행되어 tunnel.json이 제거됨');

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  console.log('PASS (U4): 재진입 가드 — scheduleShutdown 2회 호출에도 exit/clearTunnel ≤1회');
}

// ============================== Integration ==============================

/**
 * (I1) TTL fire: ttlMs를 작게 주면 활동 없이 데드라인에 proxy가 exit(0)하고 clearTunnel한다.
 * tunnel.json을 미리 깔아두고 종료 후 제거됐는지 확인한다.
 */
async function testTtlFire() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  writeFileSync(STATE_FILE, JSON.stringify({ authPort: listenPort, targetPort, url: null }), { mode: 0o600 });

  const proxy = spawnProxyWith(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { idleMs: 0, ttlMs: 600 });
  try {
    await waitReady(listenPort);
    const code = await waitExit(proxy, 5000);
    assert.equal(code, 0, 'TTL 종료는 exit(0)이어야 함');
    assert.equal(existsSync(STATE_FILE), false, 'TTL 종료가 clearTunnel을 수행해야 함');
    console.log('PASS (I1): TTL fire → ~데드라인 내 exit(0) + clearTunnel');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/**
 * (I2) precedence "먼저 만료되는 쪽이 이긴다": idle과 TTL을 함께 설정하되 TTL을 더 짧게 주면
 * TTL 데드라인에 종료된다. idle setInterval은 60초 고정 주기라 sub-second idle을 빠른 테스트로
 * 직접 발화시킬 수 없으므로(구조적 한계), 본 케이스는 "더 짧은 데드라인(TTL)이 먼저 종료"를
 * 측정해 precedence 규칙을 검증한다. idle 단독 발화의 실시간 검증은 e2e(수동)로 위임한다.
 */
async function testShorterDeadlineWins() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  rmSync(STATE_FILE, { force: true });

  // idle 큼(60초 인터벌이라 빠른 테스트 구간에는 어차피 안 옴) + TTL 600ms(더 짧음) → TTL이 이긴다.
  const proxy = spawnProxyWith(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { idleMs: 600000, ttlMs: 600 });
  try {
    await waitReady(listenPort);
    const start = Date.now();
    const code = await waitExit(proxy, 5000);
    const elapsed = Date.now() - start;
    assert.equal(code, 0, '더 짧은 데드라인이 exit(0)으로 종료해야 함');
    assert.ok(elapsed < 3000, `TTL(600ms)이 idle(매우 큼)보다 먼저 종료해야 함(경과 ${elapsed}ms)`);
    console.log('PASS (I2): precedence — 더 짧은 데드라인(TTL)이 먼저 종료');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/**
 * (I3) TTL<idle + 활성 연결 강제: 진행 중 HTTP 요청(activeConnections>0)이 있어도
 * TTL 데드라인에 종료된다(TTL이 idle의 active 보류를 상속하지 않음을 증명).
 */
async function testTtlIgnoresActive() {
  const upstream = await startUpstream({ delayMs: 3000 }); // upstream이 3초 지연 → 연결이 in-flight 유지
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  rmSync(STATE_FILE, { force: true });

  // idle 크게(60초 인터벌이라 어차피 안 옴) + TTL 800ms. 활성 연결이 있어도 TTL이 이겨야 한다.
  const proxy = spawnProxyWith(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { idleMs: 600000, ttlMs: 800 });
  try {
    await waitReady(listenPort);
    // 인증된 요청을 in-flight로 띄운다(응답은 upstream 지연으로 늦게 옴 → activeConnections>0).
    const inflight = request(listenPort, { auth: `${USER}:${PASS}` }).catch(() => null);
    const start = Date.now();
    const code = await waitExit(proxy, 5000);
    const elapsed = Date.now() - start;
    assert.equal(code, 0, '활성 연결이 있어도 TTL 종료는 exit(0)');
    assert.ok(elapsed < 3000, `TTL(800ms)이 활성 연결을 무시하고 종료해야 함(경과 ${elapsed}ms < upstream 지연 3000ms)`);
    await inflight;
    console.log('PASS (I3): TTL<idle + 활성 연결 강제 → TTL 데드라인 종료(active 보류 미상속)');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/** (I4) idleMs=0 + ttlMs>0: idle setInterval이 생성되지 않아도 TTL 단독으로 종료한다. */
async function testIdleZeroTtlOnly() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  rmSync(STATE_FILE, { force: true });

  const proxy = spawnProxyWith(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { idleMs: 0, ttlMs: 700 });
  try {
    await waitReady(listenPort);
    const code = await waitExit(proxy, 5000);
    assert.equal(code, 0, 'idleMs=0이어도 TTL만으로 exit(0) 종료');
    console.log('PASS (I4): idleMs=0 + ttlMs>0 → TTL 단독 종료');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/**
 * (I5) 엉뚱 PID 비살해: tunnel.json.cfPid를 무관한 살아있는 PID(이 테스트의 더미 프로세스)로
 * 세팅하면 processMatches('cloudflared') 불일치로 kill을 건너뛰어 그 프로세스가 생존한다.
 */
async function testNoKillWrongPid() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();

  // 무관한 살아있는 프로세스(node sleep). 이 PID는 cloudflared가 아니다.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200)); // bystander가 뜰 시간
  assert.ok(bystander.pid > 0, 'bystander PID 확보');

  // cfPid를 bystander로 위장. processMatches가 'cloudflared' 불일치 → kill 안 함.
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ cfPid: bystander.pid, authPort: listenPort, targetPort, url: null }),
    { mode: 0o600 },
  );

  const proxy = spawnProxyWith(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { idleMs: 0, ttlMs: 600 });
  try {
    await waitReady(listenPort);
    const code = await waitExit(proxy, 5000);
    assert.equal(code, 0, 'TTL 종료 exit(0)');
    // bystander는 cloudflared 시그니처 불일치로 죽지 않고 살아 있어야 한다.
    let alive = true;
    try {
      process.kill(bystander.pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, '무관 PID(비-cloudflared)는 살해되지 않아야 함');
    console.log('PASS (I5): 엉뚱 PID 비살해(processMatches 시그니처 불일치)');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    bystander.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/** (I6) [P3 회귀 게이트] 6번째 인자(ttlMs)를 넘긴 spawn이 정상 동작(401 응답)하는지. */
async function testSixArgSpawn() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  rmSync(STATE_FILE, { force: true });

  const proxy = spawnProxy(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS }, { ttlMs: 0 });
  try {
    await waitReady(listenPort);
    const noauth = await request(listenPort);
    assert.equal(noauth.status, 401, '6-인자 spawn도 정상적으로 401 챌린지');
    console.log('PASS (I6): 6-인자(ttlMs) spawn 회귀 불변');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function main() {
  backupUserState();
  try {
    // Unit
    testToTtlMs();
    testParseAuthProxyArgsTtl();
    testTtlOverflowRejected();
    testFractionalTtlRejected();
    await testSafeTtlMsNegative();
    await testSafeTtlMsOverflow();
    await testReentryGuard();
    // Integration
    await testTtlFire();
    await testShorterDeadlineWins();
    await testTtlIgnoresActive();
    await testIdleZeroTtlOnly();
    await testNoKillWrongPid();
    await testSixArgSpawn();
  } finally {
    restoreUserState();
    rmSync(LOG_FILE, { force: true });
  }
  console.log('\n모든 timing 테스트 통과 ✅');
  process.exit(0);
}

main().catch((error) => {
  restoreUserState();
  console.error('timing 테스트 실패 ✗:', error.message);
  process.exit(1);
});
