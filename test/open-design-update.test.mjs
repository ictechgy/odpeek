// 최신 Open Design 호환성 회귀 테스트.
//  - 개발형 web sidecar(apps/web/sidecar/index.ts)와 tsx 래퍼의 비리스닝 PID를 허용한다.
//  - 공개 터널과 같은 Host의 Origin만 로컬 web sidecar Origin으로 정규화한다.
//  - 모바일 채팅의 산출물 "열기"를 실제 raw URL 새 탭으로 연결하는 helper를 주입한다.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuthProxy } from '../src/authProxy.mjs';
import { DEFAULT_PATTERN, detectWebPort } from '../src/openDesign.mjs';

const USER = 'od';
const PASS = 'update-test-pass';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const result = predicate();
    if (result) return result;
    await wait(25);
  }
  throw new Error(message);
}

function waitExit(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await waitExit(child);
}

async function testUpdatedSidecarDetection() {
  assert.match(
    '/Users/test/open-design/apps/web/sidecar/index.ts',
    new RegExp(DEFAULT_PATTERN),
    '기본 패턴이 최신 개발형 web sidecar 경로를 포함해야 함',
  );
  assert.match(
    '/Applications/Open Design.app/Contents/Resources/app/prebundled/web-sidecar.mjs',
    new RegExp(DEFAULT_PATTERN),
    '기본 패턴이 기존 packaged web sidecar 경로도 유지해야 함',
  );

  const dir = mkdtempSync(join(tmpdir(), 'odpeek-sidecar-detect-'));
  const portFile = join(dir, 'port');
  const listenerFile = join(dir, 'listener.mjs');
  const marker = `odpeek-sidecar-detect-${process.pid}-${Date.now()}`;
  writeFileSync(
    listenerFile,
    [
      "import net from 'node:net';",
      "import { writeFileSync } from 'node:fs';",
      'const portFile = process.argv[2];',
      "const server = net.createServer((socket) => socket.end());",
      "server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'),
  );

  // tsx 실행 구조처럼 같은 패턴에 잡히지만 포트를 열지 않는 래퍼 PID를 함께 둔다.
  const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', marker], {
    stdio: 'ignore',
  });
  const listener = spawn(process.execPath, [listenerFile, portFile, marker], { stdio: 'ignore' });

  try {
    const expectedPort = await waitFor(() => {
      try {
        return Number(readFileSync(portFile, 'utf8')) || 0;
      } catch {
        return 0;
      }
    }, '더미 sidecar가 포트를 열지 못했습니다');
    // pgrep/lsof에 두 프로세스가 보일 때까지 한 박자 기다린다.
    await wait(80);

    const detected = detectWebPort(marker);
    assert.equal(detected.pid, listener.pid, 'LISTEN 소켓을 가진 실제 sidecar PID를 골라야 함');
    assert.equal(detected.port, expectedPort, '실제 sidecar LISTEN 포트를 반환해야 함');
    console.log('PASS: 최신 web sidecar 경로 + 비리스닝 래퍼 PID 감지');
  } finally {
    await Promise.all([stopChild(wrapper), stopChild(listener)]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
      ...(options.headers ?? {}),
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers,
        timeout: 3000,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(options.body);
  });
}

