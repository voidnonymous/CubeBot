import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessageSenderAndContent } from './chatParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.resolve(__dirname, '..', 'stats.json');
const STATS_FILE_GZ = STATS_FILE + '.gz';

const MAX_LOGS = 100;
const MAX_CHATS = 100;

export class StatsStore extends EventEmitter {
  constructor() {
    super();
    this.longTerm = this.loadLongTermStats();
    this.reset();
  }

  loadLongTermStats() {
    try {
      if (fs.existsSync(STATS_FILE_GZ)) {
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(STATS_FILE_GZ)).toString('utf8'));
      }
      if (fs.existsSync(STATS_FILE)) {
        return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('Error loading stats:', err);
    }
    return {
      allTimeMana: 0,
      allTimeAnswersSent: 0,
      allTimeTypingAnswers: 0,
      allTimeScrambleAnswers: 0,
      allTimeTypingPromptsSeen: 0,
      allTimeScramblePromptsSeen: 0,
      allTimeWins: 0,
      allTimeSessions: 0,
      firstStartAt: new Date().toISOString(),
      lastStartAt: null,
    };
  }

  saveLongTermStats() {
    try {
      const data = Buffer.from(JSON.stringify(this.longTerm), 'utf8');
      fs.writeFileSync(STATS_FILE_GZ, zlib.gzipSync(data, { level: 9 }));
      try { fs.unlinkSync(STATS_FILE); } catch {}
    } catch (err) {
      console.error('Error saving stats:', err);
    }
  }

  accumulateToLongTerm() {
    this.longTerm.allTimeMana += this.state.mana;
    this.longTerm.allTimeAnswersSent += this.state.totalAnswersSent;
    this.longTerm.allTimeTypingAnswers += this.state.typingAnswersSent;
    this.longTerm.allTimeScrambleAnswers += this.state.scrambleAnswersSent;
    this.longTerm.allTimeTypingPromptsSeen += this.state.typingPromptsSeen;
    this.longTerm.allTimeScramblePromptsSeen += this.state.scramblePromptsSeen;
    this.longTerm.allTimeSessions += 1;
    this.longTerm.lastStartAt = this.state.startedAt;
    this.saveLongTermStats();
  }

  reset() {
    this.state = this.createInitialState();
    this.emitChange();
  }

  resetCounters() {
    this.accumulateToLongTerm();

    const connection = {
      connected: this.state.connected,
      connecting: this.state.connecting,
      username: this.state.username,
      host: this.state.host,
      version: this.state.version,
      lastError: this.state.lastError,
      joinedAt: this.state.joinedAt,
      leftAt: this.state.leftAt,
    };

    this.state = {
      ...this.createInitialState(),
      ...connection,
    };
    this.recordLog('info', 'Stats reset');
  }

  createInitialState() {
    return {
      connected: false,
      connecting: false,
      username: null,
      host: null,
      version: null,
      lastError: null,
      lastMessage: null,
      lastActionBar: null,
      lastManaSeconds: null,
      microsoftAuth: null,
      manaCycles: 0,
      mana: 0,
      typingPromptsSeen: 0,
      scramblePromptsSeen: 0,
      typingAnswersSent: 0,
      scrambleAnswersSent: 0,
      totalAnswersSent: 0,
      wins: 0,
      duplicatePromptsIgnored: 0,
      unknownScrambles: 0,
      resourcePacksAccepted: 0,
      joinedAt: null,
      leftAt: null,
      startedAt: new Date().toISOString(),
      logs: [],
      chats: [],
      onlinePlayers: [],
      manaHistory: [],
      longTerm: { ...this.longTerm },
    };
  }

  snapshot() {
    return structuredClone(this.state);
  }

  setConnection(partial) {
    Object.assign(this.state, partial);
    this.emitChange();
  }

  recordLog(level, message, details = null) {
    this.state.logs.unshift({
      at: new Date().toISOString(),
      level,
      message,
      details,
    });
    this.state.logs = this.state.logs.slice(0, MAX_LOGS);
    this.emitChange();
  }

  recordPrompt(kind) {
    if (kind === 'typing') {
      this.state.typingPromptsSeen += 1;
    } else if (kind === 'scramble') {
      this.state.scramblePromptsSeen += 1;
    }
    this.emitChange();
  }

  recordAnswer(kind) {
    if (kind === 'typing') {
      this.state.typingAnswersSent += 1;
    } else if (kind === 'scramble') {
      this.state.scrambleAnswersSent += 1;
    }
    this.state.totalAnswersSent += 1;
    this.emitChange();
  }

  recordWin() {
    this.state.wins += 1;
    this.longTerm.allTimeWins += 1;
    this.saveLongTermStats();
    this.emitChange();
  }

  recordDuplicatePrompt() {
    this.state.duplicatePromptsIgnored += 1;
    this.emitChange();
  }

  recordUnknownScramble() {
    this.state.unknownScrambles += 1;
    this.emitChange();
  }

  recordResourcePackAccepted() {
    this.state.resourcePacksAccepted += 1;
    this.emitChange();
  }

  recordMicrosoftAuthCode(code) {
    this.state.microsoftAuth = {
      userCode: code.user_code,
      deviceCode: code.device_code,
      verificationUri: code.verification_uri,
      expiresAt: new Date(Date.now() + code.expires_in * 1000).toISOString(),
      intervalSeconds: code.interval,
      message: code.message,
    };
    this.recordLog('auth', 'Microsoft login code generated', `${code.verification_uri} code ${code.user_code}`);
  }

  clearMicrosoftAuthCode() {
    this.state.microsoftAuth = null;
    this.emitChange();
  }

  recordMessage(text) {
    this.state.lastMessage = text;

    const parsed = parseMessageSenderAndContent(text);

    this.state.chats.unshift({
      at: new Date().toISOString(),
      text,
      username: parsed ? parsed.username : null,
      content: parsed ? parsed.content : text,
      isPm: parsed ? parsed.isPm : false,
    });
    this.state.chats = this.state.chats.slice(0, MAX_CHATS);

    this.emitChange();
  }

  recordActionBar(text) {
    this.state.lastActionBar = text;
    const seconds = parseManaSeconds(text);
    if (seconds == null) {
      this.emitChange();
      return;
    }

    if (this.state.lastManaSeconds !== null && seconds > this.state.lastManaSeconds) {
      if (seconds - this.state.lastManaSeconds > 10) {
        this.state.manaCycles += 1;
        this.state.mana = this.state.manaCycles * 5;
        this.longTerm.allTimeMana += 5;
        this.saveLongTermStats();
        this.recordLog('info', `Earned +5 Mana! Total: ${this.state.mana} (Cycles: ${this.state.manaCycles})`);
        this.state.manaHistory.push({ t: Date.now(), v: this.state.mana });
        if (this.state.manaHistory.length > 120) {
          this.state.manaHistory = this.state.manaHistory.slice(-120);
        }
      }
    }

    this.state.lastManaSeconds = seconds;
    this.emitChange();
  }

  setOnlinePlayers(players) {
    this.state.onlinePlayers = players;
    this.emitChange();
  }

  setScoreboard(entries) {
    this._scoreboard = entries;
  }

  getScoreboard() {
    return this._scoreboard ?? [];
  }

  emitChange() {
    this.state.longTerm = { ...this.longTerm };
    this.emit('change', this.snapshot());
  }
}

function parseManaSeconds(text) {
  if (!text) return null;

  const cleanText = text.replace(/[§&][0-9a-fA-Fk-oK-ORxX]/g, '').trim();

  const match = /mana\b.*?(\d{1,3})/i.exec(cleanText);
  if (match) {
    return Number.parseInt(match[1], 10);
  }

  return null;
}
