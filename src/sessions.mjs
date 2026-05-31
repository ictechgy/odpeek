// 세션/연결 관측성(읽기 전용) — auth.log를 파싱해 인증 실패·잠금·고유 출발 IP·
// 종료(idle/TTL)·고아 kill 시도 같은 파생 신호를 집계한다(§결정 F1·H1, §2.1).
//
// 보안 불변(§원칙 3): 이 모듈은 어떤 파일도 쓰지 않고 어떤 프로세스 상태도 바꾸지 않는다
// (순수 함수 + 읽기 전용). 자격증명·전체 IP·raw 헤더·userinfo는 외부로 노출하지 않으며,
// IP 원본은 내부 집계용으로만 보관하고 외부 직렬화는 output.mjs의 maskIp가 책임진다.
//
// F1 한계(§결정 F1/Defect 3): auth.log에는 인증 성공/활동 라인이 없고 lastActivity는
// 프록시 클로저-로컬이라 idle 잔여는 구조적으로 도출 불가하다. 따라서 이 모듈은
// idle 잔여를 절대 다루지 않는다(uptime·TTL 잔여만 output.mjs의 tunnelTiming이 도출).
//
// 런타임 npm 의존성 0(stdlib만). 시각 파생은 호출자가 주입한 now에서 결정론적으로 만든다.

import { tunnelTiming } from './output.mjs';

// auth.log 라인 정규식(authProxy.mjs의 실제 로그 포맷에 정박).
// 각 라인은 `${new Date().toISOString()} ${line}\n` 형태이므로 ISO 접두 뒤의 본문을 매칭한다.
// authProxy.mjs:
//   AUTH_FAIL ip=.. sock=.. fails=.. path=..   (registerFailure)
//   LOCKOUT  ip=.. (N fails) for Nmin           (registerFailure, MAX_FAILS 도달)
//   LOCKED   ip=.. path=..[ (upgrade)]          (locked 상태)
//   TUNNEL_KILL cfPid=N matched=<true|false>    (scheduleShutdown, durable breadcrumb)

/** ISO8601 타임스탬프 접두를 포착하는 공통 조각(라인 맨 앞). */
const ISO_PREFIX = '(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z)';

/** `AUTH_FAIL ip=<ip> ...` — 인증 실패 1건. ip는 살균된(공백 없음) 값이다. */
const AUTH_FAIL_RE = new RegExp(`^${ISO_PREFIX}\\s+AUTH_FAIL\\s+ip=(\\S+)`);
/** `LOCKOUT ip=<ip> (N fails) for Nmin` — IP 잠금 발동 1건. */
const LOCKOUT_RE = new RegExp(`^${ISO_PREFIX}\\s+LOCKOUT\\s+ip=(\\S+)`);
/** `LOCKED ip=<ip> path=..` — 잠금 상태에서 차단된 요청(현재 잠금 활성 신호). */
const LOCKED_RE = new RegExp(`^${ISO_PREFIX}\\s+LOCKED\\s+ip=(\\S+)`);
/** `TUNNEL_KILL cfPid=<N> matched=<true|false>` — 종료 시 cloudflared kill 시도 breadcrumb. */
const TUNNEL_KILL_RE = new RegExp(`^${ISO_PREFIX}\\s+TUNNEL_KILL\\s+cfPid=(\\d+)\\s+matched=(true|false)`);

/**
 * auth.log 텍스트를 한 줄씩 파싱해 세션 관측 신호를 집계한다(읽기 전용·순수 함수).
 *
 * 집계 항목:
 * - recentAuthFailures: AUTH_FAIL 라인 수(최근 인증 실패 횟수).
 * - lockouts: LOCKOUT 라인 수(IP 잠금 발동 횟수).
 * - locked: LOCKED 라인이 하나라도 있으면 true(잠금 상태에서 차단된 요청이 있었음).
 * - uniqueSourceIps: AUTH_FAIL/LOCKOUT/LOCKED에서 모은 고유 IP 집합(내부용 raw, 외부 노출 시 maskIp).
 * - lastFailureAt: 가장 마지막 AUTH_FAIL의 ISO 타임스탬프(없으면 null).
 * - lastKillAttempt: 가장 최근 TUNNEL_KILL 라인을 {at, cfPid, matched}로(없으면 null).
 *   matched=false인 최근 라인은 "시그니처 불일치/ps 실패로 kill을 건너뛴 잠재 고아" 신호다.
 *
 * @param {string} text auth.log 전체 텍스트(미존재/빈 경우 호출자가 빈 문자열을 넘긴다)
 * @returns {{recentAuthFailures:number, lockouts:number, locked:boolean,
 *   uniqueSourceIps:Set<string>, lastFailureAt:(string|null),
 *   lastKillAttempt:({at:string, cfPid:number, matched:boolean}|null)}}
 */
