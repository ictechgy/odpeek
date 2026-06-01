// odpeek v0.2 공유 스캐폴딩 스모크 테스트(단계 0).
// 외부 의존성 없이, tunnel.json의 startedAt/ttlMs 선택 필드 검증과
// 하위호환(구버전 파일 통과)을 검증한다.
//
// 주의: readTunnel/saveTunnel/clearTunnel은 고정 경로(~/.odpeek/tunnel.json)를 쓰므로,
// 테스트 시작 시 기존 사용자 상태를 백업하고 끝에 반드시 복원한다(사용자 상태 보존).
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { saveTunnel, readTunnel, clearTunnel } from '../src/tunnel.mjs';

const STATE_DIR = join(homedir(), '.odpeek');
const STATE_FILE = join(STATE_DIR, 'tunnel.json');

// 정상 검증을 통과하는 기본 터널 상태(여기에 startedAt/ttlMs만 바꿔 케이스를 만든다).
const VALID_BASE = {
  cfPid: 1234,
  proxyPid: 5678,
  authPort: 51234,
  targetPort: 3000,
  url: 'https://abc-def.trycloudflare.com',
};

/** 검증 로직만 단독으로 구동하기 위해, raw 객체를 고정 경로에 직접 기록한다. */
function writeRawState(stateObject) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(stateObject, null, 2), { mode: 0o600 });
}

function main() {
  // 기존 사용자 tunnel.json 백업(있으면 내용 보관, 없으면 부재 상태 기록).
  const hadExisting = existsSync(STATE_FILE);
  const backup = hadExisting ? readFileSync(STATE_FILE, 'utf8') : null;

  try {
    // (a) startedAt 양의 정수 → 통과.
    writeRawState({ ...VALID_BASE, startedAt: Date.now() });
    assert.ok(readTunnel() !== null, '(a) startedAt 양의 정수는 통과해야 함');
    console.log('PASS: (a) startedAt 양의 정수 통과');

    // (b) startedAt이 0 / 음수 / 실수 → readTunnel null.
    for (const badStartedAt of [0, -1, 1.5]) {
      writeRawState({ ...VALID_BASE, startedAt: badStartedAt });
      assert.equal(
        readTunnel(),
        null,
        `(b) startedAt=${badStartedAt}는 거부(null)해야 함`,
      );
    }
    console.log('PASS: (b) startedAt 0/음수/실수 → null');

    // (c) ttlMs가 음수 / 실수 → null. (0과 양의 정수는 §G 검증상 허용.)
    for (const badTtlMs of [-1, 1.5]) {
      writeRawState({ ...VALID_BASE, startedAt: Date.now(), ttlMs: badTtlMs });
      assert.equal(
        readTunnel(),
        null,
        `(c) ttlMs=${badTtlMs}는 거부(null)해야 함`,
      );
    }
    // ttlMs=0은 비활성 의미로 허용되어야 함(비음수 정수).
    writeRawState({ ...VALID_BASE, startedAt: Date.now(), ttlMs: 0 });
    assert.ok(readTunnel() !== null, '(c) ttlMs=0은 통과해야 함(비활성)');
    console.log('PASS: (c) ttlMs 음수/실수 → null, ttlMs=0 통과');

    // (d) 두 필드가 없는 구버전 객체 → 통과(하위호환).
    //     실제 saveTunnel/readTunnel 왕복으로도 구버전 형태가 보존·통과됨을 함께 검증한다.
    clearTunnel();
    saveTunnel({ ...VALID_BASE });
    const legacy = readTunnel();
    assert.ok(legacy !== null, '(d) startedAt/ttlMs 없는 구버전 객체는 통과해야 함');
    assert.equal(legacy.startedAt, undefined, '(d) 구버전 객체엔 startedAt이 없어야 함');
    assert.equal(legacy.ttlMs, undefined, '(d) 구버전 객체엔 ttlMs가 없어야 함');
    console.log('PASS: (d) 두 필드 없는 구버전 객체 통과(하위호환)');

    // saveTunnel이 startedAt/ttlMs를 그대로 직렬화하는지(왕복 보존) 확인.
    const startedAt = Date.now();
    clearTunnel();
    saveTunnel({ ...VALID_BASE, startedAt, ttlMs: 120000 });
    const roundTrip = readTunnel();
    assert.equal(roundTrip.startedAt, startedAt, 'saveTunnel이 startedAt을 보존해야 함');
    assert.equal(roundTrip.ttlMs, 120000, 'saveTunnel이 ttlMs를 보존해야 함');
    console.log('PASS: saveTunnel startedAt/ttlMs 왕복 보존');

    // (e) [idle false-telemetry] idleMin 선택 필드 검증(startedAt/ttlMs와 동일 패턴).
    //     음수/실수는 거부, 0과 양의 정수는 통과, 미지정 구버전은 그대로 통과(하위호환).
    for (const badIdleMin of [-1, 1.5]) {
      writeRawState({ ...VALID_BASE, startedAt: Date.now(), idleMin: badIdleMin });
      assert.equal(readTunnel(), null, `(e) idleMin=${badIdleMin}는 거부(null)해야 함`);
    }
    writeRawState({ ...VALID_BASE, startedAt: Date.now(), idleMin: 0 });
    assert.ok(readTunnel() !== null, '(e) idleMin=0은 통과해야 함(비활성)');
    console.log('PASS: (e) idleMin 음수/실수 → null, idleMin=0/양의정수 통과');

    // idleMin 왕복 보존(saveTunnel→readTunnel) 확인.
    clearTunnel();
    saveTunnel({ ...VALID_BASE, startedAt, ttlMs: 120000, idleMin: 30 });
    const idleRoundTrip = readTunnel();
    assert.equal(idleRoundTrip.idleMin, 30, 'saveTunnel이 idleMin을 보존해야 함');
    console.log('PASS: saveTunnel idleMin 왕복 보존');
  } finally {
    // 기존 사용자 상태 복원(테스트가 사용자 파일을 덮어쓰지 않도록 보장).
    if (backup !== null) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(STATE_FILE, backup, { mode: 0o600 });
      try {
        chmodSync(STATE_FILE, 0o600);
      } catch {
        // 권한 조정 실패는 무시(내용은 이미 복원됨).
      }
    } else if (existsSync(STATE_FILE)) {
      // 테스트 시작 전 파일이 없었다면 우리가 만든 파일을 제거해 원상 복구한다.
      rmSync(STATE_FILE, { force: true });
    }
  }

  console.log('\n모든 스캐폴딩 테스트 통과 ✅');
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error('스캐폴딩 테스트 실패 ✗:', error.message);
  process.exit(1);
}
