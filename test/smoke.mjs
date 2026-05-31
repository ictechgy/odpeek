// odpeek 인증 프록시 스모크 테스트.
// 외부 의존성 없이, 실제 CLI(__authproxy)를 분리 프로세스로 띄워
// 핵심 보안 동작을 검증한다: 무인증 401, 정상 인증 200, 틀린/빈 자격 거부,
// 잘못된 포트·빈 자격 기동 거부, 보안 헤더 적용.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const BIN = fileURLToPath(new URL('../bin/odpeek.mjs', import.meta.url));
const USER = 'od';
const PASS = 's3cret-pass';
const LOG_FILE = join(tmpdir(), 'odpeek-smoke.log');

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

/** 프록시에 GET 요청을 보낸다(선택적 Basic 자격). */
function request(port, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', headers, timeout: 2000, agent: false },
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

/** __authproxy 분리 프로세스를 띄운다. */
function spawnProxy(listenPort, targetPort, env) {
  return spawn(
    process.execPath,
    [BIN, '__authproxy', String(listenPort), String(targetPort), '0', LOG_FILE],
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...env } },
  );
}

/** 자식 프로세스의 종료 코드를 기다린다. */
function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

async function main() {
  const upstream = await startUpstream();
  const targetPort = upstream.address().port;
  const listenPort = await freePort();
  const proxy = spawnProxy(listenPort, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS });

  try {
    await waitReady(listenPort);

    // 1) 무인증 → 401 + 챌린지 + 보안 헤더
    const noauth = await request(listenPort);
    assert.equal(noauth.status, 401, '무인증 요청은 401이어야 함');
    assert.match(String(noauth.headers['www-authenticate'] || ''), /realm="odpeek"/, '401 챌린지 realm');
    assert.equal(noauth.headers['x-content-type-options'], 'nosniff', '보안 헤더가 적용되어야 함');

    // 2) 올바른 자격 → 200 + upstream 본문 전달
    const ok = await request(listenPort, { auth: `${USER}:${PASS}` });
    assert.equal(ok.status, 200, '올바른 자격은 200이어야 함');
    assert.equal(ok.body, 'ok-upstream', 'upstream 본문을 전달해야 함');

    // 3) 틀린 비밀번호 → 401
    const wrong = await request(listenPort, { auth: `${USER}:wrong` });
    assert.equal(wrong.status, 401, '틀린 자격은 401이어야 함');

    // 4) 빈 비밀번호 Basic 헤더(od:) → 통과 금지(인증 우회 차단)
    const emptyAttempt = await request(listenPort, { auth: `${USER}:` });
    assert.equal(emptyAttempt.status, 401, '빈 비밀번호 Basic 헤더는 거부해야 함');

    console.log('PASS: 인증 프록시 HTTP 동작 (401 / 200 / 틀린자격 / 빈비번)');
  } finally {
    proxy.kill();
    await waitExit(proxy).catch(() => {});
  }

  // 5) 빈 ODPEEK_PASS로 기동 → 즉시 거부(exit 1)
  const emptyProxy = spawnProxy(await freePort(), targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: '' });
  assert.equal(await waitExit(emptyProxy), 1, '빈 ODPEEK_PASS면 기동을 거부(exit 1)해야 함');
  console.log('PASS: 빈 자격 기동 거부 (exit 1)');

  // 6) 잘못된 listen 포트(0)로 기동 → 거부(exit 1)
  const badPortProxy = spawnProxy(0, targetPort, { ODPEEK_USER: USER, ODPEEK_PASS: PASS });
  assert.equal(await waitExit(badPortProxy), 1, '잘못된 listen 포트면 기동을 거부(exit 1)해야 함');
  console.log('PASS: 잘못된 포트 기동 거부 (exit 1)');

  upstream.close();
  rmSync(LOG_FILE, { force: true });
  console.log('\n모든 스모크 테스트 통과 ✅');
  process.exit(0);
}

main().catch((error) => {
  console.error('스모크 테스트 실패 ✗:', error.message);
  process.exit(1);
});
