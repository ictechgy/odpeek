// 무의존성 손수 QR 코드 인코더 + 터미널 렌더러.
//
// 목적:
//   런타임 npm 의존성을 0으로 유지하면서(제로-의존 정체성, §결정 D·원칙 1) trycloudflare URL 등을
//   QR 코드로 인코딩해 터미널에 출력한다. qrcode 등 외부 라이브러리를 import 하지 않고 ISO/IEC 18004
//   표준을 직접 구현한다.
//
// 범위(§결정 D1):
//   - byte 모드 전용(URL은 byte 필수), ECC level L 전용.
//   - version 1~10 자동 선택(데이터를 담는 최소 version). 캡 초과 시 throw(graceful fallback은 CLI 책임).
//   - 마스크 0~7 전수 평가(표준 페널티 N1~N4) 후 최저 점수 선택, 동점 시 낮은 번호 우선.
//     => node-qrcode(표준 tie-break)와 비트 단위로 일치한다(test/qr-golden.json 셀 단위 검증).
//
// 모든 함수는 순수 함수다(파일 IO·콘솔·전역 상태 없음). 식별자는 영어, 주석은 한국어.
//
// 참고 표준: ISO/IEC 18004 (QR Code). QR Code는 DENSO WAVE의 등록상표.

// ---------------------------------------------------------------------------
// 1) 버전 테이블 (version 1~10, ECC level L)
// ---------------------------------------------------------------------------

/**
 * version별 총 코드워드 수(데이터+EC). size = 17 + 4*version 으로 (size−17)/4 = version.
 * ISO/IEC 18004 표 1의 "Number of data and error correction codewords"의 총합.
 * 인덱스 = version−1 (1~10).
 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * version별(ECC L) EC 코드워드/블록 구조. ISO/IEC 18004 표 9(level L) 발췌.
 * 각 항목: { ecPerBlock, groups: [{ blocks, dataPerBlock }, ...] }
 *   - ecPerBlock: 블록당 EC 코드워드 수
 *   - groups: 블록 그룹(블록 수, 블록당 데이터 코드워드 수)
 * 데이터 코드워드 총합 = TOTAL_CODEWORDS[v−1] − (총 블록 수 × ecPerBlock).
 * 인덱스 = version−1.
 */
const EC_BLOCKS_L = [
  { ecPerBlock: 7, groups: [{ blocks: 1, dataPerBlock: 19 }] }, // v1
  { ecPerBlock: 10, groups: [{ blocks: 1, dataPerBlock: 34 }] }, // v2
  { ecPerBlock: 15, groups: [{ blocks: 1, dataPerBlock: 55 }] }, // v3
  { ecPerBlock: 20, groups: [{ blocks: 1, dataPerBlock: 80 }] }, // v4
  { ecPerBlock: 26, groups: [{ blocks: 1, dataPerBlock: 108 }] }, // v5
  { ecPerBlock: 18, groups: [{ blocks: 2, dataPerBlock: 68 }] }, // v6
  { ecPerBlock: 20, groups: [{ blocks: 2, dataPerBlock: 78 }] }, // v7
  { ecPerBlock: 24, groups: [{ blocks: 2, dataPerBlock: 97 }] }, // v8
  { ecPerBlock: 30, groups: [{ blocks: 2, dataPerBlock: 116 }] }, // v9
  { ecPerBlock: 18, groups: [{ blocks: 2, dataPerBlock: 68 }, { blocks: 2, dataPerBlock: 69 }] }, // v10
];

/**
 * version별 정렬 패턴(alignment pattern) 중심 좌표 목록. ISO/IEC 18004 부록 E.
 * v1은 정렬 패턴 없음(빈 배열). v2~10은 좌표 집합의 데카르트 곱으로 중심을 만든다(단, finder와
 * 겹치는 세 모서리는 제외). 인덱스 = version−1.
 */
const ALIGNMENT_CENTERS = [
  [], // v1
  [6, 18], // v2
  [6, 22], // v3
  [6, 26], // v4
  [6, 30], // v5
  [6, 34], // v6
  [6, 22, 38], // v7
  [6, 24, 42], // v8
  [6, 26, 46], // v9
  [6, 28, 50], // v10
];

/** version의 데이터 코드워드 총수 = 총 코드워드 − (총 블록 수 × 블록당 EC). */
function countDataCodewords(version) {
  const { ecPerBlock, groups } = EC_BLOCKS_L[version - 1];
  const totalBlocks = groups.reduce((sum, g) => sum + g.blocks, 0);
  return TOTAL_CODEWORDS[version - 1] - totalBlocks * ecPerBlock;
}

// ---------------------------------------------------------------------------
// 1.5) 세그먼트 모드 최적화 (node-qrcode 호환)
// ---------------------------------------------------------------------------
//
// node-qrcode(=골든 오라클)는 입력을 byte 단일 모드로 인코딩하지 않고, numeric/alphanumeric/byte
// 세그먼트로 **자동 분할·최적화**(Dijkstra 최단 경로)해 비트스트림을 최소화한다.
// 예: "http://localhost:51234" → byte("http://localhost:") + numeric("51234").
// 따라서 골든과 셀 단위로 일치하려면 이 세그먼트 최적화를 동일하게 재현해야 한다.
//
// 모드 식별자(4비트): numeric=0b0001, alphanumeric=0b0010, byte=0b0100.
// char-count indicator 비트 수(version별): numeric=[10,12,14], alphanumeric=[9,11,13], byte=[8,16,16].

