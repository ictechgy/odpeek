// Open Design 데몬의 웹 UI 포트를 자동 감지한다.
// OD는 재시작할 때마다 랜덤 고포트를 쓰므로 실행 중인 프로세스에서 동적으로 찾아야 한다.
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

// OD 웹 UI를 서빙하는 사이드카 프로세스의 명령줄 매칭 패턴(정규식 문자열).
export const DEFAULT_PATTERN = 'web-sidecar\\.mjs';

/**
 * 패턴에 매칭되는 첫 프로세스의 PID를 반환한다.
 * @returns {number|null} PID, 매칭 없으면 null
 */
function findPid(pattern) {
  try {
    const output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    const first = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return first ? Number(first) : null;
  } catch {
    // pgrep는 매칭이 없으면 비0으로 종료하므로 null로 처리한다.
    return null;
  }
}

/**
 * 주어진 PID가 LISTEN 중인 첫 TCP 포트를 반환한다.
 * @returns {number|null} 포트 번호, 없으면 null
 */
function listeningPort(pid) {
  // lsof는 macOS/Linux 공통으로 존재한다. -a 로 PID 조건과 LISTEN 조건을 AND 결합한다.
  const output = execFileSync(
    'lsof',
    ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
    { encoding: 'utf8' },
  );
  for (const line of output.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Open Design 웹 UI의 현재 로컬 포트를 감지한다.
 * @param {string} pattern OD 프로세스 매칭 패턴
 * @returns {{pid: number, port: number}}
 * @throws OD가 실행 중이 아니거나 포트를 찾지 못하면 에러
 */
export function detectWebPort(pattern = DEFAULT_PATTERN) {
  if (platform() === 'win32') {
    throw new Error('Windows는 아직 지원하지 않습니다 (lsof/pgrep 의존).');
  }
  const pid = findPid(pattern);
  if (!pid) {
    throw new Error(
      'Open Design web-sidecar 프로세스를 찾을 수 없습니다. OD가 실행 중인지 확인하세요.',
    );
  }
  const port = listeningPort(pid);
  if (!port) {
    throw new Error(`PID ${pid}의 LISTEN 포트를 찾지 못했습니다.`);
  }
  return { pid, port };
}
