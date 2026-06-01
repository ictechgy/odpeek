// odpeek v0.2 단계 2 단위 테스트 — 세션/연결 관측성(src/sessions.mjs) + JSON 스키마/살균.
// 외부 의존성 없이 node:assert/strict + stdlib만 쓰는 standalone 실행 파일(기존 smoke.mjs 스타일).
// 통과 시 각 케이스에 PASS를 출력하고 마지막에 exit 0, 실패 시 exit 1.
//
// 모든 입력(auth.log·tunnel.json)은 fixture 문자열/객체로 직접 주입한다(실제 ~/.odpeek 미접근).
//
// 검증 케이스(§4 Unit·Observability / §5 Feature 3):
//   (S1) parseAuthLog: 정확한 fail/lockout/uniqueIp 카운트 + locked + lastFailureAt + TTL_SHUTDOWN 무영향
//   (S2) parseAuthLog: TUNNEL_KILL matched=true/false 인식(lastKillAttempt 정확, 최신 우선, false=잠재 고아 신호)
//   (S3) maskIp 적용(buildSessionsView가 넘기는 raw IP가 빌더에서 마스킹됨)
//   (S4) buildSessionsJson/buildStatusJson 출력에 비밀번호·raw IP·userinfo 부재
//   (S5) tunnel.idle.remainingSec===null (구동 터널 fixture, Defect 3)
//   (S6) startedAt 부재 터널 → uptimeSec===null (스키마 위반 없음, Gap 3)
//   (S7) buildSessionsView: potentialOrphan 파생(matched=false 최신 → true), graceful 빈/미존재 로그
import assert from 'node:assert/strict';
import { parseAuthLog, buildSessionsView } from '../src/sessions.mjs';
import { buildSessionsJson, buildStatusJson } from '../src/output.mjs';

// 결정론을 위한 고정 기준 시각(epoch ms). 2026-06-01T00:00:00.000Z.
const NOW = Date.UTC(2026, 5, 1, 0, 0, 0);

// authProxy.mjs 실제 포맷에 정박한 fixture(각 라인 앞 ISO 접두 — log()가 붙이는 형태와 동일).
const AUTH_LOG_FIXTURE = [
  '2026-06-01T00:00:01.000Z AUTH_FAIL ip=100.64.12.34 sock=10.0.0.1 fails=1 path=/',
  '2026-06-01T00:00:02.000Z AUTH_FAIL ip=203.0.113.5 sock=10.0.0.2 fails=1 path=/admin',
  '2026-06-01T00:00:03.000Z AUTH_FAIL ip=100.64.12.34 sock=10.0.0.1 fails=2 path=/y',
  '2026-06-01T00:00:04.000Z LOCKOUT ip=100.64.12.34 (8 fails) for 15min',
  '2026-06-01T00:00:05.000Z LOCKED ip=100.64.12.34 path=/ (upgrade)',
  '2026-06-01T00:00:06.000Z TTL_SHUTDOWN after 2min cap',
  '2026-06-01T00:00:06.500Z TUNNEL_KILL cfPid=4321 matched=true',
  '2026-06-01T00:00:07.000Z TUNNEL_KILL cfPid=4322 matched=false',
  '', // 마지막 개행으로 생기는 빈 라인(실제 로그 파일과 동일)
].join('\n');

/** JSON 직렬화 결과에 NaN/Infinity 같은 비유한 토큰이 없음을 단언한다. */
function assertNoNonFinite(value, label) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /NaN|Infinity/, `${label}: JSON에 비유한 토큰이 없어야 함`);
}

// (S1) parseAuthLog 기본 집계.
function testParseCounts() {
  const parsed = parseAuthLog(AUTH_LOG_FIXTURE);
  assert.equal(parsed.recentAuthFailures, 3, 'AUTH_FAIL 3건');
  assert.equal(parsed.lockouts, 1, 'LOCKOUT 1건');
  assert.equal(parsed.locked, true, 'LOCKED 라인 존재 → locked true');
  assert.equal(parsed.uniqueSourceIps.size, 2, '고유 출발 IP 2개(100.64.12.34, 203.0.113.5)');
  assert.ok(parsed.uniqueSourceIps.has('100.64.12.34'), '100.64.12.34 포함');
  assert.ok(parsed.uniqueSourceIps.has('203.0.113.5'), '203.0.113.5 포함');
  // lastFailureAt은 가장 마지막 AUTH_FAIL의 타임스탬프.
  assert.equal(parsed.lastFailureAt, '2026-06-01T00:00:03.000Z', 'lastFailureAt은 마지막 AUTH_FAIL');
  console.log('PASS (S1): parseAuthLog 정확한 fail/lockout/uniqueIp 카운트 + locked + lastFailureAt');
}