const MODE = {
  NUMERIC: { id: 'numeric', bit: 0b0001, ccBits: [10, 12, 14] },
  ALPHANUMERIC: { id: 'alphanumeric', bit: 0b0010, ccBits: [9, 11, 13] },
  BYTE: { id: 'byte', bit: 0b0100, ccBits: [8, 16, 16] },
};

/** alphanumeric 인코딩 가능한 45문자 집합(ISO/IEC 18004 표 5 순서). */
const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** version에 따른 char-count indicator 비트 수. v1~9=idx0, v10~26=idx1, v27+=idx2. */
function charCountBits(mode, version) {
  if (version >= 1 && version < 10) return mode.ccBits[0];
  if (version < 27) return mode.ccBits[1];
  return mode.ccBits[2];
}

/** numeric 모드 데이터 비트 길이: 3자리=10비트, 나머지 1자리=4·2자리=7비트. */
function numericBitsLength(length) {
  return 10 * Math.floor(length / 3) + ((length % 3) ? ((length % 3) * 3 + 1) : 0);
}

/** alphanumeric 모드 데이터 비트 길이: 2문자=11비트, 나머지 1문자=6비트. */
function alphanumericBitsLength(length) {
  return 11 * Math.floor(length / 2) + ((length % 2) ? 6 : 0);
}

/** 모드별 데이터 비트 길이(문자 길이 기준). byte는 문자 길이가 곧 바이트 길이(이 함수의 인자 의미). */
function segmentBitsLength(length, mode) {
  if (mode === MODE.NUMERIC) return numericBitsLength(length);
  if (mode === MODE.ALPHANUMERIC) return alphanumericBitsLength(length);
  return length * 8; // BYTE
}

/** 문자열의 UTF-8 바이트 길이. */
function utf8ByteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * 입력 문자열을 numeric / alphanumeric / byte 정규식으로 갈라 원시 세그먼트 목록을 만든다.
 * node-qrcode 와 동일하게, byte 세그먼트는 "alphanumeric/numeric에 속하지 않는 연속 구간"이다.
 * (alphanumeric은 대문자·숫자·특정 기호만 → 소문자 URL은 byte로 떨어진다.)
 * @returns {{data:string, mode:object}[]} index 순으로 정렬된 세그먼트
 */
function getRawSegments(text) {
  const segments = [];
  // 하드코딩된 리터럴 정규식만 사용한다(동적 RegExp 미사용 → ReDoS 표면 없음).
  // 각 정규식은 선형 시간 매칭이며 입력은 신뢰된 URL/텍스트다.
  const collect = (re, mode) => {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      segments.push({ data: match[0], index: match.index, mode });
    }
  };
  collect(/[0-9]+/g, MODE.NUMERIC);
  collect(/[A-Z $%*+\-./:]+/g, MODE.ALPHANUMERIC);
  // byte: 위 alphanumeric 집합에 속하지 않는 연속 구간(소문자·기타).
  collect(/[^A-Z0-9 $%*+\-./:]+/g, MODE.BYTE);
  return segments
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ data: s.data, mode: s.mode }));
}

/**
 * 인접한 동일 모드 세그먼트를 병합한다(node-qrcode mergeSegments).
 */
function mergeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.mode === seg.mode) prev.data += seg.data;
    else out.push({ data: seg.data, mode: seg.mode });
  }
  return out;
}

/**
 * 원시 세그먼트를 Dijkstra 최단 경로로 최적화해 최소 비트스트림 세그먼트 목록을 만든다.
 * node-qrcode 의 buildNodes/buildGraph/find_path 를 충실히 재현한다.
 *
 * 각 원시 세그먼트는 가능한 여러 모드 노드로 확장된다(numeric→{num,alnum,byte},
 * alnum→{alnum,byte}, byte→{byte}). 노드 간 간선 가중치는 "세그먼트 전환 시 새 헤더(4+ccBits)
 * + 데이터 비트" 또는 "같은 모드 연장 시 길이 증가분"으로 계산한다.
 *
 * @param {string} text 입력
 * @param {number} version char-count 비트 수 결정용 version
 * @returns {{data:string, mode:object}[]} 최적화·병합된 세그먼트
 */
function optimizeSegments(text, version) {
  const rawSegs = getRawSegments(text);
  // 각 원시 세그먼트를 가능한 모드 노드 그룹으로 확장.
  const nodes = rawSegs.map((seg) => {
    if (seg.mode === MODE.NUMERIC) {
      return [
        { data: seg.data, mode: MODE.NUMERIC, length: seg.data.length },
        { data: seg.data, mode: MODE.ALPHANUMERIC, length: seg.data.length },
        { data: seg.data, mode: MODE.BYTE, length: seg.data.length },
      ];
    }
    if (seg.mode === MODE.ALPHANUMERIC) {
      return [
        { data: seg.data, mode: MODE.ALPHANUMERIC, length: seg.data.length },
        { data: seg.data, mode: MODE.BYTE, length: seg.data.length },
      ];
    }
    // BYTE: 길이는 UTF-8 바이트 길이.
    return [{ data: seg.data, mode: MODE.BYTE, length: utf8ByteLength(seg.data) }];
  });

  // 그래프 구성(node-qrcode buildGraph 동치). 노드 키 = '' + i + j.
  const table = {};
  const graph = { start: {} };
  let prevNodeIds = ['start'];
  for (let i = 0; i < nodes.length; i += 1) {
    const group = nodes[i];
    const currentNodeIds = [];
    for (let j = 0; j < group.length; j += 1) {
      const node = group[j];
      const key = `${i}${j}`;
      currentNodeIds.push(key);
      table[key] = { node, lastCount: 0 };
      graph[key] = {};
      for (const prevId of prevNodeIds) {
        if (table[prevId] && table[prevId].node.mode === node.mode) {
          // 같은 모드 연장: 데이터 비트 증가분만.
          graph[prevId][key] = segmentBitsLength(table[prevId].lastCount + node.length, node.mode)
            - segmentBitsLength(table[prevId].lastCount, node.mode);
          table[prevId].lastCount += node.length;
        } else {
          if (table[prevId]) table[prevId].lastCount = node.length;
          // 모드 전환: 새 헤더(4 + ccBits) + 데이터 비트.
          graph[prevId][key] = segmentBitsLength(node.length, node.mode)
            + 4 + charCountBits(node.mode, version);
        }
      }
    }
    prevNodeIds = currentNodeIds;
  }
  for (const prevId of prevNodeIds) graph[prevId].end = 0;

  // Dijkstra 최단 경로(start→end).
  const path = dijkstraShortestPath(graph, 'start', 'end');
  const optimized = [];
  for (let i = 1; i < path.length - 1; i += 1) {
    optimized.push(table[path[i]].node);
  }
  return mergeSegments(optimized.map((n) => ({ data: n.data, mode: n.mode })));
}

