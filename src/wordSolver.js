import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from './workers/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QTABLE_FILE = path.resolve(__dirname, '..', 'qtable.json');
const QTABLE_FILE_GZ = QTABLE_FILE + '.gz';

let _pool = null;
function getPool() {
  if (!_pool) {
    try {
      _pool = new WorkerPool({ size: 1 });
    } catch {
      _pool = null;
    }
  }
  return _pool;
}

async function scoreCandidatesInWorker(scrambled, candidates, qtable) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.postMessage(
      { type: 'scoreCandidates', scrambled, candidates, qtable }
    );
    return res.scored;
  } catch {
    return null;
  }
}

// Exact message must match start-to-end — no extra prefix/suffix
const TYPE_PROMPT = /^The first person to type\s+(.+?)\s+wins\s+\$500!?$/i;
const FALLBACK_TYPE_PROMPT = /^type\s+(.+?)\s+wins$/i;
const UNSCRAMBLE_PROMPT = /^The first person to unscramble\s+(.+?)\s+wins\s+\$500!?$/i;
const FALLBACK_UNSCRAMBLE_PROMPT = /^unscramble\s+(.+?)\s+wins$/i;

const BLOCKED = new Set([
  'nigger', 'nigga', 'niger', 'faggot', 'fag', 'kike', 'spic', 'chink', 'gook',
  'wetback', 'coon', 'cunt', 'whore', 'slut',
]);

const LETTER_SCORES = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1,
  j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1,
  s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
};

export class WordSolver {
  constructor(wordsPath) {
    this.wordsPath = wordsPath;
    this.anagrams = new Map();
    this.qtable = this.loadQTable();
    this.stats = { skipped: 0, loaded: 0 };
    this.loadWords();
  }

  async findAnswer(text) {
    let match;

    match = TYPE_PROMPT.exec(text);
    if (match) {
      const answer = cleanAnswer(match[1]);
      if (!isValidPromptAnswer(answer)) return null;
      return {
        kind: 'typing',
        answer,
        prompt: text,
      };
    }

    match = UNSCRAMBLE_PROMPT.exec(text);
    if (match) {
      const raw = cleanAnswer(match[1]);
      if (!isValidPromptAnswer(raw)) return null;
      return this.makeScrambleResult(raw, text);
    }

    match = FALLBACK_TYPE_PROMPT.exec(text);
    if (match) {
      const answer = cleanAnswer(match[1]);
      if (!isValidPromptAnswer(answer)) return null;
      return {
        kind: 'typing',
        answer,
        prompt: text,
        fallback: true,
      };
    }

    match = FALLBACK_UNSCRAMBLE_PROMPT.exec(text);
    if (match) {
      const raw = cleanAnswer(match[1]);
      if (!isValidPromptAnswer(raw)) return null;
      const result = await this.makeScrambleResult(raw, text);
      result.fallback = true;
      return result;
    }

    return null;
  }

  async makeScrambleResult(raw, text) {
    const scrambled = cleanAnswer(raw);
    const answers = await this.unscrambleAllAsync(scrambled);
    return {
      kind: 'scramble',
      answer: answers[0] || null,
      answers,
      prompt: text,
      scrambled,
    };
  }

  loadWords() {
    this.stats = { skipped: 0, loaded: 0 };
    if (!fs.existsSync(this.wordsPath)) {
      return;
    }

    const words = fs.readFileSync(this.wordsPath, 'utf8').split(/\r?\n/);
    for (const rawWord of words) {
      this.addWord(rawWord);
    }
  }

  addWord(rawWord) {
    if (!/^[a-zA-Z]/.test(rawWord)) {
      this.stats.skipped++;
      return;
    }
    const word = normalizeWord(rawWord);
    if (word.length < 2) {
      this.stats.skipped++;
      return;
    }
    if (BLOCKED.has(word)) {
      this.stats.skipped++;
      return;
    }

    const key = signature(word);
    const existing = this.anagrams.get(key);
    if (existing) {
      if (existing.split(' ').indexOf(word) === -1) {
        this.anagrams.set(key, existing + ' ' + word);
      }
    } else {
      this.anagrams.set(key, word);
    }
    this.stats.loaded++;
  }

  reloadWords() {
    this.anagrams.clear();
    this.loadWords();
  }

  unscramble(scrambled) {
    return this.unscrambleAll(scrambled)[0] ?? null;
  }