// (S2) TUNNEL_KILL matched=true/false 인식 + 최신 우선 + 잠재-고아 신호.
function testParseTunnelKill() {
  const parsed = parseAuthLog(AUTH_LOG_FIXTURE);
  // 가장 최근 TUNNEL_KILL(00:00:07.000Z, cfPid=4322, matched=false)이 lastKillAttempt.
  assert.ok(parsed.lastKillAttempt, 'lastKillAttempt가 존재해야 함');
  assert.equal(parsed.lastKillAttempt.at, '2026-06-01T00:00:07.000Z', '가장 최근 TUNNEL_KILL 시각');
  assert.equal(parsed.lastKillAttempt.cfPid, 4322, '가장 최근 cfPid(정수)');
  assert.equal(parsed.lastKillAttempt.matched, false, 'matched=false 파싱(잠재 고아 신호)');
  assert.equal(typeof parsed.lastKillAttempt.cfPid, 'number', 'cfPid는 number');

  // matched=true만 있는 fixture → matched true 정확 파싱.
  const onlyTrue = parseAuthLog('2026-06-01T00:00:09.000Z TUNNEL_KILL cfPid=777 matched=true\n');
  assert.equal(onlyTrue.lastKillAttempt.matched, true, 'matched=true 파싱');
  assert.equal(onlyTrue.lastKillAttempt.cfPid, 777, 'matched=true 라인 cfPid');

  // TUNNEL_KILL이 전혀 없으면 null.
  const none = parseAuthLog('2026-06-01T00:00:01.000Z AUTH_FAIL ip=1.2.3.4 sock=? fails=1 path=/\n');
  assert.equal(none.lastKillAttempt, null, 'TUNNEL_KILL 부재 → lastKillAttempt null');
  console.log('PASS (S2): TUNNEL_KILL matched=true/false 인식 + 최신 우선 + 부재 시 null');
}

// (S3) maskIp 적용 — buildSessionsView가 넘긴 raw IP가 buildSessionsJson에서 마스킹됨.
function testMaskApplied() {
  const view = buildSessionsView({ tunnelState: null, authLogText: AUTH_LOG_FIXTURE, now: NOW });
  const envelope = buildSessionsJson({
    tunnelState: null,
    sessions: view.sessions,
    openDesign: { detected: false, reason: 'test' },
    now: NOW,
  });
  // ipsMasked는 마스킹된 형태만(앞 2옥텟 + x.x).
  assert.deepEqual(
    [...envelope.sessions.ipsMasked].sort(),
    ['100.64.x.x', '203.0.x.x'].sort(),
    'ipsMasked는 마스킹된 형태만',
  );
  assert.equal(envelope.sessions.uniqueSourceIps, 2, 'uniqueSourceIps 카운트 2');
  console.log('PASS (S3): buildSessionsView→buildSessionsJson IP 마스킹 적용');
}

// (S4) buildSessionsJson/buildStatusJson 출력에 비밀번호·raw IP·userinfo 부재.
function testNoSecretLeak() {
  const tunnelState = {
    cfPid: 4321,
    proxyPid: 4322,
    authPort: 8765,
    targetPort: 51234,
    odPid: 1000,
    user: 'od',
    url: 'https://abc-def.trycloudflare.com',
    startedAt: NOW - 60000,
    ttlMs: 120000,
    idleMs: 1800000,
  };
  const view = buildSessionsView({ tunnelState, authLogText: AUTH_LOG_FIXTURE, now: NOW });
  const sessionsJson = buildSessionsJson({
    tunnelState,
    sessions: view.sessions,
    openDesign: { pid: 1000, port: 51234 },
    now: NOW,
  });
  const statusJson = buildStatusJson({
    tunnelState,
    openDesign: { pid: 1000, port: 51234 },
    tailscale: { installed: true, backendState: 'Running' },
    now: NOW,
  });

  for (const [label, env] of [['sessions', sessionsJson], ['status', statusJson]]) {
    const text = JSON.stringify(env);
    // raw IP 후반 옥텟('12.34'/'113.5')이 통째로 노출되면 안 됨.
    assert.doesNotMatch(text, /12\.34|113\.5/, `${label}: raw IP 후반 옥텟 미포함`);
    // userinfo-in-URL('user:pass@') 형태가 없어야 함.
    assert.doesNotMatch(text, /\/\/[^/"]*:[^/"]*@/, `${label}: URL userinfo 미포함`);
    // 비밀번호는 상태에 저장되지 않으므로 envelope에 절대 없어야 함(임의 시크릿 토큰 부재 단언).
    assert.doesNotMatch(text, /s3cret|password|pass=/i, `${label}: 비밀번호류 토큰 미포함`);
    assertNoNonFinite(env, `${label} envelope`);
  }
  console.log('PASS (S4): sessions/status JSON에 비밀번호·raw IP·userinfo 부재');
}