/**
 * 단순 Dijkstra 최단 경로(양수 가중치). node-qrcode가 쓰는 dijkstrajs와 동치 결과를 낸다.
 * @param {Object<string,Object<string,number>>} graph 인접 리스트(가중치)
 * @returns {string[]} start→end 노드 키 경로
 */
function dijkstraShortestPath(graph, start, end) {
  const dist = { [start]: 0 };
  const prev = {};
  const visited = new Set();
  while (true) {
    // 미방문 노드 중 최소 거리 선택.
    let u = null;
    let best = Infinity;
    for (const node of Object.keys(dist)) {
      if (!visited.has(node) && dist[node] < best) { best = dist[node]; u = node; }
    }
    if (u === null) break;
    if (u === end) break;
    visited.add(u);
    const edges = graph[u] || {};
    for (const v of Object.keys(edges)) {
      const alt = dist[u] + edges[v];
      if (alt < (dist[v] ?? Infinity)) { dist[v] = alt; prev[v] = u; }
    }
  }
  const path = [];
  let cur = end;
  while (cur !== undefined) { path.unshift(cur); cur = prev[cur]; }
  return path;
}

/**
 * 세그먼트 목록을 담는 데 필요한 총 비트 수(모드 헤더 포함)를 version 기준으로 계산한다.
 */
function totalSegmentBits(segments, version) {
  let total = 0;
  for (const seg of segments) {
    const length = seg.mode === MODE.BYTE ? utf8ByteLength(seg.data) : seg.data.length;
    total += 4 + charCountBits(seg.mode, version) + segmentBitsLength(length, seg.mode);
  }
  return total;
}

/**
 * 최적화된 세그먼트를 담을 수 있는 최소 version(1~maxVersion, ECC L)을 선택한다.
 * node-qrcode 와 동일하게, 먼저 원시 분할로 version을 추정하고 그 version으로 최적화한 뒤
 * 최종 version을 다시 확정한다(추정→최적화→재확정).
 *
 * @param {string} text 입력 문자열
 * @param {number} maxVersion 허용 최대 version
 * @returns {{version:number, segments:object[]}}
 * @throws {Error} maxVersion으로도 담을 수 없으면 throw
 */
function chooseVersionAndSegments(text, maxVersion) {
  // 이 구현이 지원하는 최대 version(테이블 범위 v1~10). 추정 루프가 테이블 밖을 인덱싱하지 않게 한다.
  const supportedMax = Math.min(maxVersion, EC_BLOCKS_L.length);

  // 1) 원시(미최적) 분할로 version 추정. 추정의 유일한 효과는 char-count 비트 폭(v<10=8비트, 이상=16비트)
  //    결정이므로, 지원 범위 안에서 못 담으면 가장 큰 지원 version으로 추정한다(폴백).
  const rawMerged = mergeSegments(getRawSegments(text));
  let estimated = supportedMax;
  for (let v = 1; v <= supportedMax; v += 1) {
    if (totalSegmentBits(rawMerged, v) <= countDataCodewords(v) * 8) { estimated = v; break; }
  }

  // 2) 추정 version으로 세그먼트 최적화.
  const segments = optimizeSegments(text, estimated);

  // 3) 최적화 세그먼트로 최소 version 재확정(maxVersion 캡 적용).
  for (let v = 1; v <= supportedMax; v += 1) {
    if (totalSegmentBits(segments, v) <= countDataCodewords(v) * 8) {
      return { version: v, segments };
    }
  }
  throw new Error(
    `QR 인코딩 불가: 입력이 version ${maxVersion}(ECC L) 용량을 초과합니다. `
    + 'maxVersion을 높이거나 더 짧은 텍스트를 사용하세요.',
  );
}

// ---------------------------------------------------------------------------
// 2) 비트 버퍼: 데이터 비트스트림 구성
// ---------------------------------------------------------------------------

/**
 * 비트를 MSB-first로 누적하는 단순 비트 버퍼.
 * QR 데이터 비트스트림(mode/char-count/data/terminator/pad)을 만든 뒤 8비트 코드워드로 떨어진다.
 */
class BitBuffer {
  constructor() {
    /** @type {number[]} 0/1 비트 배열(MSB-first 순서로 push) */
    this.bits = [];
  }

  /** value의 하위 length 비트를 MSB-first로 추가한다. */
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length() {
    return this.bits.length;
  }
}

