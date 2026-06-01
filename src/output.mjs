// `--json` 공유 envelope 빌더(§결정 H1 스키마).
// status/doctor/sessions 세 명령이 동일한 안정 envelope의 부분집합을 채운다.
//
// 보안 불변(§원칙 3): 비밀번호·전체 IP·raw 헤더·URL userinfo는 어떤 출력에도
// 절대 포함하지 않는다. IP는 maskIp로만 노출하고, idle 잔여처럼 F1(읽기 전용)에서
// 도출 불가한 값은 거짓으로 채우지 않고 항상 null로 정직하게 표기한다(§결정 F1/Defect 3).
//
// 순수 함수 모듈: 파일 IO·부작용·런타임 npm 의존성이 일절 없다(stdlib만, 테스트 결정성).
// 시각(generatedAt 등)은 호출자가 주입한 now(epoch ms)에서 파생해 결정론적으로 만든다.

import net from 'node:net';

// `new Date(now).toISOString()`이 throw 없이 직렬화 가능한 epoch ms의 유효 범위.
// ECMAScript Date는 ±8.64e15ms(±100,000,000일)만 표현 가능하다. 이 범위를 벗어나거나
// 비유한(NaN/Infinity)인 now는 안전 폴백(0 = 1970-01-01T00:00:00.000Z)으로 정규화한다.
const MAX_TIME_MS = 8.64e15;

/** envelope 스키마 버전. 소비자가 키 구조를 안전하게 파싱하도록 고정한다. */
const SCHEMA_VERSION = 1;

/**
 * 값이 유한수면 그대로, 아니면 null로 병합한다.
 * `JSON.stringify({x:NaN})`는 `{"x":null}`을 만들지만, 그건 "유한수" 스키마의
 * 비-null 약속을 우회로 위반한 것이다. 시간 필드를 직렬화 전에 명시적으로 null로
 * 병합해 NaN/Infinity가 결과 JSON에 새지 않도록 한다(§H1·§2.1).
 * @param {*} value 검사할 값
 * @returns {number|null} 유한수면 value, 아니면 null
 */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** 양의 정수인지 확인한다(startedAt 검증용 — tunnel.mjs의 isPositiveInt와 동일 기준). */
function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * 입력이 유효한 IP일 때만 마스킹하고, 비IP/호스트네임 등은 raw 일부도 노출하지 않는다(§원칙 3).
 *
 * 먼저 `net.isIP()`로 IP 종류를 판정한다(문자열 split 휴리스틱보다 안전 — 비IP/IPv4-mapped를
 * 부분 노출하는 결함을 막는다).
 * - IPv4(isIP===4): 앞 2옥텟만 남기고 뒤 2옥텟을 'x.x'로 가린다(예: '100.64.12.34' → '100.64.x.x').
 * - IPv6(isIP===6):
 *   - IPv4-mapped(`::ffff:a.b.c.d`)는 내부 IPv4(a.b.c.d)로 정규화한 뒤 IPv4 규칙으로 마스킹한다
 *     (mapped 주소의 내부 IPv4가 부분 노출되는 결함 방지).
 *   - 그 외 IPv6는 앞 1~2 hextet만 남기고 끝 hextet은 절대 노출하지 않는다
 *     (예: '2001:db8::1' → '2001:db8:x', 'fe80::1' → 'fe80:x', '::1' → 'x').
 * - isIP()===0(비IP·호스트네임·부분/비정상 입력): raw 일부도 노출하지 않고 고정 placeholder 'x.x.x.x'.
 * @param {string} ip 마스킹할 IP 문자열
 * @returns {string} 마스킹된 IP. 비IP/비문자열/빈 값이면 'x.x.x.x'
 * @note raw IP는 절대 반환하지 않는다. 호출자는 항상 이 함수를 거쳐야 한다.
 */
export function maskIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return 'x.x.x.x';
  const kind = net.isIP(ip);
  if (kind === 4) return maskIpv4(ip);
  if (kind === 6) return maskIpv6(ip);
  // isIP()===0: 비IP/호스트네임/부분 입력 — raw를 절대 노출하지 않고 고정 placeholder.
  return 'x.x.x.x';
}

