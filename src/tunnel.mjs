// cloudflared 빠른 터널 상태 관리 + URL 추출 헬퍼.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs';

const STATE_DIR = join(homedir(), '.odpeek');
const STATE_FILE = join(STATE_DIR, 'tunnel.json');

// cloudflared 프로세스의 stdout/stderr 로그(여기서 공개 URL을 파싱한다).
export const CF_LOG = join(STATE_DIR, 'cloudflared.log');

// 공개 URL 호스트 형식. 추출용(앵커 없음)과 검증용(앵커 있음)이 같은 정의를 공유해
// 한쪽만 바뀌어 추출/검증이 어긋나는 일을 막는다(가짜 URL 주입 방어).
const TRYCLOUDFLARE_HOST = '[a-z0-9-]+\\.trycloudflare\\.com';
const TRYCLOUDFLARE_URL = new RegExp(`^https://${TRYCLOUDFLARE_HOST}$`, 'i');

/** 상태 디렉토리를 보장한다(소유자 전용 0700 — 타 로컬 사용자 열람 차단). */
export function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // 이미 존재하던 디렉토리는 mode 인자가 적용되지 않으므로 강제 조정한다.
  try {
    chmodSync(STATE_DIR, 0o700);
  } catch {
    // 권한 조정 실패는 치명적이지 않음(상태 저장은 계속 진행)
  }
}

/** 양의 정수인지 확인한다(포트/PID 검증용). */
function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** 1~65535 범위의 포트인지 확인한다. */
export function isValidPort(value) {
  return isPositiveInt(value) && value <= 65535;
}

/**
 * 터널 상태(pid/포트/url 등)를 소유자 전용(0600)으로 저장한다.
 * 임의 객체를 그대로 직렬화하므로 호출부가 넘기는 선택 필드도 함께 기록된다.
 * - `startedAt`(epoch ms 양의 정수): proxy spawn 직전에 캡처한 단일 t0.
 *   proxy의 TTL `setTimeout`과 동일 기준이라 uptime·TTL 잔여 계산이 발화 시각과 정합한다.
 * - `ttlMs`(0 이상 정수, 선택): TTL hard-cap 절대 데드라인(분→ms). 0이면 비활성.
 */
export function saveTunnel(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  // 기존 파일은 mode 인자가 무시되므로 권한을 강제한다.
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {
    // 권한 조정 실패는 무시(상태는 이미 기록됨)
  }
}

/**
 * 저장된 터널 상태를 읽고 스키마를 검증한다.
 * 파일이 변조돼 잘못된 PID/포트가 들어와도 그대로 신뢰하지 않도록 방어한다.
 * @returns {object|null} 검증된 상태, 없거나 손상/형식 위반이면 null
 */
export function readTunnel() {
  if (!existsSync(STATE_FILE)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // PID는 양의 정수, 포트는 유효 범위, url은 trycloudflare 형식일 때만 통과시킨다.
  if (parsed.cfPid !== undefined && !isPositiveInt(parsed.cfPid)) return null;
  if (parsed.proxyPid !== undefined && !isPositiveInt(parsed.proxyPid)) return null;
  if (parsed.authPort !== undefined && !isValidPort(parsed.authPort)) return null;
  if (parsed.targetPort !== undefined && !isValidPort(parsed.targetPort)) return null;
  if (parsed.url !== undefined && parsed.url !== null && !TRYCLOUDFLARE_URL.test(parsed.url)) {
    return null;
  }
  // startedAt/ttlMs는 v0.2에서 추가된 선택 필드다(단일 t0·TTL 잔여 계산용).
  // 선택 필드라 값이 있을 때만 검증하므로, 두 필드가 없는 구버전 tunnel.json은 그대로 통과한다(하위호환).
  if (parsed.startedAt !== undefined && !isPositiveInt(parsed.startedAt)) return null;
  if (parsed.ttlMs !== undefined && !(Number.isInteger(parsed.ttlMs) && parsed.ttlMs >= 0)) return null;
  // idleMin도 v0.2 선택 필드다(idle 활성 여부 보고용). startedAt/ttlMs와 동일 패턴으로 검증해
  // 변조된 음수/비정수를 거르고, 미저장 구버전은 그대로 통과시킨다(하위호환).
  if (parsed.idleMin !== undefined && !(Number.isInteger(parsed.idleMin) && parsed.idleMin >= 0)) return null;
  return parsed;
}

/** 저장된 터널 상태를 제거한다. */
export function clearTunnel() {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}

/** 해당 PID가 살아있는지 확인한다. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 해당 PID의 명령줄에 needle 문자열이 포함되는지 확인한다(PID 재사용 방어).
 * kill 전에 호출하여, 재부팅·크래시로 PID가 다른 프로세스에 재할당된 경우
 * 무관한 프로세스를 종료하지 않도록 한다.
 * @returns {boolean} 명령줄에 needle이 있으면 true (확인 불가 시 false → 보수적)
 */
export function processMatches(pid, needle) {
  if (!isPositiveInt(pid) || !needle) return false;
  try {
    // -ww: 명령줄을 절단 없이 전부 출력(긴 BIN_PATH 뒤의 needle이 잘리지 않게).
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    return command.includes(needle);
  } catch {
    // ps 실패(프로세스 없음 등) → 확인 불가이므로 kill하지 않는다.
    return false;
  }
}

/**
 * cloudflared 로그 텍스트에서 trycloudflare 공개 URL을 추출한다.
 * @returns {string|null} 예: "https://abc-def.trycloudflare.com"
 */
export function extractTrycloudflareUrl(text) {
  const match = text.match(new RegExp(`https://${TRYCLOUDFLARE_HOST}`, 'i'));
  return match ? match[0] : null;
}