/** 한 세그먼트의 데이터 비트를 비트 버퍼에 쓴다(모드별 인코딩). */
function writeSegmentData(buffer, seg) {
  if (seg.mode === MODE.NUMERIC) {
    // 3자리=10비트, 나머지 2자리=7비트·1자리=4비트.
    let i = 0;
    for (; i + 3 <= seg.data.length; i += 3) {
      buffer.put(parseInt(seg.data.substr(i, 3), 10), 10);
    }
    const rem = seg.data.length - i;
    if (rem > 0) buffer.put(parseInt(seg.data.substr(i), 10), rem * 3 + 1);
    return;
  }
  if (seg.mode === MODE.ALPHANUMERIC) {
    // 2문자=11비트(c1*45+c2), 나머지 1문자=6비트.
    let i = 0;
    for (; i + 2 <= seg.data.length; i += 2) {
      const v = ALPHANUMERIC_CHARS.indexOf(seg.data[i]) * 45
        + ALPHANUMERIC_CHARS.indexOf(seg.data[i + 1]);
      buffer.put(v, 11);
    }
    if (i < seg.data.length) buffer.put(ALPHANUMERIC_CHARS.indexOf(seg.data[i]), 6);
    return;
  }
  // BYTE: UTF-8 각 바이트 8비트.
  for (const byte of Buffer.from(seg.data, 'utf8')) buffer.put(byte, 8);
}

/**
 * 최적화된 세그먼트들을 비트스트림으로 인코딩하고, terminator + bit/byte 패딩 + 교대 pad(0xEC/0x11)를
 * 적용해 데이터 코드워드 배열(길이 = dataCodewords)을 반환한다(ISO/IEC 18004 §8.4, node-qrcode 동치).
 *
 * 비트스트림 구성: 각 세그먼트마다 mode indicator(4비트) + char-count(ccBits) + 데이터 비트.
 *   그 뒤 terminator(최대 0000 4비트) + 8비트 경계 패딩 0 + pad codeword 0xEC,0x11 교대.
 *
 * @param {object[]} segments 최적화된 세그먼트 목록
 * @param {number} version 선택된 version
 * @returns {number[]} 데이터 코드워드(0~255) 배열
 */
function encodeSegments(segments, version) {
  const dataCodewords = countDataCodewords(version);
  const capacityBits = dataCodewords * 8;
  const buffer = new BitBuffer();

  for (const seg of segments) {
    const length = seg.mode === MODE.BYTE ? utf8ByteLength(seg.data) : seg.data.length;
    buffer.put(seg.mode.bit, 4); // mode indicator
    buffer.put(length, charCountBits(seg.mode, version)); // char-count indicator
    writeSegmentData(buffer, seg); // 데이터 비트
  }

  // terminator: 남은 용량이 4비트 이상이면 0000, 아니면 남은 만큼(node-qrcode 동치).
  if (buffer.length + 4 <= capacityBits) buffer.put(0, 4);

  // 8비트 경계까지 0으로 패딩.
  if (buffer.length % 8 !== 0) buffer.put(0, 8 - (buffer.length % 8));

  // 비트 → 코드워드(8비트씩).
  const codewords = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | buffer.bits[i + b];
    codewords.push(byte);
  }

  // 용량을 채울 때까지 pad codeword 0xEC, 0x11 교대.
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  return codewords;
}

// ---------------------------------------------------------------------------
// 3) Reed-Solomon ECC: GF(256) 산술
// ---------------------------------------------------------------------------
//
// QR은 GF(2^8)을 원시 다항식 0x11d (x^8 + x^4 + x^3 + x^2 + 1)로 정의한다.
// 로그/역로그 테이블을 미리 만들어 곱셈을 덧셈(지수)으로 환원한다.

/** GF(256) 역로그(지수→값) 테이블, 길이 256. */
const GF_EXP = new Array(256).fill(0);
/** GF(256) 로그(값→지수) 테이블, 길이 256. */
const GF_LOG = new Array(256).fill(0);

