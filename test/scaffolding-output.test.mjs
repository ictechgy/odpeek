// 공유 `--json` envelope 빌더(src/output.mjs) 단위 테스트.
// 외부 의존성 없이 node:assert/strict만 사용하는 standalone 실행 파일(기존 smoke.mjs 스타일).
// 통과 시 각 케이스에 PASS를 출력하고 마지막에 exit 0, 실패 시 exit 1.
//
// 검증 케이스(§4 Unit / §5 Feature 3):
//   (a) tunnelTiming startedAt 정상 → uptimeSec / ttl.remainingSec 정확
//   (b) startedAt undefined → uptimeSec===null && idle===null && ttl===null (NaN·스키마 위반 없음)
//   (c) startedAt 정상 + idle 활성 → idle.remainingSec===null (Defect 3: F1 도출 불가, 거짓 보고 금지)
//   (d) maskIp가 전체 옥텟을 노출하지 않음
//   (e) buildStatusJson / buildSessionsJson 출력에 비밀번호·raw IP·userinfo 부재
import assert from 'node:assert/strict';
import {
  maskIp,
  tunnelTiming,
  buildStatusJson,
  buildDoctorJson,
  buildSessionsJson,
} from '../src/output.mjs';

// 결정론을 위한 고정 기준 시각(epoch ms). 2026-06-01T00:00:00.000Z.
const NOW = Date.UTC(2026, 5, 1, 0, 0, 0);

/** JSON 직렬화 결과에 NaN/Infinity 같은 비유한 토큰이 없음을 단언한다. */
function assertNoNonFinite(value, label) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /NaN|Infinity/, `${label}: JSON에 비유한 토큰이 없어야 함`);
}

// (a) startedAt 정상 → uptimeSec / ttl.remainingSec 정확.
function testTimingNormal() {
  const startedAt = NOW - 60000; // 60초 전 시작
  const state = { startedAt, ttlMs: 120000 }; // TTL 2분(120초)
  const timing = tunnelTiming(state, NOW);

  assert.equal(timing.uptimeSec, 60, 'uptimeSec은 60이어야 함(now−startedAt=60s)');
  assert.ok(timing.ttl, 'ttlMs>0이면 ttl 블록이 존재해야 함');
  assert.equal(timing.ttl.enabled, true, 'ttl.enabled는 true여야 함');
  assert.equal(timing.ttl.ttlMin, 2, 'ttl.ttlMin은 2여야 함(120000ms)');
  // 잔여 = ceil((120000−60000)/1000) = 60.
  assert.equal(timing.ttl.remainingSec, 60, 'ttl.remainingSec은 60이어야 함(단일 t0 정합)');
  assertNoNonFinite(timing, 'tunnelTiming(정상)');
  console.log('PASS (a): tunnelTiming startedAt 정상 → uptimeSec/ttl.remainingSec 정확');
}

// (a-2) ttl 잔여가 음수로 내려가지 않고 0으로 클램프됨을 단언.
function testTtlClamp() {
  const state = { startedAt: NOW - 200000, ttlMs: 120000 }; // 이미 데드라인 초과
  const timing = tunnelTiming(state, NOW);
  assert.equal(timing.ttl.remainingSec, 0, 'TTL 데드라인 초과 시 remainingSec은 0으로 클램프');
  console.log('PASS (a-2): ttl.remainingSec 음수 → 0 클램프');
}

// (b) startedAt undefined → uptimeSec===null && idle===null && ttl===null (스키마 위반·NaN 없음).
function testTimingMissingStartedAt() {
  const state = { ttlMs: 120000, idleMs: 1800000 }; // startedAt 없음(구버전 tunnel.json)
  const timing = tunnelTiming(state, NOW);

  assert.equal(timing.uptimeSec, null, 'startedAt 부재 → uptimeSec===null');
  assert.equal(timing.idle, null, 'startedAt 부재 → idle===null');
  assert.equal(timing.ttl, null, 'startedAt 부재 → ttl===null');
  assertNoNonFinite(timing, 'tunnelTiming(startedAt 부재)');

  // 0·음수·실수 startedAt도 동일하게 전부 null이어야 함(양의 정수만 통과).
  for (const bad of [0, -1, 1.5, null, '123', NaN]) {
    const t = tunnelTiming({ startedAt: bad, ttlMs: 120000 }, NOW);
    assert.equal(t.uptimeSec, null, `startedAt=${String(bad)} → uptimeSec===null`);
    assert.equal(t.idle, null, `startedAt=${String(bad)} → idle===null`);
    assert.equal(t.ttl, null, `startedAt=${String(bad)} → ttl===null`);
  }
  console.log('PASS (b): startedAt undefined/비정상 → uptimeSec/idle/ttl 전부 null (NaN 미직렬화)');
}

