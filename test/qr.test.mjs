// 손수 QR 인코더(src/qr.mjs) 검증 테스트.
// 외부 의존성 없이 node:assert/strict + fs/url stdlib만 쓰는 standalone 실행 파일(기존 smoke.mjs 스타일).
// 통과 시 각 케이스에 PASS를 출력하고 마지막에 exit 0, 실패 시 exit 1.
//
// 검증 케이스(§4 QR / §5 Feature 2):
//   (a) 골든 셀 단위 일치(핵심): test/qr-golden.json 11개 벡터의 size·version·modules가 완전 일치.
//   (b) 마스크 선택 결정성: 같은 입력 → 같은 행렬.
//   (c) maxVersion(v10) 초과 입력 → throw.
//   (d) renderQrToTerminal: 알려진 작은 행렬 → 알려진 문자열(invert on/off), quiet zone 반영.
//   (e) 런타임 의존 부재 단언: package.json에 dependencies 키 부재 + src/에 qrcode import 부재.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeQrMatrix, renderQrToTerminal } from '../src/qr.mjs';

// 저장소 루트(이 파일 기준 ../). golden·package.json·src/ 접근에 쓴다.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL('./qr-golden.json', import.meta.url));

/**
 * 골든 행렬(0/1 정수 2차원)과 인코더 출력(boolean 2차원)이 size·셀 단위로 완전히 같은지 단언한다.
 * 한 셀이라도 다르면 어느 좌표가 어떻게 다른지 보고하며 실패시킨다.
 */
function assertMatrixEquals(expected, actual, label) {
  assert.equal(actual.size, expected.size, `${label}: size 불일치(기대 ${expected.size}, 실제 ${actual.size})`);
  for (let row = 0; row < expected.size; row += 1) {
    for (let col = 0; col < expected.size; col += 1) {
      const expectedCell = expected.modules[row][col];
      const actualCell = actual.modules[row][col] ? 1 : 0;
      assert.equal(
        actualCell,
        expectedCell,
        `${label}: 셀 (${row},${col}) 불일치(기대 ${expectedCell}, 실제 ${actualCell})`,
      );
    }
  }
}

// (a) 골든 셀 단위 일치 — 본 작업의 핵심.
function testGoldenCellByCell() {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  assert.ok(Array.isArray(golden.vectors) && golden.vectors.length === 11,
    '골든은 11개 벡터를 가져야 함(v1~v10 커버)');

  for (let index = 0; index < golden.vectors.length; index += 1) {
    const vector = golden.vectors[index];
    assert.equal(vector.ecc, 'L', `벡터 ${index}: 골든은 ECC level L`);
    const result = encodeQrMatrix(vector.text, { ecc: 'L' });

    // version은 size로 검증(size = 17 + 4*version). 골든의 version·size와 모두 일치해야 한다.
    const derivedVersion = (result.size - 17) / 4;
    assert.equal(derivedVersion, vector.version,
      `벡터 ${index}: version 불일치(기대 v${vector.version}, 실제 v${derivedVersion})`);

    assertMatrixEquals(vector, result, `벡터 ${index}(v${vector.version}, "${vector.text.slice(0, 24)}")`);
  }
  console.log(`PASS (a): 골든 11개 벡터 전부 셀 단위 일치(v1~v10, byte/numeric 혼합 모드 포함)`);
}

// (b) 마스크 선택 결정성: 같은 입력은 항상 같은 행렬을 낸다.
function testMaskDeterminism() {
  const text = 'https://abc-def-ghij.trycloudflare.com';
  const first = encodeQrMatrix(text, { ecc: 'L' });
  const second = encodeQrMatrix(text, { ecc: 'L' });
  assert.deepEqual(second, first, '동일 입력은 동일 행렬(마스크 선택 결정적)이어야 함');

  // 혼합 모드 입력도 결정적이어야 함.
  const mixed = 'http://localhost:51234';
  assert.deepEqual(encodeQrMatrix(mixed, { ecc: 'L' }), encodeQrMatrix(mixed, { ecc: 'L' }),
    '혼합 모드 입력도 결정적이어야 함');
  console.log('PASS (b): 마스크 선택 결정성(같은 입력 → 같은 행렬)');
}

// (c) maxVersion(v10) 초과 입력 → throw.
function testMaxVersionThrows() {
  // v10(byte/ECC L) 한계는 271 byte. 300 byte는 초과 → throw.
  assert.throws(
    () => encodeQrMatrix('x'.repeat(300), { ecc: 'L', maxVersion: 10 }),
    /version 10|초과/,
    'v10 용량 초과 입력은 throw해야 함',
  );

  // 경계: v10에 정확히 담기는 입력(250 byte 'x' → v10)은 throw하지 않고 size 57을 낸다.
  const fits = encodeQrMatrix('x'.repeat(250), { ecc: 'L', maxVersion: 10 });
  assert.equal(fits.size, 57, 'v10에 담기는 입력은 size 57(=17+4*10)');
  console.log('PASS (c): maxVersion(v10) 초과 → throw / 경계 입력은 정상');
}