(function initGaloisField() {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1; // ×2 (생성원 g=2)
    if (value & 0x100) value ^= 0x11d; // 원시 다항식으로 모듈러
  }
  // 지수 255~ 는 0~ 와 동일(주기 255). 곱셈 시 인덱스 오버플로 방지용으로 채워 둔다.
  for (let i = 255; i < 256; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

/** GF(256) 곱셈. 0이면 0, 아니면 로그 덧셈(mod 255) 후 역로그. */
function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

/**
 * 차수 degree의 RS 생성 다항식 g(x) = ∏ (x − α^i), i=0..degree−1 의 계수를 반환한다.
 * 계수는 GF(256) 위에서 계산하며, 결과 길이는 degree+1(최고차항 계수=1 포함).
 * @param {number} degree EC 코드워드 수
 * @returns {number[]} 생성 다항식 계수(고차→저차)
 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    // poly *= (x − α^i). α^i = GF_EXP[i].
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]; // x 곱: 한 칸 올림(이미 next[j]에 누적)
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i]); // −α^i 곱(GF에서 뺄셈=XOR)
    }
    poly = next;
  }
  return poly;
}

/**
 * 데이터 코드워드 블록에 대한 EC 코드워드를 RS 다항식 나눗셈으로 계산한다.
 * @param {number[]} dataBlock 데이터 코드워드 배열
 * @param {number} ecCount EC 코드워드 수
 * @returns {number[]} EC 코드워드 배열(길이 ecCount)
 */
function rsEcc(dataBlock, ecCount) {
  const generator = rsGeneratorPoly(ecCount);
  // 나머지(remainder) 레지스터. 데이터 뒤에 ecCount개의 0을 붙인 다항식을 나눈다.
  const remainder = dataBlock.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < dataBlock.length; i += 1) {
    const coef = remainder[i];
    if (coef === 0) continue;
    for (let j = 0; j < generator.length; j += 1) {
      remainder[i + j] ^= gfMultiply(generator[j], coef);
    }
  }
  // 마지막 ecCount개가 EC 코드워드.
  return remainder.slice(dataBlock.length);
}

// ---------------------------------------------------------------------------
// 4) 블록 분할 + 인터리빙
// ---------------------------------------------------------------------------

/**
 * 데이터 코드워드를 version의 블록 구조로 나누고, 각 블록의 EC를 계산한 뒤, 표준 인터리빙
 * 규칙으로 최종 코드워드 시퀀스를 만든다.
 *
 * 인터리빙(ISO/IEC 18004 §8.6): 데이터 코드워드를 블록별 같은 인덱스끼리 라운드로빈으로 뽑고,
 * 그다음 EC 코드워드를 같은 방식으로 뽑아 이어 붙인다. 짧은 블록은 데이터에서 더 먼저 소진된다.
 *
 * @param {number[]} dataCodewords byteEncode가 만든 전체 데이터 코드워드
 * @param {number} version 선택된 version
 * @returns {number[]} 인터리빙된 최종 코드워드(데이터+EC) 시퀀스
 */
function interleaveBlocks(dataCodewords, version) {
  const { ecPerBlock, groups } = EC_BLOCKS_L[version - 1];

  // 블록별 데이터/EC 코드워드를 만든다.
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const group of groups) {
    for (let b = 0; b < group.blocks; b += 1) {
      const block = dataCodewords.slice(offset, offset + group.dataPerBlock);
      offset += group.dataPerBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEcc(block, ecPerBlock));
    }
  }

  const result = [];
  // 데이터 코드워드 인터리빙: 가장 긴 블록 길이까지 라운드로빈.
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  // EC 코드워드 인터리빙: 모든 블록의 EC 길이는 동일(ecPerBlock).
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 5) 모듈 배치: 기능 패턴 + 데이터
// ---------------------------------------------------------------------------
//
// 행렬은 size×size. 각 셀 상태를 0/1로, "기능 영역(함수 패턴 + 예약)"을 별도 boolean 행렬로 추적한다.
// 데이터/마스킹은 기능 영역을 건드리지 않는다.

/** version으로 행렬 크기(size)를 구한다. size = 17 + 4*version. */
function sizeForVersion(version) {
  return 17 + 4 * version;
}

/** size×size의 0 채움 2차원 배열을 만든다. */
function makeMatrix(size, fill) {
  const matrix = [];
  for (let r = 0; r < size; r += 1) matrix.push(new Array(size).fill(fill));
  return matrix;
}

/**
 * finder pattern(7×7) 하나를 좌상단 (row,col) 기준으로 그린다. separator 1모듈도 기능 영역으로 표시.
 */
function placeFinder(modules, reserved, row, col, size) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      reserved[rr][cc] = true;
      // 7×7 finder: 바깥 테두리(0..6) + 가운데 3×3(2..4)이 dark.
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6
        && (r === 0 || r === 6 || c === 0 || c === 6);
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      modules[rr][cc] = inOuter || inInner ? 1 : 0;
    }
  }
}

/** 정렬 패턴(5×5) 하나를 (row,col) 중심으로 그린다. */
function placeAlignment(modules, reserved, row, col) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      reserved[row + r][col + c] = true;
      // 5×5: 바깥 테두리 + 중심점이 dark.
      const isDark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      modules[row + r][col + c] = isDark ? 1 : 0;
    }
  }
}

/**
 * 기능 패턴 전체를 배치한다: finder×3 + separator + timing + alignment + dark module + format/version 예약.
 * @returns {{modules:number[][], reserved:boolean[][]}}
 */
function placeFunctionPatterns(version) {
  const size = sizeForVersion(version);
  const modules = makeMatrix(size, 0);
  const reserved = makeMatrix(size, false);

  // 3개 finder pattern(좌상, 우상, 좌하)과 separator.
  placeFinder(modules, reserved, 0, 0, size);
  placeFinder(modules, reserved, 0, size - 7, size);
  placeFinder(modules, reserved, size - 7, 0, size);

  // timing pattern: 6행/6열에 교대 패턴. 기능 영역이 아닌 곳만 채운다.
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) { modules[6][i] = bit; reserved[6][i] = true; }
    if (!reserved[i][6]) { modules[i][6] = bit; reserved[i][6] = true; }
  }

  // 정렬 패턴: 중심 좌표의 데카르트 곱(단, finder와 겹치는 세 모서리 제외).
  const centers = ALIGNMENT_CENTERS[version - 1];
  for (const r of centers) {
    for (const c of centers) {
      // 좌상/우상/좌하 finder와 겹치는 조합은 건너뛴다.
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      placeAlignment(modules, reserved, r, c);
    }
  }

  // dark module: 좌하 finder 위쪽 고정 dark 모듈 (row=4*version+9, col=8) = (size−8, 8).
  modules[size - 8][8] = 1;
  reserved[size - 8][8] = true;

  // format information 영역 예약(15비트 두 사본). 실제 값은 마스크 확정 후 채운다.
  reserveFormatAreas(reserved, size);

  // version information 영역 예약(v7+, 18비트 두 사본).
  if (version >= 7) reserveVersionAreas(reserved, size);

  return { modules, reserved };
}

