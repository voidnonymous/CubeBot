import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';

// --- PNG encoding (map CAPTCHA) ---

const BASE_COLORS = [
  [0, 0, 0],       [127, 178, 56], [247, 233, 163], [199, 199, 199],
  [255, 0, 0],     [160, 160, 255], [167, 167, 167], [0, 124, 0],
  [255, 255, 255], [164, 168, 184], [151, 109, 77],  [112, 112, 112],
  [64, 64, 255],   [143, 119, 72],  [255, 252, 245], [216, 127, 51],
  [178, 76, 216],  [102, 153, 216], [229, 229, 51],  [127, 204, 25],
  [242, 127, 165], [76, 76, 76],    [153, 153, 153], [76, 127, 153],
  [127, 63, 178],  [51, 76, 178],   [102, 76, 51],   [102, 127, 51],
  [153, 51, 51],   [25, 25, 25],    [250, 238, 77],  [92, 219, 213],
  [74, 128, 255],  [0, 217, 58],    [129, 86, 49],   [112, 2, 0],
];

const SHADE_MULTS = [180, 220, 255, 135];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeB, data]);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(body));
  return Buffer.concat([len, typeB, data, crcB]);
}

function handleCreatePNG(msg) {
  const { id, width, height } = msg;
  const rgba = msg.rgba;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    raw[rowOff] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = rowOff + 1 + x * 3;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
    }
  }

  const compressed = zlib.deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  parentPort.postMessage({ id, type: 'png', data: png });
}

// --- FNV-1a hashing (chunk tracker) ---

function handleHash(msg) {
  const { id, key } = msg;
  const buf = Buffer.from(msg.data);
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  parentPort.postMessage({ id, type: 'hashResult', key, hash: hash.toString(16) });
}

// --- Word scoring (word solver) ---

const LETTER_SCORES = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1,
  j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1,
  s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
};

function signature(word) {
  return [...word].sort().join('');
}

function normalizeWord(value) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function scoreWord(word, normalized, sig, qtable) {
  let score = 0;
  if (word.toLowerCase() !== normalized.toLowerCase()) score += 50;
  score += Math.max(0, 15 - word.length) * 3;
  const rareLetters = word.split('').filter((c) => (LETTER_SCORES[c] || 1) >= 5).length;
  score += rareLetters * 5;
  const qEntry = qtable?.[sig]?.[word];
  if (qEntry) {
    const rate = qEntry.attempts > 0 ? qEntry.wins / qEntry.attempts : 0.5;
    score += rate * 20;
  }
  score += Math.random() * 2;
  return score;
}

function handleScoreCandidates(msg) {
  const { id, scrambled, candidates, qtable } = msg;
  const normalized = normalizeWord(scrambled);
  const sig = signature(normalized);
  const scored = candidates.map((word) => ({
    word,
    score: scoreWord(word, normalized, sig, qtable),
  }));
  scored.sort((a, b) => b.score - a.score);
  parentPort.postMessage({ id, type: 'scored', scored: scored.map((s) => s.word) });
}

// --- Router ---

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'createPNG': handleCreatePNG(msg); break;
      case 'hash':      handleHash(msg); break;
      case 'scoreCandidates': handleScoreCandidates(msg); break;
      default:
        parentPort.postMessage({ id: msg.id, type: 'error', error: `Unknown task: ${msg.type}` });
    }
  } catch (err) {
    parentPort.postMessage({ id: msg.id, type: 'error', error: err.message });
  }
});