/**
 * 검증된 IPv4를 앞 2옥텟만 남기고 마스킹한다(maskIp 내부 헬퍼, 입력은 isIP()===4 보장).
 * @param {string} ip 유효한 IPv4 문자열
 * @returns {string} 'a.b.x.x' 형태
 */
function maskIpv4(ip) {
  const head = ip.split('.').slice(0, 2).join('.');
  return `${head}.x.x`;
}

/**
 * 검증된 IPv6를 마스킹한다(maskIp 내부 헬퍼, 입력은 isIP()===6 보장).
 * IPv4-mapped(`::ffff:a.b.c.d`)는 내부 IPv4로 정규화 후 IPv4 규칙으로 마스킹하고,
 * 그 외에는 앞 1~2 hextet만 남기고 끝 hextet은 노출하지 않는다.
 * @param {string} ip 유효한 IPv6 문자열
 * @returns {string} 'a.b.x.x'(mapped) 또는 'h1:h2:x' / 'h1:x' / 'x'
 */
function maskIpv6(ip) {
  // IPv4-mapped(::ffff:a.b.c.d 또는 ::a.b.c.d 등) — 마지막 콜론 뒤가 점 표기면 내부 IPv4.
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.') && net.isIP(tail) === 4) {
    return maskIpv4(tail);
  }
  // 일반 IPv6: split(':')에서 빈 문자열이 아닌 앞 1~2 hextet만 프리픽스로 쓴다.
  // 빈 항목('::'의 '' 부분)은 압축 경계이므로 그 이전까지만 안전하게 노출한다.
  const prefix = [];
  for (const part of ip.split(':')) {
    if (part.length === 0) break; // '::' 경계 도달 → 이후는 낮은 hextet이므로 중단
    prefix.push(part);
    if (prefix.length === 2) break; // 최대 2 hextet
  }
  return prefix.length > 0 ? `${prefix.join(':')}:x` : 'x';
}

/**
 * 터널 상태에서 시간 파생값(uptime/idle/ttl)을 계산한다(§결정 F1·G·H1).
 *
 * startedAt이 양의 정수가 아니면(undefined·null·0·음수·실수 포함; 구버전 tunnel.json
 * 업그레이드 안전) 어떤 시간 값도 도출할 수 없으므로 전부 null을 돌려준다.
 *
 * startedAt이 정상일 때만:
 * - uptimeSec = floor((now − startedAt)/1000). now가 startedAt보다 작은(시계 역행)
 *   비정상이면 Number.isFinite 병합으로 안전하게 처리한다.
 * - ttl: state.ttlMs > 0이면 {enabled:true, ttlMin, remainingSec} (remainingSec은
 *   0 미만으로 내려가지 않게 max(0, ...)), 아니면 null.
 * - idle: {enabled, idleMin, remainingSec:null}. [Defect 3] idle 잔여는 F1(읽기 전용
 *   로그·상태 파싱) 하에서 구조적으로 도출 불가하므로 remainingSec은 **항상 null**이다.
 *   숫자로 채우는 것은 거짓 보고이며 §원칙 3/Driver 2 위반. 실제 idle 잔여는
 *   F2(IPC/AUTH_OK 로그) 범위 변경 follow-up으로만 가능하다.
 *
 * 모든 시간 필드는 finiteOrNull로 병합해 NaN/Infinity 직렬화를 차단한다.
 *
 * @param {object} state 터널 상태. {startedAt?, ttlMs?, idleMs?, idleMin?} 등을 읽는다.
 * @param {number} now 기준 시각(epoch ms). 테스트 결정성을 위해 호출자가 주입한다.
 * @returns {{uptimeSec:number|null, idle:object|null, ttl:object|null}}
 */
