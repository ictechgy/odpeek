// Open Design 데몬의 웹 UI 포트를 자동 감지한다.
// OD는 재시작할 때마다 랜덤 고포트를 쓰므로 실행 중인 프로세스에서 동적으로 찾아야 한다.
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

// OD 웹 UI를 서빙하는 사이드카 프로세스의 명령줄 매칭 패턴(정규식 문자열).
export const DEFAULT_PATTERN = 'web-sidecar\\.mjs';

/**
 * 패턴에 매칭되는 프로세스들의 PID 목록을 반환한다.
 * 자기 자신(이 CLI 프로세스)과 부모는 오매칭을 피하기 위해 제외한다.
 * @returns {number[]} 매칭된 PID 배열(매칭 없으면 빈 배열)
 * @throws pgrep 실행 자체가 실패(미설치/권한)하면 에러
 */
function findPids(pattern) {
  let output;
  try {
    output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  } catch (error) {
    // pgrep는 매칭이 없으면 exit code 1로 끝난다(status === 1). 이는 정상.
    if (error.status === 1) return [];
    // 그 외(ENOENT=미설치, 권한 등)는 무매칭과 구분해 에러로 올린다.
    if (error.code === 'ENOENT') {
      throw new Error('pgrep을 찾을 수 없습니다. macOS/Linux에서 실행하세요.');
    }
    throw new Error(`프로세스 검색 실패(pgrep): ${error.message}`);
  }
  const exclude = new Set([process.pid, process.ppid]);
  return output
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !exclude.has(pid));
}

/**
 * 주어진 PID가 LISTEN 중인 TCP 포트들을 중복 없이 반환한다.
 * IPv4/IPv6가 같은 포트를 두 줄로 보여도 Set으로 합쳐 한 번만 센다.
 * @returns {number[]} 포트 배열(없으면 빈 배열)
 */
function listeningPorts(pid) {
  // lsof는 macOS/Linux 공통으로 존재한다. -a 로 PID 조건과 LISTEN 조건을 AND 결합한다.
  const output = execFileSync(
    'lsof',
    ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
    { encoding: 'utf8' },
  );
  const ports = new Set();
  for (const line of output.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

/**
 * Open Design 웹 UI의 현재 로컬 포트를 감지한다.
 * @param {string} pattern OD 프로세스 매칭 패턴
 * @returns {{pid: number, port: number}}
 * @throws OD 미실행, 다중 매칭(오노출 위험), 포트 미발견 시 에러
 */
export function detectWebPort(pattern = DEFAULT_PATTERN) {
  if (platform() === 'win32') {
    throw new Error('Windows는 아직 지원하지 않습니다 (lsof/pgrep 의존).');
  }
  const pids = findPids(pattern);
  if (pids.length === 0) {
    throw new Error(
      'Open Design web-sidecar 프로세스를 찾을 수 없습니다. OD가 실행 중인지 확인하세요.',
    );
  }
  // 패턴이 너무 넓어 여러 프로세스가 잡히면, 엉뚱한 로컬 서비스를 공개로 노출할
  // 위험이 있으므로 임의 선택하지 않고 중단한다.
  if (pids.length > 1) {
    throw new Error(
      `패턴 "${pattern}"이 여러 프로세스(${pids.join(', ')})에 매칭됩니다. ` +
        '--pattern으로 더 구체적인 패턴을 지정하세요(엉뚱한 서비스 노출 방지).',
    );
  }
  const pid = pids[0];
  const ports = listeningPorts(pid);
  if (ports.length === 0) {
    throw new Error(`PID ${pid}의 LISTEN 포트를 찾지 못했습니다.`);
  }
  // 한 프로세스가 여러 포트를 LISTEN 중이면 어느 것이 웹 UI인지 모호하다.
  // 임의로 골라 엉뚱한 로컬 서비스를 공개 노출하지 않도록 중단한다.
  if (ports.length > 1) {
    throw new Error(
      `PID ${pid}가 여러 포트(${ports.join(', ')})를 LISTEN 중입니다. ` +
        '--pattern으로 OD web-sidecar만 매칭되도록 좁혀 주세요(엉뚱한 서비스 노출 방지).',
    );
  }
  return { pid, port: ports[0] };
}