// (S5) 구동 터널 fixture → tunnel.idle.remainingSec===null (Defect 3).
function testIdleRemainingNull() {
  const tunnelState = {
    cfPid: 4321,
    url: 'https://abc-def.trycloudflare.com',
    startedAt: NOW - 60000,
    ttlMs: 120000,
    idleMs: 1800000, // idle 30분 활성
  };
  const view = buildSessionsView({ tunnelState, authLogText: '', now: NOW });
  const sessionsJson = buildSessionsJson({
    tunnelState,
    sessions: view.sessions,
    openDesign: { detected: false, reason: 'test' },
    now: NOW,
  });
  const statusJson = buildStatusJson({
    tunnelState,
    openDesign: { detected: false, reason: 'test' },
    tailscale: null,
    now: NOW,
  });

  // 구동 터널이면 tunnel 블록 + idle 블록은 존재하되 remainingSec은 항상 null.
  for (const [label, env] of [['sessions', sessionsJson], ['status', statusJson]]) {
    assert.ok(env.tunnel, `${label}: 구동 터널 → tunnel 블록 존재`);
    assert.ok(env.tunnel.idle, `${label}: idle 블록 존재`);
    assert.equal(env.tunnel.idle.enabled, true, `${label}: idle.enabled true`);
    assert.equal(env.tunnel.idle.remainingSec, null, `${label}: idle.remainingSec===null(Defect 3)`);
  }
  // buildSessionsView.timing도 동일하게 idle.remainingSec===null.
  assert.equal(view.timing.idle.remainingSec, null, 'view.timing.idle.remainingSec===null');
  console.log('PASS (S5): 구동 터널 → tunnel.idle.remainingSec===null');
}

// (S6) startedAt 부재 터널(구버전) → uptimeSec===null, 스키마 위반/NaN 없음 (Gap 3).
function testMissingStartedAtNullUptime() {
  // startedAt 없는 구버전 tunnel.json fixture(구동 중).
  const tunnelState = {
    cfPid: 4321,
    url: 'https://abc-def.trycloudflare.com',
    ttlMs: 120000, // ttl이 있어도 startedAt 없으면 잔여 계산 불가
    idleMs: 1800000,
  };
  const statusJson = buildStatusJson({
    tunnelState,
    openDesign: { detected: false, reason: 'test' },
    tailscale: null,
    now: NOW,
  });
  assert.ok(statusJson.tunnel, '구동 터널이면 tunnel 블록 존재');
  assert.equal(statusJson.tunnel.uptimeSec, null, 'startedAt 부재 → uptimeSec===null');
  assert.equal(statusJson.tunnel.idle, null, 'startedAt 부재 → idle===null');
  assert.equal(statusJson.tunnel.ttl, null, 'startedAt 부재 → ttl===null');
  assertNoNonFinite(statusJson, 'status(startedAt 부재) envelope'); // NaN 미직렬화 = 스키마 위반 없음
  console.log('PASS (S6): startedAt 부재 터널 → uptimeSec===null(스키마 위반 없음)');
}