/** format information 비트가 들어갈 위치들을 예약(reserved=true)한다. */
function reserveFormatAreas(reserved, size) {
  // 좌상 finder 주변: 8행(col 0..8, 단 timing 6 제외 위치 포함) + 8열(row 0..8).
  for (let i = 0; i <= 8; i += 1) {
    reserved[8][i] = true; // 8행 가로
    reserved[i][8] = true; // 8열 세로
  }
  // 우상/좌하 사본.
  for (let i = 0; i < 8; i += 1) reserved[8][size - 1 - i] = true; // 8행 오른쪽
  for (let i = 0; i < 8; i += 1) reserved[size - 1 - i][8] = true; // 8열 아래쪽
}

/** version information 비트(v7+)가 들어갈 위치들을 예약한다. */
function reserveVersionAreas(reserved, size) {
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      reserved[i][size - 11 + j] = true; // 우상 6×3 블록
      reserved[size - 11 + j][i] = true; // 좌하 3×6 블록
    }
  }
}

/**
 * 인터리빙된 코드워드를 비트열로 펴서 행렬의 데이터 영역에 배치한다.
 * 배치 순서(ISO/IEC 18004 §8.7): 오른쪽 아래에서 위로, 두 열씩 묶어 지그재그(상향/하향 교대).
 * timing column(6)은 건너뛴다. 예약(기능)된 셀은 비운다.
 *
 * @param {number[][]} modules 기능 패턴이 채워진 행렬(in-place 수정)
 * @param {boolean[][]} reserved 기능/예약 영역 표시
 * @param {number[]} codewords 인터리빙된 최종 코드워드
 * @param {number} size 행렬 크기
 */
function placeData(modules, reserved, codewords, size) {
  // 코드워드를 MSB-first 비트열로 편다.
  const bits = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b -= 1) bits.push((cw >>> b) & 1);
  }

  let bitIndex = 0;
  let upward = true; // true=위로 올라감
  // 두 열씩(rightCol, rightCol−1) 묶어 오른쪽→왼쪽으로 진행한다.
  // 세로 timing column(6) 전체를 한 번 통째로 건너뛰어야 한다(ISO/IEC 18004 §8.7.3):
  // 쌍의 오른쪽 열이 6이 되는 순간(=7,6 쌍 차례)에는 한 칸 더 왼쪽으로 당겨 (5,4) 쌍으로 넘어간다.
  let rightCol = size - 1;
  while (rightCol > 0) {
    if (rightCol === 6) rightCol = 5; // timing column 건너뛰기
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c += 1) {
        const cc = rightCol - c;
        if (reserved[row][cc]) continue;
        modules[row][cc] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
    rightCol -= 2;
  }
}

// ---------------------------------------------------------------------------
// 6) 마스킹 + 페널티 평가
// ---------------------------------------------------------------------------

/**
 * 마스크 패턴 함수(0~7). (row, col)에 대해 마스크 비트(1=반전)를 반환한다.
 * ISO/IEC 18004 §8.8.1 표 10.
 */
const MASK_FUNCTIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * 데이터 영역(예약되지 않은 셀)에 마스크를 적용한 새 행렬을 반환한다(기능 영역 불변).
 * @param {number[][]} modules 데이터까지 배치된 행렬
 * @param {boolean[][]} reserved 기능/예약 영역
 * @param {number} maskIndex 0~7
 * @returns {number[][]} 마스크 적용된 새 행렬
 */
function applyMask(modules, reserved, maskIndex) {
  const size = modules.length;
  const maskFn = MASK_FUNCTIONS[maskIndex];
  const out = makeMatrix(size, 0);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      let bit = modules[r][c];
      if (!reserved[r][c] && maskFn(r, c)) bit ^= 1;
      out[r][c] = bit;
    }
  }
  return out;
}

// 페널티 가중치(ISO/IEC 18004 §8.8.2 = node-qrcode PenaltyScores).
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/**
 * 표준 페널티 점수(N1~N4)를 계산한다. node-qrcode 의 getPenaltyN1..N4 를 **수식까지 동일하게** 재현해
 * 마스크 선택이 골든(node-qrcode)과 비트 단위로 일치하도록 한다.
 *   N1: 같은 색 연속 5+개(행/열). run≥5당 3 + (run−5).
 *   N2: 2×2 동색 블록 1개당 3점.
 *   N3: 11비트 슬라이딩 윈도가 0x5D0(10111010000) 또는 0x05D(00001011101)와 일치할 때 40점(행/열).
 *   N4: k = |ceil((dark*100/total)/5) − 10|, 페널티 = k*10.
 * @param {number[][]} m 평가 대상 행렬(0/1)
 * @returns {number} 총 페널티
 */
function maskPenalty(m) {
  const size = m.length;
  return penaltyN1(m, size) + penaltyN2(m, size) + penaltyN3(m, size) + penaltyN4(m, size);
}

/** N1: 행/열 연속 동색 5+. node-qrcode getPenaltyN1 동치. */
function penaltyN1(m, size) {
  let points = 0;
  for (let row = 0; row < size; row += 1) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol = null;
    let lastRow = null;
    for (let col = 0; col < size; col += 1) {
      const a = m[row][col];
      if (a === lastCol) sameCol += 1;
      else {
        if (sameCol >= 5) points += PENALTY_N1 + (sameCol - 5);
        lastCol = a;
        sameCol = 1;
      }
      const b = m[col][row];
      if (b === lastRow) sameRow += 1;
      else {
        if (sameRow >= 5) points += PENALTY_N1 + (sameRow - 5);
        lastRow = b;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += PENALTY_N1 + (sameCol - 5);
    if (sameRow >= 5) points += PENALTY_N1 + (sameRow - 5);
  }
  return points;
}

/** N2: 2×2 동색 블록(모두 dark 또는 모두 light)당 3점. */
function penaltyN2(m, size) {
  let points = 0;
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const sum = m[row][col] + m[row][col + 1] + m[row + 1][col] + m[row + 1][col + 1];
      if (sum === 4 || sum === 0) points += 1;
    }
  }
  return points * PENALTY_N2;
}

