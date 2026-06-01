// QR 골든벡터 재생성 스크립트 (run-once, dev-time only)
//
// 목적:
//   손수 작성할 QR 인코더(src/qr.mjs, 아직 없음)를 검증하기 위한 "골든" QR 모듈 행렬을
//   **외부 오라클**로 생성해 test/qr-golden.json 에 정적으로 커밋한다.
//   순환 검증(손수 인코더로 골든 생성)을 금지하기 위해, 골든은 반드시 독립 외부 생성기로 만든다.
//
// 라이선스 / 저작권:
//   - 1차 오라클: node-qrcode (npm "qrcode", MIT, (C) 2012 Ryan Day).
//   - QR 모듈 행렬은 알고리즘이 강제하는 기능적 산출물이라 저작권 대상이 아니다(Feist v. Rural Telephone).
//     따라서 출력 행렬을 정적 JSON으로 임베드하는 것은 생성기 라이선스와 무관하게 클린하다.
//   - "QR Code"는 DENSO WAVE의 등록상표.
//
// 의존성 정책 (중요):
//   - 이 프로젝트는 제로-의존이며 package.json 에 dependencies/devDependencies 키를 두지 않는다.
//   - 따라서 qrcode 를 package.json 에 추가하지 않는다. 대신 이 스크립트는 격리된 임시 디렉터리에
//     `npm install qrcode --no-save` 로 일회성 설치 후 그 곳에서 require 한다.
//     => 프로젝트 node_modules / package.json 에 어떤 잔재도 남기지 않는다.
//   - 실행 방법(개발자 수동, CI 아님):
//       node test/qr-golden.gen.mjs
//     (인터넷 필요: npm 레지스트리에서 qrcode 를 임시 디렉터리에 받는다.)
//
// 교차검증(2차 오라클, 순환 방지) — 디코드 라운드트립:
//   node-qrcode 가 만든 골든 행렬을 **독립 QR 디코더**(OpenCV cv2.QRCodeDetector)로 다시
//   읽어 원본 입력 텍스트와 일치하는지 확인한다. 디코더는 어떤 인코더와도 무관한 별도
//   코드베이스이므로 자기검증 순환을 깬다. 또한 디코드 검증은 "마스크 선택"처럼 구현마다
//   합법적으로 갈리는 부분에 영향받지 않는다(스캐너는 8개 마스크를 모두 해석하므로, 어떤
//   유효 마스크든 같은 텍스트로 디코드된다). 즉 "이 행렬이 실제로 스캔되어 의도한 URL이 나오는가"
//   라는 본질을 직접 검증한다. OpenCV 는 `uvx --with opencv-python-headless ... python3 ...`
//   로 일회성 호출(영구 설치 없음).
//
//   주의(개발 기록 — 왜 인코더 간 행렬-동일 비교를 2차 오라클로 쓰지 않는가):
//   처음엔 2차 인코더(segno, 이후 python-qrcode)로 같은 입력의 행렬을 만들어 node-qrcode 와
//   셀 단위 일치를 보려 했으나, 독립 인코더들은 **마스크 패턴 자동 선택 규칙이 달라**
//   (예: v1 'odpeek' node=mask3, v2 URL node=mask1 vs python=mask5) 최종 행렬이 합법적으로
//   다르게 나온다. 둘 다 유효한 QR 이며 OpenCV 로 디코드하면 동일 텍스트가 나온다(확인함).
//   따라서 인코더-간 행렬-동일 비교는 잘못된 불일치 경보를 낳는다 → 디코드 라운드트립을 채택.
//   (segno 는 추가로 q.matrix 표현 차이까지 있어 부적합했다.)
//
//   디코더를 못 구하면(네트워크/도구 부재) 그 사실을 골든 메타(_note)에 기록하고
//   node-qrcode 단독으로 진행하되 "실폰 스캔(e2e)으로 최종 검증 필요" 플래그를 남긴다
//   (거짓 일치 주장 금지).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(SCRIPT_DIR, 'qr-golden.json');

// 골든 입력 집합: byte 모드 / ECC L 기준으로 node-qrcode 가 자동 선택하는 최소 version 이
// 1~10 을 모두 커버하도록 길이를 조정한 문자열들.
// 대표 케이스(trycloudflare URL)와 실제 사용에 가까운 URL 형태를 우선 포함하고,
// 누락 버전은 'x' 반복으로 정확히 채운다.
const TEXTS = [
  // version 1 (21x21)
  'odpeek',
  // version 2 (25x25)
  'http://localhost:51234',
  // version 3 (29x29) — 대표 trycloudflare URL
  'https://abc-def-ghij.trycloudflare.com',
  // version 3 — 경로 포함 trycloudflare URL
  'https://random-words-here-12.trycloudflare.com/x',
  // version 4 (33x33)
  'https://abc-def-ghij.trycloudflare.com/open-design/preview?id=42',
  // version 5 (37x37)
  'x'.repeat(90),
  // version 6 (41x41)
  'x'.repeat(120),
  // version 7 (45x45)
  'x'.repeat(145),
  // version 8 (49x49)
  'x'.repeat(178),
  // version 9 (53x53)
  'x'.repeat(210),
  // version 10 (57x57)
  'x'.repeat(250),
];

/**
 * 격리된 임시 디렉터리에 node-qrcode 를 일회성 설치하고, 그 디렉터리에서 require 가능한
 * QRCode 모듈과 정리(cleanup) 콜백을 반환한다.
 * 프로젝트 package.json / node_modules 를 건드리지 않기 위함이다.
 */