async function testOriginAndMobileArtifactHelper() {
  let lastUpstreamHeaders = null;
  let upstreamRequestCount = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequestCount += 1;
    lastUpstreamHeaders = req.headers;
    if (req.url?.startsWith('/api/projects/')) {
      const body = '<!doctype html><html><body>raw artifact</body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url === '/project/demo') {
      const body = '<!doctype html><html><body><main>Open Design</main></body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const listenServer = net.createServer();
  await new Promise((resolve) => listenServer.listen(0, '127.0.0.1', resolve));
  const listenPort = listenServer.address().port;
  await new Promise((resolve) => listenServer.close(resolve));
  const targetPort = upstream.address().port;
  let proxyServer = null;
  runAuthProxy(listenPort, targetPort, USER, PASS, {
    __exposeInternals: ({ server }) => { proxyServer = server; },
  });

  try {
    await waitFor(() => proxyServer?.listening, '인증 프록시가 준비되지 않았습니다');

    const publicOrigin = 'https://sample.trycloudflare.com';
    const api = await request(listenPort, '/api/projects', {
      headers: {
        host: 'sample.trycloudflare.com',
        origin: publicOrigin,
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      method: 'POST',
      body: '{}',
    });
    assert.equal(api.status, 200);
    assert.equal(
      lastUpstreamHeaders?.origin,
      `http://127.0.0.1:${targetPort}`,
      '공개 터널 Origin을 Open Design이 허용하는 로컬 web sidecar Origin으로 바꿔야 함',
    );

    await request(listenPort, '/api/cross-site', {
      headers: {
        host: 'sample.trycloudflare.com',
        origin: 'https://attacker.example',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(
      lastUpstreamHeaders?.origin,
      'https://attacker.example',
      '다른 사이트의 Origin은 정규화하지 않고 upstream CSRF 검사에 맡겨야 함',
    );

    await request(listenPort, '/api/wrong-scheme', {
      headers: {
        host: 'sample.trycloudflare.com',
        origin: 'http://sample.trycloudflare.com',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(
      lastUpstreamHeaders?.origin,
      'http://sample.trycloudflare.com',
      '공개 요청 scheme과 다른 Origin은 정규화하지 않아야 함',
    );

    await request(listenPort, '/api/null-origin', { headers: { origin: 'null' } });
    assert.equal(lastUpstreamHeaders?.origin, 'null', 'sandbox iframe의 Origin:null은 보존해야 함');
    await request(listenPort, '/api/no-origin');
    assert.equal(lastUpstreamHeaders?.origin, undefined, 'Origin 없는 비브라우저 요청에 Origin을 추가하지 않아야 함');

    const shell = await request(listenPort, '/project/demo', {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-encoding': 'gzip, deflate, br',
        host: 'sample.trycloudflare.com',
        origin: publicOrigin,
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(shell.status, 200);
    assert.match(shell.body, /<script[^>]+src="\/__odpeek\/mobile-artifacts\.js"/);
    assert.equal(
      Number(shell.headers['content-length']),
      Buffer.byteLength(shell.body),
      'helper 주입 후 Content-Length를 다시 계산해야 함',
    );
    assert.equal(lastUpstreamHeaders?.['accept-encoding'], 'identity', 'HTML shell은 주입을 위해 identity로 요청');

    const beforeHelper = upstreamRequestCount;
    const helper = await request(listenPort, '/__odpeek/mobile-artifacts.js');
    assert.equal(helper.status, 200);
    assert.match(String(helper.headers['content-type']), /javascript/);
    assert.match(helper.body, /\.produced-file/);
    assert.match(helper.body, /target\s*=\s*['_"]_blank/);
    assert.equal(upstreamRequestCount, beforeHelper, 'helper는 Open Design upstream으로 전달하지 않아야 함');

    const raw = await request(
      listenPort,
      '/api/projects/demo/raw/index.html',
      { headers: { accept: 'text/html' } },
    );
    assert.equal(raw.status, 200);
    assert.equal(raw.body, '<!doctype html><html><body>raw artifact</body></html>');
    assert.doesNotMatch(raw.body, /mobile-artifacts\.js/, '사용자 산출물 HTML 본문은 변조하지 않아야 함');

    console.log('PASS: same-origin 공개 Origin 정규화 + cross-site 보존 + 모바일 산출물 새 탭 helper 주입');
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function main() {
  await testUpdatedSidecarDetection();
  await testOriginAndMobileArtifactHelper();
  console.log('\nOpen Design 업데이트 호환성 테스트 통과 ✅');
}

main().catch((error) => {
  console.error('Open Design 업데이트 호환성 테스트 실패 ✗:', error.stack || error.message);
  process.exit(1);
});