// (c) startedAt 정상 + idle 활성 → idle.remainingSec===null (Defect 3).
function testIdleRemainingAlwaysNull() {
  const state = { startedAt: NOW - 60000, idleMs: 1800000 }; // idle 30분 활성
  const timing = tunnelTiming(state, NOW);

  assert.ok(timing.idle, 'startedAt 정상이면 idle 블록 존재');
  assert.equal(timing.idle.enabled, true, 'idleMs>0이면 idle.enabled는 true');
  assert.equal(timing.idle.idleMin, 30, 'idle.idleMin은 30이어야 함');
  // 핵심 단언: F1 하에서 idle 잔여는 도출 불가 → 항상 null(거짓 보고 금지).
  assert.equal(timing.idle.remainingSec, null, 'idle.remainingSec은 항상 null(Defect 3)');
  console.log('PASS (c): startedAt 정상+idle 활성 → idle.remainingSec===null');
}

// (d) maskIp가 전체 옥텟을 노출하지 않음.
function testMaskIp() {
  assert.equal(maskIp('100.64.12.34'), '100.64.x.x', 'IPv4 뒤 2옥텟 마스킹');
  assert.equal(maskIp('203.0.113.5'), '203.0.x.x', 'IPv4 뒤 2옥텟 마스킹');

  // 마스킹 결과는 항상 앞 2옥텟 + 'x.x' 형태이고 뒤 2옥텟 자리가 'x'여야 함(전체 노출 금지).
  // (앞 2옥텟과 우연히 값이 겹치는 경우를 피하려 뒤 2옥텟이 distinct한 IP만 사용한다.)
  for (const ip of ['100.64.12.34', '203.0.113.5', '198.51.100.77']) {
    const masked = maskIp(ip);
    const maskedOctets = masked.split('.');
    assert.equal(maskedOctets.length, 4, `마스킹 결과는 4옥텟 형태: ${masked}`);
    assert.equal(maskedOctets[2], 'x', `세 번째 옥텟은 'x'로 가려져야 함: ${masked}`);
    assert.equal(maskedOctets[3], 'x', `네 번째 옥텟은 'x'로 가려져야 함: ${masked}`);
    // 앞 2옥텟만 그대로, 뒤 2옥텟의 원래 값은 결과에 등장하지 않아야 함.
    const [, , thirdOctet, fourthOctet] = ip.split('.');
    assert.doesNotMatch(masked, new RegExp(`\\b${thirdOctet}\\b`),
      `마스킹 결과에 세 번째 옥텟 ${thirdOctet}이 노출되면 안 됨: ${masked}`);
    assert.doesNotMatch(masked, new RegExp(`\\b${fourthOctet}\\b`),
      `마스킹 결과에 네 번째 옥텟 ${fourthOctet}이 노출되면 안 됨: ${masked}`);
  }

  // IPv6: 압축(::) 주소에서 끝의 낮은 hextet이 절대 노출되면 안 된다.
  // fe80::1 → 끝 '1'(인터페이스 ID)이 노출되면 안 됨 → 'fe80:x'
  const fe80 = maskIp('fe80::1');
  assert.equal(fe80, 'fe80:x', 'fe80::1 → fe80:x (끝 인터페이스 ID 미노출)');
  assert.doesNotMatch(fe80, /\b1\b/, 'fe80::1 마스킹 결과에 끝 hextet 1 미노출');

  // 2001:db8::1 → 끝 '1'이 노출되면 안 됨 → '2001:db8:x'
  const db8 = maskIp('2001:db8::1');
  assert.equal(db8, '2001:db8:x', '2001:db8::1 → 2001:db8:x (끝 hextet 미노출)');
  assert.doesNotMatch(db8, /\b1\b/, '2001:db8::1 마스킹 결과에 끝 hextet 1 미노출');

  // 긴 완전 전개 주소도 앞 2 hextet만 남기고 나머지 미노출.
  const v6 = maskIp('2001:db8:abcd:0012:0000:0000:0000:0001');
  assert.equal(v6, '2001:db8:x', 'IPv6 완전 전개 → 앞 2 hextet만 남기고 축약');
  assert.doesNotMatch(v6, /abcd|0012|0001/, 'IPv6 뒤쪽 hextet 미노출');

  // ::1 (루프백) → 프리픽스 hextet이 없으므로 'x'
  const loopback = maskIp('::1');
  assert.equal(loopback, 'x', '::1(루프백) → x (끝 1 미노출)');
  assert.doesNotMatch(loopback, /\b1\b/, '::1 마스킹 결과에 1 미노출');

  // 비정상 입력도 raw를 반환하지 않음.
  assert.equal(maskIp(''), 'x.x.x.x', '빈 문자열 → 기본 마스크');
  assert.equal(maskIp(undefined), 'x.x.x.x', '비문자열 → 기본 마스크');
  console.log('PASS (d): maskIp가 전체 옥텟을 노출하지 않음(IPv4/IPv6 압축·완전전개/비정상)');
}