function loadNodeQrcodeOracle() {
  const workDir = mkdtempSync(join(tmpdir(), 'qrgolden-'));
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'qrgolden-oracle', private: true }));
  execFileSync('npm', ['install', 'qrcode@1', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: workDir,
    stdio: 'inherit',
  });
  const requireFromWork = createRequire(join(workDir, 'package.json'));
  const QRCode = requireFromWork('qrcode');
  const version = requireFromWork('qrcode/package.json').version;
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  return { QRCode, version, cleanup };
}

/**
 * node-qrcode 의 모듈 비트맵(BitMatrix: data=boolean[], size×size)을
 * 2차원 0/1 정수 배열로 정규화한다.
 */
function toGrid(modules) {
  const { size, data } = modules;
  const grid = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) {
      line.push(data[row * size + col] ? 1 : 0);
    }
    grid.push(line);
  }
  return grid;
}

/**
 * 골든 0/1 행렬들의 배열을 독립 QR 디코더(OpenCV cv2.QRCodeDetector)로 한 번에 디코드해
 * 각 행렬이 디코드되는 텍스트 배열을 반환한다. 도구 부재/네트워크 실패 시 null 을 반환한다.
 *
 * 각 행렬은 스케일 업 + quiet zone(4모듈) 패딩 후 흑백 이미지로 렌더해 디코드한다.
 * stdin 으로 {grids:[[[0/1]]...]} JSON 을 넘기고 stdout 으로 [text|null,...] 을 받는다.
 */
function decodeMatricesWithOpenCv(grids) {
  const py = [
    'import sys, json, numpy as np, cv2',
    'payload = json.loads(sys.stdin.read())',
    'def to_img(matrix, scale=10, quiet=4):',
    '    n = len(matrix); s = (n + 2 * quiet) * scale',
    '    img = np.full((s, s), 255, dtype=np.uint8)',
    '    for r in range(n):',
    '        for c in range(n):',
    '            if matrix[r][c]:',
    '                img[(r+quiet)*scale:(r+quiet+1)*scale, (c+quiet)*scale:(c+quiet+1)*scale] = 0',
    '    return img',
    'det = cv2.QRCodeDetector()',
    'out = []',
    "for matrix in payload['grids']:",
    '    data, pts, _ = det.detectAndDecode(to_img(matrix))',
    '    out.append(data if data else None)',
    'print(json.dumps(out))',
  ].join('\n');
  try {
    const out = execFileSync(
      'uvx',
      ['--with', 'opencv-python-headless', '--with', 'numpy', 'python3', '-c', py],
      { input: JSON.stringify({ grids }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function main() {
  const { QRCode, version: qrcodeVersion, cleanup } = loadNodeQrcodeOracle();
  const entries = [];

  try {
    // 1) node-qrcode 로 모든 골든 행렬 생성
    for (const text of TEXTS) {
      const created = QRCode.create(text, { errorCorrectionLevel: 'L' });
      entries.push({
        text,
        ecc: 'L',
        version: created.version,
        size: created.modules.size,
        modules: toGrid(created.modules),
      });
    }

    // 2) 디코드 라운드트립 교차검증 (OpenCV, 독립 디코더 코드베이스)
    const decoded = decodeMatricesWithOpenCv(entries.map((entry) => entry.modules));
    let crossCheckOk = false;
    if (decoded) {
      crossCheckOk = true;
      for (let i = 0; i < entries.length; i += 1) {
        if (decoded[i] !== entries[i].text) {
          crossCheckOk = false;
          throw new Error(
            `디코드 교차검증 불일치: vectors[${i}] (len=${entries[i].text.length}, v${entries[i].version}) `
            + `기대=${JSON.stringify(entries[i].text)} 실제=${JSON.stringify(decoded[i])}`,
          );
        }
      }
    }

    const crossCheckNote = crossCheckOk
      ? '독립 QR 디코더(OpenCV cv2.QRCodeDetector)로 모든 골든 행렬을 디코드해 원본 입력과 완전 일치 확인됨(마스크 선택 차이에 무관한 의미론적 검증).'
      : '독립 디코더(OpenCV) 교차검증을 수행하지 못함 — node-qrcode 단독. 실폰 스캔(e2e)으로 최종 검증 필요.';

    const golden = {
      _attribution: 'node-qrcode (npm "qrcode", MIT, (C) 2012 Ryan Day)로 생성. '
        + 'QR 모듈 행렬은 알고리즘 산출물로 저작권 대상이 아님(Feist v. Rural Telephone). '
        + 'QR Code는 DENSO WAVE 등록상표.',
      _note: `byte 모드 / ECC level L / version 자동 선택(최소). 생성기 qrcode@${qrcodeVersion}. ${crossCheckNote}`,
      _generator: 'test/qr-golden.gen.mjs (run-once, dev-time only; npx/npm 임시설치, package.json 미수정)',
      vectors: entries,
    };

    writeFileSync(OUTPUT_PATH, `${JSON.stringify(golden, null, 2)}\n`);
    const versions = entries.map((entry) => entry.version);
    console.log(`골든 ${entries.length}개 생성. version 범위 ${Math.min(...versions)}~${Math.max(...versions)}.`);
    console.log(crossCheckNote);
    console.log(`출력: ${OUTPUT_PATH}`);
  } finally {
    cleanup();
  }
}

main();