export function tunnelTiming(state, now) {
  const startedAt = state?.startedAt;
  // startedAt이 양의 정수가 아니면 어떤 시간 값도 신뢰 도출 불가 → 전부 null(구버전 안전).
  if (!isPositiveInt(startedAt)) {
    return { uptimeSec: null, idle: null, ttl: null };
  }

  const elapsedMs = now - startedAt;
  // [generatedAt/uptime 가드] 시계 롤백(now < startedAt)으로 음수 경과가 나오면 거짓 음수 대신
  // 0으로 클램프한다(다른 시간 필드의 비음수 정책과 일관). 비유한은 finiteOrNull로 null 병합.
  const uptimeSec = finiteOrNull(Math.max(0, Math.floor(elapsedMs / 1000)));

  // idle: enabled/idleMin은 tunnel.json/env에서 알 수 있으나 remainingSec은 항상 null.
  const idle = buildIdleView(state);

  // ttl: ttlMs가 양수일 때만 활성. 잔여는 음수로 내려가지 않게 max(0, ...).
  const ttl = buildTtlView(state, elapsedMs);

  return { uptimeSec, idle, ttl };
}

/**
 * idle 뷰를 만든다. [Defect 3] remainingSec은 F1 하에서 항상 null(거짓 보고 금지).
 *
 * [Defect/idle false-telemetry] idle 정보(idleMs 또는 idleMin)가 상태에 **전혀 없으면**
 * 활성 여부를 알 수 없으므로 `enabled:false`로 거짓 단정하지 않고 `null`(unknown)을 돌려준다
 * (구버전 tunnel.json은 idleMin을 저장하지 않으므로 이 경로로 들어온다).
 * 정보가 있으면(idleMs>0 또는 idleMin>=0) enabled/idleMin을 정확히 도출한다.
 * @param {object} state 터널 상태({idleMs?, idleMin?})
 * @returns {{enabled:boolean, idleMin:number|null, remainingSec:null}|null}
 */
function buildIdleView(state) {
  // idleMs(밀리초) 또는 idleMin(분) 중 알 수 있는 쪽에서 활성 여부를 도출한다.
  const idleMs = Number(state?.idleMs);
  const hasIdleMs = Number.isFinite(idleMs) && idleMs >= 0 && state?.idleMs !== undefined;
  const idleMinRaw = Number(state?.idleMin);
  const hasIdleMin = Number.isFinite(idleMinRaw) && idleMinRaw >= 0 && state?.idleMin !== undefined;
  // idle 정보가 전혀 없으면(구버전 tunnel.json) 거짓 단정 금지 → null(unknown).
  if (!hasIdleMs && !hasIdleMin) return null;

  const idleMinFromMs = hasIdleMs ? Math.round(idleMs / 60000) : null;
  const idleMin = hasIdleMin ? idleMinRaw : idleMinFromMs;
  // 활성 여부는 양수 idle 값일 때만 true(0=비활성으로 명시 저장된 경우 enabled:false).
  const enabled = (hasIdleMs && idleMs > 0) || (Number.isFinite(idleMin) && idleMin > 0);
  return { enabled, idleMin: enabled ? finiteOrNull(idleMin) : null, remainingSec: null };
}

/**
 * ttl 뷰를 만든다. ttlMs가 양수일 때만 활성이고, 그 외(0·미설정·비정수)는 null.
 * remainingSec = max(0, ceil((ttlMs − elapsedMs)/1000)).
 * @param {object} state 터널 상태({ttlMs?})
 * @param {number} elapsedMs now − startedAt(ms)
 * @returns {{enabled:true, ttlMin:number|null, remainingSec:number|null}|null}
 */
function buildTtlView(state, elapsedMs) {
  const ttlMs = Number(state?.ttlMs);
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) return null;
  const ttlMin = finiteOrNull(Math.round(ttlMs / 60000));
  const remainingSec = finiteOrNull(Math.max(0, Math.ceil((ttlMs - elapsedMs) / 1000)));
  return { enabled: true, ttlMin, remainingSec };
}