export function parseAuthLog(text) {
  const result = {
    recentAuthFailures: 0,
    lockouts: 0,
    locked: false,
    uniqueSourceIps: new Set(),
    lastFailureAt: null,
    lastKillAttempt: null,
  };
  if (typeof text !== 'string' || text.length === 0) return result;

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    applyLineToResult(line, result);
  }
  return result;
}

/**
 * 한 로그 라인을 분류해 집계 결과에 반영한다(parseAuthLog 내부 헬퍼).
 * 라인 종류는 상호배타적이므로 첫 매칭에서 처리하고 반환한다.
 * @param {string} line 로그 한 줄(ISO 접두 포함)
 * @param {object} result 누적 집계 객체(제자리 변경)
 */
function applyLineToResult(line, result) {
  const authFail = line.match(AUTH_FAIL_RE);
  if (authFail) {
    result.recentAuthFailures += 1;
    result.lastFailureAt = authFail[1]; // 가장 마지막 AUTH_FAIL이 최종값으로 남는다.
    result.uniqueSourceIps.add(authFail[2]);
    return;
  }
  const lockout = line.match(LOCKOUT_RE);
  if (lockout) {
    result.lockouts += 1;
    result.uniqueSourceIps.add(lockout[2]);
    return;
  }
  const locked = line.match(LOCKED_RE);
  if (locked) {
    result.locked = true;
    result.uniqueSourceIps.add(locked[2]);
    return;
  }
  const kill = line.match(TUNNEL_KILL_RE);
  if (kill) {
    // 가장 최근 TUNNEL_KILL이 최종값으로 남는다(순차 스캔이므로 덮어쓰면 최신이 유지).
    result.lastKillAttempt = {
      at: kill[1],
      cfPid: Number(kill[2]),
      matched: kill[3] === 'true',
    };
  }
}

/**
 * 활성 터널 상태 + auth.log 파싱 결과를 합쳐 사람용/JSON 빌더에 넘길 sessions 뷰를 만든다(§2.1).
 *
 * [F1/Defect 3] idle 잔여는 다루지 않는다. 시간 파생(uptime·TTL 잔여)은 output.mjs의
 * tunnelTiming이 단독으로 책임지며, 여기서는 그 결과를 그대로 전달만 한다(거짓 보고 금지).
 *
 * 반환의 `sessions`는 buildSessionsJson이 그대로 받을 수 있는 형태다(uniqueSourceIps:Set·
 * ips:string[]를 함께 담아 빌더가 maskIp로 변환·집계하게 한다 — raw IP는 빌더 밖으로 나가지 않는다).
 * `potentialOrphan`은 lastKillAttempt.matched===false일 때 파생되는 잠재-고아 신호다.
 *
 * @param {object} params
 *   - tunnelState: readTunnel() 결과(또는 null)
 *   - authLogText: auth.log 전체 텍스트(미존재/빈 경우 빈 문자열)
 *   - now: 기준 시각(epoch ms). 테스트 결정성을 위해 호출자가 주입한다.
 * @returns {{tunnelState:(object|null), timing:object, sessions:object,
 *   lastKillAttempt:(object|null), potentialOrphan:boolean, locked:boolean}}
 */
export function buildSessionsView({ tunnelState, authLogText, now }) {
  const parsed = parseAuthLog(authLogText);
  const timing = tunnelTiming(tunnelState ?? {}, now);
  // matched=false인 가장 최근 kill 시도 = kill을 건너뛴 잠재 고아 신호(증거 기반 탐지).
  const potentialOrphan = parsed.lastKillAttempt !== null && parsed.lastKillAttempt.matched === false;

  return {
    tunnelState: tunnelState ?? null,
    timing,
    // buildSessionsJson이 maskIp로 변환·집계하도록 raw IP를 함께 넘긴다(빌더 밖 미노출).
    sessions: {
      recentAuthFailures: parsed.recentAuthFailures,
      lockouts: parsed.lockouts,
      uniqueSourceIps: parsed.uniqueSourceIps,
      ips: [...parsed.uniqueSourceIps],
      lastFailureAt: parsed.lastFailureAt,
    },
    lastKillAttempt: parsed.lastKillAttempt,
    potentialOrphan,
    locked: parsed.locked,
  };
}