  unscrambleAll(scrambled) {
    const normalized = normalizeWord(scrambled);
    if (!normalized) return [];

    const sig = signature(normalized);
    const raw = this.anagrams.get(sig);
    if (!raw) return [];

    const words = raw.split(' ');
    const scored = words.map((word) => ({
      word,
      score: this.scoreWord(word, normalized, sig),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.map((s) => s.word);
  }

  async unscrambleAllAsync(scrambled) {
    const normalized = normalizeWord(scrambled);
    if (!normalized) return [];

    const sig = signature(normalized);
    const raw = this.anagrams.get(sig);
    if (!raw) return [];

    const words = raw.split(' ');
    try {
      const scored = await scoreCandidatesInWorker(scrambled, words, this.qtable);
      if (scored) return scored;
    } catch {}
    return this.unscrambleAll(scrambled);
  }

  scoreWord(word, normalized, sig) {
    let score = 0;

    if (word.toLowerCase() !== normalized.toLowerCase()) {
      score += 50;
    }

    score += Math.max(0, 15 - word.length) * 3;

    const rareLetters = word.split('').filter((c) => (LETTER_SCORES[c] || 1) >= 5).length;
    score += rareLetters * 5;

    const qEntry = this.qtable[sig]?.[word];
    if (qEntry) {
      const rate = qEntry.attempts > 0 ? qEntry.wins / qEntry.attempts : 0.5;
      score += rate * 20;
    }

    score += Math.random() * 2;

    return score;
  }

  recordWin(scrambled, answer) {
    const normalized = normalizeWord(scrambled);
    const sig = signature(normalized);
    if (!this.qtable[sig]) this.qtable[sig] = {};
    if (!this.qtable[sig][answer]) this.qtable[sig][answer] = { wins: 0, attempts: 0 };
    this.qtable[sig][answer].wins += 1;
    this.qtable[sig][answer].attempts += 1;
    this.saveQTable();
  }

  recordLoss(scrambled, answer) {
    const normalized = normalizeWord(scrambled);
    const sig = signature(normalized);
    if (!this.qtable[sig]) this.qtable[sig] = {};
    if (!this.qtable[sig][answer]) this.qtable[sig][answer] = { wins: 0, attempts: 0 };
    this.qtable[sig][answer].attempts += 1;
    this.saveQTable();
  }

  getQValue(scrambled, answer) {
    const normalized = normalizeWord(scrambled);
    const sig = signature(normalized);
    const entry = this.qtable[sig]?.[answer];
    if (!entry || entry.attempts === 0) return 0.5;
    return entry.wins / entry.attempts;
  }

  shouldExplore(candidates, scrambled) {
    if (candidates.length < 2) return false;
    const top = candidates[0];
    const sig = signature(normalizeWord(scrambled));
    const entry = this.qtable[sig]?.[top];
    if (!entry || entry.attempts < 3) return false;
    return entry.wins === 0;
  }

  loadQTable() {
    try {
      if (fs.existsSync(QTABLE_FILE_GZ)) {
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(QTABLE_FILE_GZ)).toString('utf8'));
      }
      if (fs.existsSync(QTABLE_FILE)) {
        return JSON.parse(fs.readFileSync(QTABLE_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('Error loading qtable:', err);
    }
    return {};
  }

  saveQTable() {
    try {
      const data = Buffer.from(JSON.stringify(this.qtable), 'utf8');
      fs.writeFileSync(QTABLE_FILE_GZ, zlib.gzipSync(data, { level: 9 }));
      try { fs.unlinkSync(QTABLE_FILE); } catch {}
    } catch (err) {
      console.error('Error saving qtable:', err);
    }
  }

  addAndSaveWord(rawWord) {
    const word = normalizeWord(rawWord);
    if (word.length < 2) return;

    const key = signature(word);
    const existing = this.anagrams.get(key);
    if (existing && existing.split(' ').indexOf(word) !== -1) return;

    this.addWord(rawWord);

    try {
      fs.appendFileSync(this.wordsPath, `\n${rawWord}`, 'utf8');
    } catch (error) {
      console.error(`Error saving word to words.txt: ${error.message}`);
    }
  }
}

export function cleanAnswer(raw) {
  let answer = raw.trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['[', ']'],
    ['{', '}'],
    ['(', ')'],
  ];

  for (const [start, end] of pairs) {
    if (answer.startsWith(start) && answer.endsWith(end)) {
      answer = answer.slice(1, -1).trim();
      break;
    }
  }

  return answer;
}

// Reject answers that aren't pure letters/spaces (catches @mentions, symbols, numbers)
export function isValidPromptAnswer(word) {
  if (!word || word.length > 40) return false;
  return /^[a-zA-Z][a-zA-Z\s]*[a-zA-Z]$|^[a-zA-Z]$/.test(word);
}

export function normalizeWord(value) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function signature(word) {
  return [...word].sort().join('');
}