/**
 * 터널 상태에서 envelope의 `tunnel` 블록을 만든다(없으면 null).
 * url은 그대로 싣되, trycloudflare URL에는 userinfo가 없음을 readTunnel 검증이 보장한다.
 * 비밀번호는 상태에 저장되지 않으므로(현재 user만 저장) 노출 위험 없음.
 *
 * [running false-telemetry] `running`은 cf 프로세스 생존 여부를 반영해야 한다(무조건 true 금지).
 * 순수성 유지를 위해 liveness를 직접 판정하지 않고(부작용 없음) 호출자가 인자로 주입한다
 * (cli.mjs gatherJsonInputs에서 isAlive로 계산 — 텍스트 cmdStatus의 판정과 일관).
 * @param {object|null} tunnelState readTunnel() 결과(또는 null)
 * @param {number} now 기준 시각(epoch ms)
 * @param {boolean} running cf 프로세스 생존 여부(호출자가 주입, 부작용 없는 순수 입력)
 * @returns {object|null} tunnel 블록 또는 null
 */
function buildTunnelBlock(tunnelState, now, running) {
  if (!tunnelState || typeof tunnelState !== 'object') return null;
  const { uptimeSec, idle, ttl } = tunnelTiming(tunnelState, now);
  return {
    running: Boolean(running),
    url: typeof tunnelState.url === 'string' ? tunnelState.url : null,
    uptimeSec,
    idle,
    ttl,
  };
}

/**
 * openDesign 감지 결과를 envelope 형태로 정규화한다.
 * 감지 성공이면 {detected:true, port, pid}, 실패면 {detected:false, reason}.
 * @param {object|null} openDesign {pid, port} 또는 {detected:false, reason} 또는 null
 * @returns {{detected:boolean, port?:number, pid?:number, reason?:string}}
 */
function buildOpenDesignBlock(openDesign) {
  if (openDesign && typeof openDesign === 'object'
    && Number.isInteger(openDesign.port) && Number.isInteger(openDesign.pid)) {
    return { detected: true, port: openDesign.port, pid: openDesign.pid };
  }
  const reason = openDesign && typeof openDesign.reason === 'string'
    ? openDesign.reason
    : 'Open Design 미감지';
  return { detected: false, reason };
}

/**
 * now(epoch ms)를 ISO8601로 안전하게 직렬화한다.
 * [generatedAt 미가드] now가 NaN/Infinity이거나 Date 표현 범위(±8.64e15ms)를 벗어나면
 * `new Date(now).toISOString()`이 RangeError를 던진다. 이를 막기 위해 비유한·범위초과 now는
 * 안전 폴백(epoch 0 = 1970-01-01T00:00:00.000Z)으로 정규화한 뒤 직렬화한다.
 * @param {number} now 기준 시각(epoch ms)
 * @returns {string} ISO8601 문자열(throw 없음)
 */
function toIsoSafe(now) {
  const safe = Number.isFinite(now) && Math.abs(now) <= MAX_TIME_MS ? now : 0;
  return new Date(safe).toISOString();
}

/**
 * 공통 envelope 베이스를 만든다(schemaVersion·command·generatedAt·tunnel·openDesign).
 * generatedAt은 주입된 now(epoch ms)에서 ISO8601로 파생해 결정론을 보장한다(범위초과/NaN 안전 폴백).
 * @param {string} command 'status' | 'doctor' | 'sessions'
 * @param {object} params {tunnelState, openDesign, now, running}
 *   - running: cf 프로세스 생존 여부(호출자가 isAlive로 계산해 주입; tunnel.running에 반영)
 * @returns {object} envelope 베이스
 */
function buildEnvelopeBase(command, { tunnelState, openDesign, now, running }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    generatedAt: toIsoSafe(now),
    tunnel: buildTunnelBlock(tunnelState, now, running),
    openDesign: buildOpenDesignBlock(openDesign),
  };
}