// (c-2) 빈 문자열 입력 → throw(방어적 가드 + 오라클 node-qrcode 동작 일치).
function testEmptyStringThrows() {
  // 빈 문자열은 QR 인코딩 불가 — 명확한 에러를 던져야 한다.
  assert.throws(
    () => encodeQrMatrix('', { ecc: 'L' }),
    /비어/,
    '빈 문자열은 throw해야 함',
  );
  // 비문자열(undefined/null)도 동일하게 throw해야 한다.
  assert.throws(
    () => encodeQrMatrix(undefined),
    /비어/,
    'undefined 입력은 throw해야 함',
  );
  assert.throws(
    () => encodeQrMatrix(null),
    /비어/,
    'null 입력은 throw해야 함',
  );
  console.log('PASS (c-2): 빈 문자열/비문자열 입력 → throw');
}

// (d) renderQrToTerminal: 알려진 작은 행렬 → 알려진 문자열(invert on/off), quiet zone 반영.
function testRenderKnownMatrix() {
  // 2x2 체커보드 행렬. true=dark.
  //   (0,0)=dark (0,1)=light
  //   (1,0)=light (1,1)=dark
  const matrix = {
    size: 2,
    modules: [
      [true, false],
      [false, true],
    ],
  };

  // quiet=0, invert=false. padded=2. 행 쌍 (0,1): 한 줄로 압축.
  //   col0: top=dark(0,0), bottom=light(1,0) → '▀'
  //   col1: top=light(0,1), bottom=dark(1,1) → '▄'
  // 결과: "▀▄"
  assert.equal(renderQrToTerminal(matrix, { invert: false, quiet: 0 }), '▀▄',
    'quiet=0 invert=false 체커보드 → "▀▄"');

  // invert=true면 dark/light 반전.
  //   col0: top=light, bottom=dark → '▄'
  //   col1: top=dark, bottom=light → '▀'
  // 결과: "▄▀"
  assert.equal(renderQrToTerminal(matrix, { invert: true, quiet: 0 }), '▄▀',
    'quiet=0 invert=true 체커보드 → "▄▀"');

  // quiet zone 반영: 1x1 dark 모듈 + quiet=1. padded=3.
  //   행 쌍 (0,1): row0 전부 light(quiet), row1 = [light, dark, light] → " ▄ "
  //   행 (2): row2 전부 light, 하단 없음 → "   "
  // 결과: " ▄ \n   "
  const single = { size: 1, modules: [[true]] };
  assert.equal(renderQrToTerminal(single, { invert: false, quiet: 1 }), ' ▄ \n   ',
    'quiet=1 단일 dark 모듈 → quiet zone 포함 " ▄ \\n   "');

  // 기본 quiet(4)가 사방에 적용되는지: 1x1 행렬은 padded 9 → 줄 수 ceil(9/2)=5, 각 줄 길이 9.
  const defaultQuiet = renderQrToTerminal(single, {});
  const lines = defaultQuiet.split('\n');
  assert.equal(lines.length, 5, '기본 quiet=4: 1x1 행렬 → 5줄(ceil(9/2))');
  for (const line of lines) {
    assert.equal([...line].length, 9, '기본 quiet=4: 각 줄 길이 9(=1+4*2)');
  }
  console.log('PASS (d): renderQrToTerminal 알려진 문자열(invert on/off) + quiet zone 반영');
}

// (e) 런타임 의존 부재 단언: package.json dependencies 키 부재 + src/에 qrcode import 부재.
function testNoRuntimeDependency() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', `file://${REPO_ROOT}`)), 'utf8'));
  // 주의: `'dependencies' in pkg === false`이므로 "빈 객체" 단언이 아니라 아래 형태로 작성한다(§결정 D).
  assert.ok(
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'package.json에 런타임 dependencies가 없어야 함(제로-의존 정체성)',
  );

  // src/의 모든 .mjs에 'qrcode' 패키지 import/require가 없어야 함(런타임 오라클 미사용).
  // 주석의 'node-qrcode' 언급은 허용하되, 실제 모듈 specifier로서의 'qrcode'만 금지한다.
  const srcDir = fileURLToPath(new URL('./src/', `file://${REPO_ROOT}`));
  const srcFiles = readdirSync(srcDir).filter((name) => name.endsWith('.mjs'));
  assert.ok(srcFiles.includes('qr.mjs'), 'src/qr.mjs가 존재해야 함');
  // import ... from 'qrcode' / import('qrcode') / require('qrcode') (따옴표 안의 정확한 specifier).
  const qrcodeImport = /(?:from|import|require)\s*\(?\s*['"]qrcode['"]/;
  for (const name of srcFiles) {
    const content = readFileSync(`${srcDir}${name}`, 'utf8');
    assert.doesNotMatch(content, qrcodeImport,
      `src/${name}에 'qrcode' 패키지 import/require가 없어야 함(런타임 npm 의존 금지)`);
  }
  console.log('PASS (e): 런타임 의존 부재(package.json dependencies 부재 + src/ qrcode import/require 부재)');
}

function main() {
  testGoldenCellByCell();
  testMaskDeterminism();
  testMaxVersionThrows();
  testEmptyStringThrows();
  testRenderKnownMatrix();
  testNoRuntimeDependency();
  console.log('\n모든 QR 인코더 테스트 통과 ✅');
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error('QR 인코더 테스트 실패 ✗:', error.message);
  process.exit(1);
}