// (S7) buildSessionsView 파생/graceful.
function testViewDerived() {
  // potentialOrphan: 가장 최근 TUNNEL_KILL matched=false → true.
  const orphanView = buildSessionsView({ tunnelState: null, authLogText: AUTH_LOG_FIXTURE, now: NOW });
  assert.equal(orphanView.potentialOrphan, true, 'matched=false 최신 → potentialOrphan true');
  assert.equal(orphanView.locked, true, 'LOCKED 존재 → locked true');

  // matched=true가 더 최신이면 potentialOrphan false.
  const healthy = buildSessionsView({
    tunnelState: null,
    authLogText: [
      '2026-06-01T00:00:07.000Z TUNNEL_KILL cfPid=4322 matched=false',
      '2026-06-01T00:00:08.000Z TUNNEL_KILL cfPid=4321 matched=true',
      '',
    ].join('\n'),
    now: NOW,
  });
  assert.equal(healthy.potentialOrphan, false, 'matched=true가 최신 → potentialOrphan false');

  // graceful: 빈 로그 + null 터널 → 0 카운트, 예외 없음.
  const empty = buildSessionsView({ tunnelState: null, authLogText: '', now: NOW });
  assert.equal(empty.sessions.recentAuthFailures, 0, '빈 로그 → 실패 0');
  assert.equal(empty.sessions.lockouts, 0, '빈 로그 → 잠금 0');
  assert.equal(empty.sessions.uniqueSourceIps.size, 0, '빈 로그 → 고유 IP 0');
  assert.equal(empty.potentialOrphan, false, '빈 로그 → potentialOrphan false');
  assert.equal(empty.timing.uptimeSec, null, 'null 터널 → uptimeSec null');
  console.log('PASS (S7): buildSessionsView potentialOrphan 파생 + graceful 빈 로그');
}

// (S8) [running/idle false-telemetry] sessions/status 빌더가 주입 running을 반영하고,
//      idleMin 저장 시 idle.enabled를 정확히 보고하며, idle 정보 미저장 시 idle:null(unknown).
function testRunningAndIdleTelemetry() {
  // idleMin=30 저장(신버전 tunnel.json) + running 주입.
  const stored = {
    cfPid: 4321,
    url: 'https://abc-def.trycloudflare.com',
    startedAt: NOW - 60000,
    ttlMs: 120000,
    idleMin: 30,
  };
  const view = buildSessionsView({ tunnelState: stored, authLogText: '', now: NOW });
  const aliveEnv = buildSessionsJson({
    tunnelState: stored, sessions: view.sessions, openDesign: { detected: false, reason: 'test' }, now: NOW, running: true,
  });
  assert.equal(aliveEnv.tunnel.running, true, 'running=true 주입 → tunnel.running:true');
  assert.equal(aliveEnv.tunnel.idle.enabled, true, 'idleMin=30 저장 → idle.enabled:true');
  assert.equal(aliveEnv.tunnel.idle.idleMin, 30, 'idle.idleMin=30 정확');
  assert.equal(aliveEnv.tunnel.idle.remainingSec, null, 'idle.remainingSec 항상 null(F1)');

  // running 미주입(stale state) → running:false(거짓 true 금지).
  const staleEnv = buildStatusJson({
    tunnelState: stored, openDesign: { detected: false, reason: 'test' }, tailscale: null, now: NOW,
  });
  assert.equal(staleEnv.tunnel.running, false, 'running 미주입 → running:false');

  // idle 정보 미저장 구버전(idleMin/idleMs 없음) → idle:null(enabled:false 거짓 단정 금지).
  const legacy = { cfPid: 4321, url: 'https://abc-def.trycloudflare.com', startedAt: NOW - 60000, ttlMs: 120000 };
  const legacyEnv = buildStatusJson({
    tunnelState: legacy, openDesign: { detected: false, reason: 'test' }, tailscale: null, now: NOW, running: true,
  });
  assert.equal(legacyEnv.tunnel.idle, null, 'idle 정보 미저장(구버전) → idle:null(unknown)');
  assert.equal(legacyEnv.tunnel.running, true, 'running=true 주입은 그대로 반영');
  console.log('PASS (S8): running 주입 반영 + idleMin 저장 시 enabled 정확 + 미저장 시 idle:null');
}

function main() {
  testParseCounts();
  testParseTunnelKill();
  testMaskApplied();
  testNoSecretLeak();
  testIdleRemainingNull();
  testMissingStartedAtNullUptime();
  testViewDerived();
  testRunningAndIdleTelemetry();
  console.log('\n모든 sessions 테스트 통과 ✅');
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error('sessions 테스트 실패 ✗:', error.message);
  process.exit(1);
}