/**
 * `status --json` envelope를 만든다(§H1). tailscale 블록을 포함한다.
 * @param {object} params {tunnelState, openDesign, tailscale, now, running}
 *   - tunnelState: readTunnel() 결과(또는 null)
 *   - openDesign: detectWebPort 결과({pid,port}) 또는 {detected:false,reason}
 *   - tailscale: tailscale 상태 요약 객체(전체 IP·자격증명 미포함이어야 함)
 *   - now: 기준 시각(epoch ms)
 *   - running: cf 프로세스 생존 여부(호출자가 isAlive로 계산해 주입; tunnel.running에 반영)
 * @returns {object} schemaVersion:1 envelope(command:'status')
 */
export function buildStatusJson({ tunnelState, openDesign, tailscale, now, running }) {
  const envelope = buildEnvelopeBase('status', { tunnelState, openDesign, now, running });
  envelope.tailscale = tailscale ?? null;
  return envelope;
}

/**
 * `doctor --json` envelope를 만든다(§H1). tailscale 블록을 포함한다.
 * @param {object} params {tunnelState, openDesign, tailscale, now, running}
 *   - running: cf 프로세스 생존 여부(호출자가 isAlive로 계산해 주입; tunnel.running에 반영)
 * @returns {object} schemaVersion:1 envelope(command:'doctor')
 */
export function buildDoctorJson({ tunnelState, openDesign, tailscale, now, running }) {
  const envelope = buildEnvelopeBase('doctor', { tunnelState, openDesign, now, running });
  envelope.tailscale = tailscale ?? null;
  return envelope;
}

/**
 * `sessions --json` envelope를 만든다(§H1). sessions 블록을 포함한다.
 * sessions 집계의 IP는 maskIp로만 노출하며(ipsMasked), raw IP·비밀번호·userinfo는
 * 절대 포함하지 않는다(§원칙 3). idle 잔여는 tunnel.idle.remainingSec===null로 정직 표기.
 * @param {object} params {tunnelState, sessions, openDesign?, now, running}
 *   - sessions: 로그 파서 집계 결과(원시 IP가 들어올 수 있으나 여기서 마스킹).
 *     {recentAuthFailures, lockouts, uniqueSourceIps:Set|number, ips:string[], lastFailureAt}
 *   - now: 기준 시각(epoch ms)
 *   - running: cf 프로세스 생존 여부(호출자가 isAlive로 계산해 주입; tunnel.running에 반영)
 * @returns {object} schemaVersion:1 envelope(command:'sessions')
 */
export function buildSessionsJson({ tunnelState, sessions, openDesign, now, running }) {
  const envelope = buildEnvelopeBase('sessions', { tunnelState, openDesign, now, running });
  envelope.sessions = buildSessionsBlock(sessions);
  return envelope;
}

/**
 * sessions 집계를 envelope 형태로 정규화하고 IP를 마스킹한다.
 * raw IP를 절대 싣지 않으며, 들어온 IP 후보를 maskIp로 변환해 ipsMasked로만 노출한다.
 * @param {object|null} sessions 로그 파서 집계 결과
 * @returns {object} sessions 블록
 */
function buildSessionsBlock(sessions) {
  const source = sessions && typeof sessions === 'object' ? sessions : {};
  // uniqueSourceIps는 Set 또는 숫자(이미 카운트된 값)로 들어올 수 있다.
  const uniqueSourceIps = source.uniqueSourceIps instanceof Set
    ? source.uniqueSourceIps.size
    : finiteOrNull(Number(source.uniqueSourceIps)) ?? 0;
  // IP 후보 컬렉션(Set/배열)을 마스킹된 형태로만 변환한다(raw 미노출).
  const rawIps = source.ips instanceof Set
    ? [...source.ips]
    : (Array.isArray(source.ips) ? source.ips : []);
  const ipsMasked = rawIps.map((ip) => maskIp(ip));
  return {
    recentAuthFailures: finiteOrNull(Number(source.recentAuthFailures)) ?? 0,
    lockouts: finiteOrNull(Number(source.lockouts)) ?? 0,
    uniqueSourceIps,
    ipsMasked,
    lastFailureAt: typeof source.lastFailureAt === 'string' ? source.lastFailureAt : null,
  };
}