/**
 * N3: 11비트 슬라이딩 윈도(행/열)가 0x5D0 또는 0x05D와 일치하는 횟수 × 40.
 * node-qrcode getPenaltyN3 와 동일하게 col≥10일 때만 검사한다(윈도가 11비트 채워진 뒤).
 */
function penaltyN3(m, size) {
  let points = 0;
  for (let row = 0; row < size; row += 1) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col += 1) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | m[row][col];
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 1;
      bitsRow = ((bitsRow << 1) & 0x7ff) | m[col][row];
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 1;
    }
  }
  return points * PENALTY_N3;
}

/** N4: 어두운 모듈 비율 편차. k=|ceil((dark*100/total)/5)−10|, 페널티=k*10. */
function penaltyN4(m, size) {
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) dark += m[r][c];
  }
  const total = size * size;
  const k = Math.abs(Math.ceil((dark * 100 / total) / 5) - 10);
  return k * PENALTY_N4;
}

// ---------------------------------------------------------------------------
// 7) format / version 정보 비트 (BCH)
// ---------------------------------------------------------------------------

/**
 * format information 15비트를 계산한다. 5비트(2비트 ECC level + 3비트 mask)에 BCH(15,5) 패리티 10비트를
 * 붙이고, 마스크 상수 0x5412 로 XOR한다(ISO/IEC 18004 §8.9). ECC level L의 2비트 표기는 0b01.
 * @param {number} maskIndex 0~7
 * @returns {number} 15비트 format 정보
 */
function computeFormatBits(maskIndex) {
  const formatPoly = 0b10100110111; // BCH 생성 다항식 G(x) (11비트)
  const data = (0b01 << 3) | maskIndex; // ECC L=0b01, mask 3비트
  let bch = data << 10;
  // 10차 나머지가 될 때까지 최상위 비트를 기준으로 XOR 나눗셈.
  for (let i = 14; i >= 10; i -= 1) {
    if ((bch >>> i) & 1) bch ^= formatPoly << (i - 10);
  }
  const result = ((data << 10) | (bch & 0x3ff)) ^ 0b101010000010010;
  return result & 0x7fff;
}

/**
 * version information 18비트(v7+)를 계산한다. 6비트 version에 BCH(18,6) 패리티 12비트를 붙인다.
 * @param {number} version 7~10
 * @returns {number} 18비트 version 정보
 */
function computeVersionBits(version) {
  const versionPoly = 0b1111100100101; // BCH 생성 다항식 G(x) (13비트)
  let bch = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((bch >>> i) & 1) bch ^= versionPoly << (i - 12);
  }
  return ((version << 12) | (bch & 0xfff)) & 0x3ffff;
}

/**
 * format 정보 15비트를 행렬의 두 사본 위치에 배치한다(ISO/IEC 18004 §8.9 그림 25).
 *
 * 배치 순서(중요): format 비트는 **MSB-first**로 깐다. 즉 비트 14(최상위)가 경로의 첫 셀에
 * 들어간다. 표준 그림 25의 경로:
 *   사본 1(좌상 finder 주변): bit14 → (row8,col0) ... 가로로 진행하다 col6(timing) 건너뛰고
 *     col7,col8, 그다음 (row7,col8) 건너뛰지 않고, 세로로 올라가며 row0까지.
 *   사본 2: bit14 → (row size−1, col8) 위로, 그다음 (row8, col size−8 .. size−1).
 *
 * node-qrcode 와 비트 단위로 일치하도록 좌표↔비트 매핑을 표준에 정확히 맞춘다(test/qr-golden.json
 * 셀 단위 검증으로 확정).
 */
function placeFormatBits(modules, size, formatBits) {
  // bit(n): 15비트 format 값에서 n번째 비트(0=LSB).
  const bit = (n) => (formatBits >>> n) & 1;

  // 사본 1 — 가로줄(8행): col 0..5 ← bit14..9, col7 ← bit8, col8 ← bit7.
  for (let col = 0; col <= 5; col += 1) modules[8][col] = bit(14 - col);
  modules[8][7] = bit(8);
  modules[8][8] = bit(7);
  // 사본 1 — 세로줄(8열): row7 ← bit6, row5..0 ← bit5..0 (timing row6 건너뜀).
  modules[7][8] = bit(6);
  for (let row = 5, n = 5; row >= 0; row -= 1, n -= 1) modules[row][8] = bit(n);

  // 사본 2 — 세로줄(8열 아래쪽): row size−1..size−7 ← bit14..8.
  for (let i = 0; i <= 6; i += 1) modules[size - 1 - i][8] = bit(14 - i);
  // 사본 2 — 가로줄(8행 오른쪽): col size−8..size−1 ← bit7..0.
  for (let i = 0; i <= 7; i += 1) modules[8][size - 8 + i] = bit(7 - i);
}