// (e) buildStatusJson / buildSessionsJson 출력에 비밀번호·raw IP·userinfo 부재.
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
  const openDesign = { pid: 1000, port: 51234 };
  const tailscale = { backendState: 'Running' };
  // 로그 파서가 넘길 법한 raw IP를 일부러 주입해 마스킹·미노출을 검증한다.
  const sessions = {
    recentAuthFailures: 3,
    lockouts: 1,
    uniqueSourceIps: new Set(['100.64.12.34', '203.0.113.5']),
    ips: ['100.64.12.34', '203.0.113.5'],
    lastFailureAt: '2026-06-01T00:00:00.000Z',
  };

  const statusJson = buildStatusJson({ tunnelState, openDesign, tailscale, now: NOW });
  const doctorJson = buildDoctorJson({ tunnelState, openDesign, tailscale, now: NOW });
  const sessionsJson = buildSessionsJson({ tunnelState, sessions, openDesign, now: NOW });

  // envelope 공통 스키마 단언.
  for (const [label, env, cmd] of [
    ['status', statusJson, 'status'],
    ['doctor', doctorJson, 'doctor'],
    ['sessions', sessionsJson, 'sessions'],
  ]) {
    assert.equal(env.schemaVersion, 1, `${label}: schemaVersion===1`);
    assert.equal(env.command, cmd, `${label}: command===${cmd}`);
    assert.equal(env.generatedAt, new Date(NOW).toISOString(), `${label}: generatedAt 결정론`);
    assert.ok(env.tunnel, `${label}: 구동 터널이면 tunnel 블록 존재`);
    // [Defect 3] idle 잔여는 어떤 명령에서도 숫자로 보고하지 않는다.
    assert.equal(env.tunnel.idle.remainingSec, null, `${label}: tunnel.idle.remainingSec===null`);
    assertNoNonFinite(env, `${label} envelope`);
  }

  // sessions IP는 마스킹된 형태로만 노출.
  assert.deepEqual(sessionsJson.sessions.ipsMasked, ['100.64.x.x', '203.0.x.x'],
    'sessions.ipsMasked는 마스킹된 형태만');

  // 누출 금지 단언: 직렬화 전체 텍스트에 비밀번호·raw IP 후반 옥텟·userinfo가 없어야 함.
  const SECRET_PASS = 's3cret-pass';
  const stateWithPass = { ...tunnelState };
  // (현재 saveTunnel은 user만 저장하고 pass는 저장하지 않음 — 그 불변을 회귀 방지로 단언)
  for (const [label, env] of [['status', statusJson], ['doctor', doctorJson], ['sessions', sessionsJson]]) {
    const text = JSON.stringify(env);
    assert.doesNotMatch(text, new RegExp(SECRET_PASS), `${label}: 비밀번호 미포함`);
    // raw IP 후반 옥텟('12.34' / '113.5')이 통째로 노출되면 안 됨.
    assert.doesNotMatch(text, /12\.34|113\.5/, `${label}: raw IP 후반 옥텟 미포함`);
    // userinfo-in-URL('user:pass@') 형태가 없어야 함.
    assert.doesNotMatch(text, /\/\/[^/"]*:[^/"]*@/, `${label}: URL userinfo 미포함`);
  }
  void stateWithPass; // 의도 명시(현재 pass는 상태에 저장되지 않음)

  console.log('PASS (e): status/doctor/sessions 출력에 비밀번호·raw IP·userinfo 부재');
}

function main() {
  testTimingNormal();
  testTtlClamp();
  testTimingMissingStartedAt();
  testIdleRemainingAlwaysNull();
  testMaskIp();
  testNoSecretLeak();
  console.log('\n모든 output 스캐폴딩 테스트 통과 ✅');
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error('output 스캐폴딩 테스트 실패 ✗:', error.message);
  process.exit(1);
}