/**
 * version 정보 18비트(v7+)를 우상/좌하 두 블록에 배치한다(ISO/IEC 18004 §8.10 그림 26).
 *
 * 18비트는 LSB(bit0)가 좌하/우상 블록의 가장 바깥(좌상단) 셀에 들어가는 표준 순서로 깐다.
 * 우상 블록: row 0..5, col (size−11..size−9). 좌하 블록: 전치.
 */
function placeVersionBits(modules, size, versionBits) {
  for (let i = 0; i < 18; i += 1) {
    const b = (versionBits >>> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    // 우상 6×3 블록.
    modules[row][size - 11 + col] = b;
    // 좌하 3×6 블록(전치).
    modules[size - 11 + col][row] = b;
  }
}

// ---------------------------------------------------------------------------
// 8) 공개 API
// ---------------------------------------------------------------------------

/**
 * 텍스트를 byte 모드·ECC L QR 코드 모듈 행렬로 인코딩한다.
 *
 * 파이프라인: chooseVersion → byteEncode(데이터 코드워드) → interleaveBlocks(데이터+RS EC) →
 *   기능 패턴 배치 → 데이터 배치 → 마스크 0~7 전수 평가(최저 페널티, 동점시 낮은 번호) →
 *   format/version(v7+) 비트 배치.
 *
 * @param {string} text 인코딩할 문자열(URL 등). UTF-8로 바이트화된다.
 * @param {{ecc?:string, maxVersion?:number}} [options]
 *   - ecc: 현재 'L'만 지원(기본 'L'). 다른 값은 무시되고 L로 처리한다.
 *   - maxVersion: 허용 최대 version(기본 10). 초과 데이터면 throw.
 * @returns {{size:number, modules:boolean[][]}} 정사각 모듈 행렬(true=dark)
 * @throws {Error} maxVersion으로도 담을 수 없으면 throw
 */
export function encodeQrMatrix(text, { ecc = 'L', maxVersion = 10 } = {}) {
  void ecc; // 현재 레벨 L 고정(인터페이스 호환을 위해 인자만 수용)
  // node-qrcode 호환 세그먼트 최적화로 version·세그먼트를 결정한다(byte 단일이 아님).
  const { version, segments } = chooseVersionAndSegments(text, maxVersion);
  const size = sizeForVersion(version);

  // 데이터 코드워드 + RS EC 인터리빙.
  const dataCodewords = encodeSegments(segments, version);
  const finalCodewords = interleaveBlocks(dataCodewords, version);

  // 기능 패턴 + 데이터 배치.
  const { modules: base, reserved } = placeFunctionPatterns(version);
  placeData(base, reserved, finalCodewords, size);

  // 마스크 0~7 전수 평가: 최저 페널티, 동점이면 낮은 번호.
  // (루프를 0→7 순서로 돌며 `<` 비교만 쓰므로 동점일 때 먼저 본 낮은 번호가 유지된다 → 결정적.)
  let bestMatrix = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const masked = applyMask(base, reserved, mask);
    // 페널티는 format(및 v7+ version) 비트를 깐 상태에서 평가한다(node-qrcode getBestMask 동일).
    placeFormatBits(masked, size, computeFormatBits(mask));
    if (version >= 7) placeVersionBits(masked, size, computeVersionBits(version));
    const score = maskPenalty(masked);
    if (score < bestScore) {
      bestScore = score;
      bestMatrix = masked;
    }
  }

  // 결과를 boolean 행렬로 변환(true=dark).
  const modules = bestMatrix.map((row) => row.map((cell) => cell === 1));
  return { size, modules };
}

/**
 * QR 모듈 행렬을 터미널 문자열로 렌더한다. 상하 half-block 문자로 2행을 1터미널행에 압축한다.
 *   상단 픽셀=dark·하단=dark → '█', 상단 dark·하단 light → '▀', 상단 light·하단 dark → '▄',
 *   둘 다 light → ' '(공백).
 * quiet zone(밝은 여백)을 사방 quiet 모듈 추가한다. invert=true면 dark/light 의미를 반전한다
 *   (밝은 배경 터미널에서 스캔되도록).
 *
 * @param {{size:number, modules:boolean[][]}} matrix encodeQrMatrix 결과
 * @param {{invert?:boolean, quiet?:number}} [options]
 *   - invert: true면 명암 반전(기본 false = 다크 배경 기준)
 *   - quiet: quiet zone 모듈 수(기본 4)
 * @returns {string} 줄바꿈으로 구분된 터미널 렌더 문자열
 */
export function renderQrToTerminal(matrix, { invert = false, quiet = 4 } = {}) {
  const { size, modules } = matrix;
  const padded = size + quiet * 2;

  // quiet zone을 포함한 확장 행렬(true=dark)을 만든다.
  const isDark = (r, c) => {
    const mr = r - quiet;
    const mc = c - quiet;
    if (mr < 0 || mr >= size || mc < 0 || mc >= size) return false; // quiet zone은 light
    return modules[mr][mc];
  };

  const lines = [];
  // 2행씩 묶어 half-block으로 압축. padded가 홀수면 마지막 하단행은 light로 처리.
  for (let r = 0; r < padded; r += 2) {
    let line = '';
    for (let c = 0; c < padded; c += 1) {
      let top = isDark(r, c);
      let bottom = r + 1 < padded ? isDark(r + 1, c) : false;
      if (invert) {
        top = !top;
        bottom = !bottom;
      }
      line += halfBlockChar(top, bottom);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 상단/하단 dark 여부 조합을 half-block 문자로 매핑한다. */
function halfBlockChar(top, bottom) {
  if (top && bottom) return '█';
  if (top && !bottom) return '▀';
  if (!top && bottom) return '▄';
  return ' ';
}
