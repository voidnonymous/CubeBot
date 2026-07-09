import mineflayer from 'mineflayer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseMessageSenderAndContent, parseNobodyGotScrambler, parseNobodyNoWord, parseTheWordWas } from './chatParser.js';
import { MapHandler } from './mapHandler.js';
import { ChunkTracker } from './chunkTracker.js';

const DUPLICATE_WINDOW_MS = 750;
const HEARTBEAT_IDLE_MS = 300000; // 5 min no prompts → warn
const SCRAMBLE_INTERVAL_MIN = 2000;
const SCRAMBLE_INTERVAL_MAX = 5000;
const CRUISE_WPM_MIN = 60;
const CRUISE_WPM_MAX = 85;

// Anti-detection — tunable via config endpoint
let ANTI_SKIP_RATE = 35;        // % chance to ignore a prompt entirely
let ANTI_WRONG_RATE = 20;       // % chance to send a wrong scramble answer instead of correct
let ANTI_MAX_RETRIES = 3;       // max candidates to try per scramble
let ANTI_TYPO_RATE = 10;        // % chance to insert a typo into a typing answer
let ANTI_TYPO_FIX_RATE = 60;    // % chance to correct the typo (send typo first, then correct)
let ACTIVE_START_HOUR = 9;      // 9AM — bot starts answering
let ACTIVE_END_HOUR = 23;       // 11PM — bot stops answering
let ACTIVE_JITTER_MINUTES = 60; // ±minutes to jitter start/end daily
let BREAK_INTERVAL_MIN = 20;    // min minutes between breaks
let BREAK_INTERVAL_MAX = 60;    // max minutes between breaks
let BREAK_DURATION_MIN = 3;     // min break duration in minutes
let BREAK_DURATION_MAX = 12;    // max break duration in minutes
let JOIN_GRACE_MAX = 120;       // max seconds after join before first answer
let FATIGUE_THRESHOLD = 2;      // consecutive answers before getting tired
let FATIGUE_SKIP_MIN = 5;       // min prompts to skip when tired
let FATIGUE_SKIP_MAX = 7;       // max prompts to skip when tired
const USER_ACTIVE_MS = 300000;  // 5 min — considered "user is at keyboard" after last WebUI message
const CHAT_LOG_PATH = path.resolve(process.cwd(), 'chat.log');

const BLOCKED_WORDS = new Set([
  'nigger', 'nigga', 'niger', 'faggot', 'fag', 'kike', 'spic', 'chink', 'gook',
  'wetback', 'coon', 'cunt', 'whore', 'slut',
]);

export class BotController {
  constructor({ solver, stats }) {
    this.solver = solver;
    this.stats = stats;
    this.bot = null;
    this.lastPrompt = '';
    this.lastPromptAt = 0;
    this.scheduledTimers = new Set();
    this.scheduledCommandTimers = new Map();
    this.activeScramble = null;
    this.intentionalLeave = false;
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.lastPlayerList = [];
    this.heartbeatTimer = null;
    this._scheduledCommands = [];
    this._answeringEnabled = true;
    this._scoreboardEmptyLogged = false;
    this._lastCommandTime = 0;
    this._lastPosition = null;
    this._privateTarget = null;
    this._pendingNobodyWord = false;
    this._jitterDate = '';
    this._jitteredStart = ACTIVE_START_HOUR * 60;
    this._jitteredEnd = ACTIVE_END_HOUR * 60;
    this._onBreak = false;
    this._breakUntil = 0;
    this._nextBreakAt = Date.now() + randomInt(BREAK_INTERVAL_MIN, BREAK_INTERVAL_MAX) * 60000;
    this._joinedAt = 0;
    this._consecutiveAnswers = 0;
    this._fatigueRemaining = 0;
    this._lastUserActivity = 0;
    this.mapHandler = null;
  }

  join() {
    if (this.bot || this.stats.snapshot().connecting) {
      return { ok: false, message: 'Bot is already connected or connecting.' };
    }

    this.intentionalLeave = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stats.setConnection({
      connecting: true,
      connected: false,
      lastError: null,
      host: config.bot.host,
      version: config.bot.version,
      username: config.bot.username,
    });
    this.stats.recordLog('info', `Joining ${config.bot.host} as ${config.bot.username}`);

    const bot = mineflayer.createBot({
      host: config.bot.host,
      port: config.bot.port,
      username: config.bot.username,
      auth: config.bot.auth,
      version: config.bot.version,
      profilesFolder: config.bot.profilesFolder,
      physicsEnabled: false,
      onMsaCode: (code) => this.stats.recordMicrosoftAuthCode(code),
    });

    this.bot = bot;
    this.attachEvents(bot);
    this.mapHandler = new MapHandler(bot, (level, ...args) => this.stats.recordLog(level, ...args));
    return { ok: true, message: 'Join started.' };
  }

  leave(reason = 'Manual leave') {
    if (!this.bot) {
      return { ok: false, message: 'Bot is not connected.' };
    }

    this.intentionalLeave = true;
    this.reconnectAttempts = 0;
    this.activeScramble = null;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.clearTimers();
    if (this.mapHandler) {
      this.mapHandler.stop();
    this.mapHandler = null;
    this.chunkTracker = null;
    }
    this.stats.recordLog('info', reason);
    this.bot.quit(reason);
    this.bot = null;
    this.stats.setConnection({
      connected: false,
      connecting: false,
      leftAt: new Date().toISOString(),
    });
    return { ok: true, message: 'Leave requested.' };
  }

  runHardcore() {
    return this.sendCommand('/hardcore');
  }

  runWarpAfk() {
    return this.sendCommand('/warp afk');
  }

  sendCommand(command) {
    if (!this.bot) {
      return { ok: false, message: 'Bot is not connected.' };
    }

    // Private mode: !Private <name> enters, !Public exits
    const privateCmd = command.match(/^!Private\s+(.+)/i);
    if (privateCmd) {
      this._privateTarget = privateCmd[1].trim();
      this.stats.recordLog('info', `Private mode enabled — messaging ${this._privateTarget}`);
      return { ok: true, message: `Private mode: ${this._privateTarget}` };
    }
    if (/^!Public$/i.test(command.trim())) {
      this._privateTarget = null;
      this.stats.recordLog('info', 'Private mode disabled');
      return { ok: true, message: 'Exited private mode' };
    }

    this._lastCommandTime = Date.now();
    const toSend = this._privateTarget ? `/msg ${this._privateTarget} ${command}` : command;
    this.bot.chat(toSend);
    this.stats.recordLog('command', toSend);
    return { ok: true, message: `Sent ${toSend}` };
  }

  sendUserCommand(command) {
    this._lastUserActivity = Date.now();
    return this.sendCommand(command);
  }

  attachEvents(bot) {
    bot.once('login', () => {
      this.reconnectAttempts = 0;

      this.stats.setConnection({
        connecting: false,
        connected: true,
        joinedAt: new Date().toISOString(),
        leftAt: null,
        username: bot.username,
      });
      this.stats.clearMicrosoftAuthCode();
      this.stats.recordLog('info', `Logged in as ${bot.username}`);
      this._scoreboardEmptyLogged = false;
      this.scheduleStartupCommands();
      this.scheduleAllUserCommands();
      this.updatePlayerList();
      this.parseScoreboard();

      // Resume scramble if one was interrupted by disconnect
      if (this.activeScramble && !this.activeScramble.won) {
        this.activeScramble.startTime = Date.now();
        this.activeScramble.currentIndex = this.activeScramble.currentIndex || 0;
        this.stats.recordLog('info', 'Reconnected, resuming scramble attempt');
        this.schedule(1000, () => this.sendScrambleAttempt());
      }

      // Vanilla-client mimicry: re-send ClientSettings with randomized values
      // (mineflayer already sends defaults; this overrides them to look like a real client)
      this.schedule(randomInt(300, 900), () => {
        if (!this.bot?._client) return;
        try {
          this.bot._client.write('settings', {
            locale: randomLocale(),
            viewDistance: randomInt(2, 12),
            chatFlags: 0,
            chatColors: Math.random() > 0.08,
            skinParts: randomInt(0, 127),
            mainHand: Math.random() > 0.15 ? 1 : 0,
            enableTextFiltering: false,
            enableServerListing: true,
            particleStatus: weightedParticle(),
          });
        } catch (_) {}
      });
    });

    bot.once('spawn', () => {
      this._joinedAt = Date.now();

      // Start chunk tracker (render distance 2, hash-based change detection)
      this.chunkTracker = new ChunkTracker(bot, this.stats);
      this.chunkTracker.start();

      // Vanilla-client: send player_loaded once chunks are ready (1.21.2+)
      this.schedule(randomInt(1000, 3000), () => {
        if (!this.bot?._client) return;
        try { this.bot._client.write('player_loaded', {}); } catch (_) {}
      });

      setTimeout(() => this.parseScoreboard(), 3000);
    });

    bot.on('resourcePack', () => {
      this.stats.recordLog('info', 'Resource pack requested');
      if (config.bot.acceptResourcePack && typeof bot.acceptResourcePack === 'function') {
        bot.acceptResourcePack();
        this.stats.recordResourcePackAccepted();
        this.stats.recordLog('info', 'Resource pack accepted');
      }
    });

    bot.on('actionBar', (message) => {
      this.handleActionBar(message);
    });

    bot.on('message', (jsonMessage, position) => {
      const text = jsonMessage?.toString?.() ?? String(jsonMessage ?? '');
      if (!text) return;

      if (position === 'game_info' || position === 2) {
        this.handleActionBar(text);
        return;
      }

      if (text.includes('Welcome to the Lobby') || text.includes('Teleporting you to lobby') || text.includes('Welcome to the ManaCube Lobby')) {
        this.stats.recordLog('warn', 'Lobby routing detected. Scheduling automatic recovery to Hardcore...');
        this.scheduleStartupCommands();
      }

      // Private mode: show messages from the target + system messages + bot's own PMs
      if (this._privateTarget) {
        const parsed = parseMessageSenderAndContent(text);
        const isTarget = parsed && parsed.username.toLowerCase() === this._privateTarget.toLowerCase();
        const isOwn = parsed && parsed.username === 'You';
        if (isTarget || isOwn || !parsed) {
          this.stats.recordMessage(text);
          this.processMessage(text);
          this.handlePrompt(text).catch((err) => this.stats.recordLog('error', `handlePrompt error: ${err.message}`));
        }
        return;
      }

      this.stats.recordMessage(text);
      this.processMessage(text);
      this.handlePrompt(text).catch((err) => this.stats.recordLog('error', `handlePrompt error: ${err.message}`));
    });

    bot.on('kicked', (reason) => {
      const cleanReason = stringifyReason(reason);
      if (isProtocolError(cleanReason)) {
        this.stats.recordLog('error', 'Protocol Error while Connecting!');
        this.intentionalLeave = true;
        return;
      }
      this.stats.recordLog('warn', 'Kicked from server', cleanReason);
      this.triggerGracefulReconnect(`Kicked: ${cleanReason}`);
    });

    bot.on('end', (reason) => {
      if (this.chunkTracker) { this.chunkTracker.stop(); this.chunkTracker = null; }
      this.clearTimers();
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.bot = null;
      this.stats.clearMicrosoftAuthCode();
      this.stats.setConnection({
        connected: false,
        connecting: false,
        leftAt: new Date().toISOString(),
      });
      const cleanReason = stringifyReason(reason);
      if (isProtocolError(cleanReason)) {
        this.stats.recordLog('error', 'Protocol Error while Connecting!');
        this.intentionalLeave = true;
        return;
      }
      this.stats.recordLog('info', 'Connection ended', reason ?? null);
      this.triggerGracefulReconnect(`Connection ended: ${reason}`);
    });

    bot.on('error', (error) => {
      this.stats.setConnection({
        connecting: false,
        lastError: error.message,
      });
      this.stats.recordLog('error', error.message);
    });

    bot.on('playerJoined', () => {
      this.updatePlayerList();
    });

    bot.on('playerLeft', () => {
      this.updatePlayerList();
    });

    bot.on('scoreboardPosition', () => {
      this.parseScoreboard();
    });

    bot.on('scoreboardCreated', () => {
      this.parseScoreboard();
    });

    bot.on('scoreUpdated', () => {
      this.parseScoreboard();
    });

    bot.on('teamCreated', () => {
      this.parseScoreboard();
    });

    bot.on('teamUpdated', () => {
      this.parseScoreboard();
    });

    bot.on('teamMemberAdded', () => {
      this.parseScoreboard();
    });

    // Detect unsolicited GUI openings (could be ban message, captcha, etc.)
    bot.on('windowOpen', (window) => {
      if (Date.now() - this._lastCommandTime > 5000) {
        this.stats.recordLog('error', `Inventory opened unexpectedly — possible ban screen or captcha!`);
        try {
          const slots = (window.slots || []).map((s, i) => s ? { slot: i, name: s.name, count: s.count } : null).filter(Boolean);
          this.stats.recordLog('warn', `Inventory contents`, JSON.stringify(slots));
        } catch (_) {}
      }
    });

    setInterval(() => {
      this.updatePlayerList();
      this.parseScoreboard();

      // Poll position to detect unsolicited teleports
      if (this.bot?.entity?.position) {
        const pos = this.bot.entity.position;
        if (this._lastPosition) {
          const dx = pos.x - this._lastPosition.x;
          const dz = pos.z - this._lastPosition.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > 3 && Date.now() - this._lastCommandTime > 5000) {
            this.stats.recordLog('warn', `Teleported without command — moved ${Math.round(dist)} blocks horizontally`);
          }
        }
        this._lastPosition = { x: pos.x, y: pos.y, z: pos.z };
      }
    }, 5000);

    this.heartbeatTimer = setInterval(() => {
      if (!this.bot || !this.stats.snapshot().connected) return;
      const idle = Date.now() - this.lastPromptAt;
      if (idle > HEARTBEAT_IDLE_MS && this.lastPromptAt > 0) {
        this.stats.recordLog('warn', `No prompts for ${Math.round(idle / 60000)} minutes`);
      }
    }, 60000);
  }

  updatePlayerList() {
    if (!this.bot) return;
    const players = Object.keys(this.bot.players || {})
      .filter(name => !/^:.+:$/.test(name))
      .sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(players) !== JSON.stringify(this.lastPlayerList)) {
      this.lastPlayerList = players;
      this.stats.setOnlinePlayers(players);
    }
  }

  parseScoreboard() {
    if (!this.bot) return;
    try {
      // Approach 1: sidebar scoreboard items with team display names
      const sb = this.bot.scoreboard?.sidebar;
      if (sb?.items?.length) {
        const entries = [];
        for (const item of sb.items) {
          const team = this.bot.teamMap?.[item.name];
          let displayName;
          if (team) {
            displayName = team.displayName(item.name).toString();
          } else {
            displayName = item.displayName?.toString?.() ?? String(item.displayName ?? item.name ?? '');
          }
          const cleanName = displayName.replace(/§[0-9a-fk-or]/g, '').trim();
          if (!cleanName) continue;

          const parsed = parseScoreboardLine(cleanName, item.value);
          if (parsed) entries.push(parsed);
        }
        if (entries.length) {
          this.stats.setScoreboard(entries);
          this._scoreboardEmptyLogged = false;
          return;
        }
      }

      // Approach 2: teams as scoreboard lines (ManaCube-style)
      const entries = [];
      const sortKeys = {};
      for (const [teamName, team] of Object.entries(this.bot.teams ?? {})) {
        if (!teamName.startsWith('TAB-SB-')) continue;
        const prefix = team.prefix?.toString?.() ?? String(team.prefix ?? '');
        const suffix = team.suffix?.toString?.() ?? String(team.suffix ?? '');
        const fullLine = (prefix + suffix).replace(/§[0-9a-fk-or]/g, '').trim();
        if (!fullLine) continue;
        const parsed = parseScoreboardLine(fullLine, 0);
        if (parsed) entries.push(parsed);
        const pos = parseInt(teamName.split('-').pop(), 10);
        sortKeys[parsed.label] = Number.isFinite(pos) ? pos : 0;
      }
      entries.sort((a, b) => (sortKeys[a.label] ?? 0) - (sortKeys[b.label] ?? 0));
      if (entries.length) {
        const seen = new Set();
        const deduped = entries.filter(e => {
          const k = e.label + '|' + e.value;
          return seen.has(k) ? false : seen.add(k);
        });
        this.stats.setScoreboard(deduped);
        this._scoreboardEmptyLogged = false;
        return;
      }

      // No data from either source
      if (!this._scoreboardEmptyLogged) {
        this._scoreboardEmptyLogged = true;
        this.stats.recordLog('info', 'Scoreboard empty');
      }
      if (process.env.DEBUG_SCOREBOARD) {
        console.log('[Scoreboard raw]', JSON.stringify(this.getRawScoreboard()));
      }
      this.stats.setScoreboard([]);
    } catch (err) {
      this.stats.recordLog('warn', 'Scoreboard parse error', String(err));
    }
  }

  scheduleStartupCommands() {
    this.schedule(config.bot.hardcoreDelayMs, () => this.runHardcore());
    this.schedule(config.bot.warpAfkDelayMs, () => this.runWarpAfk());
    this.scheduleAfkSwing();
  }

  scheduleAfkSwing() {
    const runSwing = () => {
      if (this.bot && this.stats.snapshot().connected) {
        this.bot.swingArm();
        this.schedule(300000, runSwing);
      }
    };
    this.schedule(300000, runSwing);
  }

  handleActionBar(message) {
    const text = message?.toString?.() ?? String(message ?? '');
    if (text) {
      this.stats.recordActionBar(text);
    }
  }

  processMessage(text) {
    this.sendToDiscordWebhook(text);

    // Chat logging — append every player message to chat.log
    const clean = text.replace(/§[0-9a-fk-or]/g, '');
    const parsed = parseMessageSenderAndContent(clean);
    if (parsed) {
      try { fs.appendFileSync(CHAT_LOG_PATH, `[${new Date().toISOString()}] ${parsed.username}: ${parsed.content}\n`); } catch (_) {}
    }

    if (this.activeScramble) {
      const clean = text.replace(/§[0-9a-fk-or]/g, '');
      const isMyWin = clean.includes('From Console to me: Congratulations') ||
                      clean.includes('Congratulations, you won the Scrambler');
      const isOtherWin = /unscrambled (?:the|this) word/i.test(clean) ||
                         /won the Scrambler/i.test(clean);

      if (isMyWin) {
        this.stats.recordLog('info', 'Scramble round WON!');
        this.stats.recordWin();
        if (this.activeScramble) {
          this.solver.recordWin(this.activeScramble.scrambled, this.activeScramble.candidates[this.activeScramble.currentIndex]);
        }
        this.activeScramble = null;
      } else if (isOtherWin) {
        this.stats.recordLog('info', 'Scramble round ended: someone else won');
        if (this.activeScramble) {
          this.solver.recordLoss(this.activeScramble.scrambled, this.activeScramble.candidates[this.activeScramble.currentIndex]);
        }
        this.activeScramble = null;
      }
    }

    const learnedWord = parseNobodyGotScrambler(text);
    if (learnedWord) {
      this.stats.recordLog('info', `Nobody got the scrambler. Learned word: ${learnedWord}`);
      this.solver.addAndSaveWord(learnedWord);
      if (this.activeScramble) {
        this.solver.recordLoss(this.activeScramble.scrambled, this.activeScramble.candidates[this.activeScramble.currentIndex]);
        this.activeScramble = null;
      }
      this._pendingNobodyWord = false;
      return;
    }

    // Handle split "Nobody got the word in time :(" / "The word was X" across two messages
    if (parseNobodyNoWord(text)) {
      this._pendingNobodyWord = true;
      return;
    }

    if (this._pendingNobodyWord) {
      const word = parseTheWordWas(text);
      if (word) {
        this.stats.recordLog('info', `Nobody got the scrambler. Learned word: ${word}`);
        this.solver.addAndSaveWord(word);
        this._pendingNobodyWord = false;
        return;
      }
      this._pendingNobodyWord = false;
    }
  }

  async sendToDiscordWebhook(text) {
    const webhookUrl = config.discordWebhookUrl;
    if (!webhookUrl) return;

    let cleanText = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/§[0-9a-fk-or]/g, '');

    const parsed = parseMessageSenderAndContent(text);
    if (!parsed) return;

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: parsed.content || cleanText,
          username: parsed.username,
          avatar_url: `https://mc-heads.net/avatar/${parsed.username}.png`,
        }),
      });
    } catch (error) {
      console.error('Failed to send Discord Webhook:', error.message);
    }
  }

  isActiveHours() {
    const now = new Date();
    const today = now.toDateString();
    if (today !== this._jitterDate) {
      this._jitterDate = today;
      this._jitteredStart = Math.max(0, ACTIVE_START_HOUR * 60 + randomInt(-ACTIVE_JITTER_MINUTES, ACTIVE_JITTER_MINUTES));
      this._jitteredEnd = Math.min(1440, ACTIVE_END_HOUR * 60 + randomInt(-ACTIVE_JITTER_MINUTES, ACTIVE_JITTER_MINUTES));
      this.stats.recordLog('info', `Day's active window: ${Math.floor(this._jitteredStart/60)}:${String(this._jitteredStart%60).padStart(2,'0')} — ${Math.floor(this._jitteredEnd/60)}:${String(this._jitteredEnd%60).padStart(2,'0')}`);
    }
    const cur = now.getHours() * 60 + now.getMinutes();
    return cur >= this._jitteredStart && cur < this._jitteredEnd;
  }

  async handlePrompt(text) {
    if (!this._answeringEnabled) return;

    const isUserActive = this._lastUserActivity > 0 && Date.now() - this._lastUserActivity < USER_ACTIVE_MS;

    if (!isUserActive) {
      // Active hours check (jittered)
      if (!this.isActiveHours()) return;

      // Join grace period
      if (this._joinedAt && Date.now() - this._joinedAt < randomInt(30, JOIN_GRACE_MAX) * 1000) return;

      // Random break check
      if (this._onBreak) {
        if (Date.now() >= this._breakUntil) {
          this._onBreak = false;
          this._nextBreakAt = Date.now() + randomInt(BREAK_INTERVAL_MIN, BREAK_INTERVAL_MAX) * 60000;
          this.stats.recordLog('info', 'Break ended — resuming');
        } else {
          return;
        }
      } else if (Date.now() >= this._nextBreakAt) {
        const dur = randomInt(BREAK_DURATION_MIN, BREAK_DURATION_MAX) * 60000;
        this._onBreak = true;
        this._breakUntil = Date.now() + dur;
        this.stats.recordLog('info', `Taking a break for ${Math.round(dur/60000)} minutes`);
        return;
      }

      // Prompt fatigue
      if (this._fatigueRemaining > 0) {
        this._fatigueRemaining--;
        this.stats.recordLog('info', `Fatigue: skipping (${this._fatigueRemaining} remaining)`);
        return;
      }
    }

    const now = Date.now();
    if (text === this.lastPrompt && now - this.lastPromptAt < DUPLICATE_WINDOW_MS) {
      this.stats.recordDuplicatePrompt();
      return;
    }

    const result = await this.solver.findAnswer(text);
    if (!result) {
      if (/wins\s+\$?500/i.test(text)) {
        this.stats.recordLog('warn', 'Unrecognized prompt format — server may have changed wording', text);
      }
      return;
    }

    if (result.fallback) {
      this.stats.recordLog('warn', 'Fallback prompt pattern matched — main regex may need updating', text);
    }

    // Length-based skip + anti-detection skip (only when user is not actively present)
    if (!isUserActive) {
      const answerLen = result.answer ? result.answer.length : (result.scrambled ? result.scrambled.length : 5);
      const lenMult = answerLen < 4 ? 0.5 : answerLen > 6 ? 1.5 : 1.0;
      if (randomInt(0, 99) < ANTI_SKIP_RATE * lenMult) {
        this.stats.recordLog('info', `Anti: skipped ${result.kind} prompt (len=${answerLen}, mult=${lenMult})`);
        return;
      }
    }

    this.lastPrompt = text;
    this.lastPromptAt = now;
    this.stats.recordPrompt(result.kind);

    if (result.kind === 'scramble') {
      this.handleScramblePrompt(result);
      return;
    }

    if (!result.answer) {
      this.stats.recordLog('warn', 'No answer found for typing prompt', text);
      return;
    }

    // Sanity: reject non-word typing answers (usernames, symbols, spam)
    if (!this.isValidTypingAnswer(result.answer)) {
      this.stats.recordLog('warn', `Rejected: typing answer "${result.answer}" is not a valid word`, text);
      return;
    }

    // Anti-detection: typo on typing prompts
    let finalAnswer = result.answer;
    let hadTypo = false;
    if (randomInt(0, 99) < ANTI_TYPO_RATE && finalAnswer.length > 3) {
      const pos = randomInt(0, finalAnswer.length - 1);
      const orig = finalAnswer[pos];
      const typoChar = fatFinger(orig);
      if (typoChar !== orig) {
        if (randomInt(0, 99) < ANTI_TYPO_FIX_RATE) {
          // Typo + correction
          const typoAnswer = finalAnswer.slice(0, pos) + typoChar + finalAnswer.slice(pos + 1);
          finalAnswer = typoAnswer;
          hadTypo = true;
          this.stats.recordLog('info', `Anti: typo inserted ('${orig}'→'${typoChar}') — will correct`);
        } else {
          // Just a typo, no correction
          finalAnswer = finalAnswer.slice(0, pos) + typoChar + finalAnswer.slice(pos + 1);
          this.stats.recordLog('info', `Anti: typo inserted in typing answer ('${orig}'→'${typoChar}' at pos ${pos})`);
        }
      }
    }

    // Blocklist filter
    if (this.isBlocked(finalAnswer)) {
      this.stats.recordLog('warn', `Blocked: typing answer "${finalAnswer}" is on the blocklist`);
      return;
    }

    const typingDelay = typeDelay(finalAnswer.length);

    this.stats.recordLog('info', `Answering typing prompt in ${typingDelay}ms`, finalAnswer);
    this.schedule(typingDelay, () => {
      if (!this.bot) return;
      this.bot.chat(finalAnswer);
      this.stats.recordAnswer(result.kind);
      if (!isUserActive) {
        this._consecutiveAnswers++;
        if (this._consecutiveAnswers >= FATIGUE_THRESHOLD) {
          this._fatigueRemaining = randomInt(FATIGUE_SKIP_MIN, FATIGUE_SKIP_MAX);
          this._consecutiveAnswers = 0;
          this.stats.recordLog('info', `Fatigue: will skip next ${this._fatigueRemaining} prompts`);
        }
      }
      // Typo correction: after a short pause, send the correct answer
      if (hadTypo && this.bot) {
        this.schedule(randomInt(800, 2000), () => {
          if (!this.bot) return;
          this.bot.chat(result.answer);
          this.stats.recordLog('info', `Corrected typo: sent '${result.answer}'`);
        });
      }
    });
  }

  handleScramblePrompt(result) {
    let candidates = result.answers;
    if (candidates.length === 0) {
      this.stats.recordUnknownScramble();
      this.stats.recordLog('warn', 'No answers found for scramble prompt', result.scrambled);
      return;
    }

    // Blocklist filter: remove any blocked candidates
    candidates = candidates.filter(w => !this.isBlocked(w));
    if (candidates.length === 0) {
      this.stats.recordLog('warn', `All ${result.answers.length} scramble candidates blocked for "${result.scrambled}"`);
      return;
    }
    result.answers = candidates;

    // Q-table exploration: if top candidate has >=3 attempts with 0 wins, try next
    if (this.solver.shouldExplore(candidates, result.scrambled)) {
      const top = candidates[0];
      const qval = this.solver.getQValue(result.scrambled, top);
      candidates.push(candidates.shift());
      this.stats.recordLog('info', `Q-explore: ${top} has poor history (${Math.round(qval * 100)}%), trying ${candidates[0]} first`);
    }

    // Anti-detection: wrong answer
    let finalCandidates = candidates;
    if (randomInt(0, 99) < ANTI_WRONG_RATE && candidates.length > 1) {
      const wrongIdx = randomInt(1, candidates.length - 1);
      const wrongWord = candidates[wrongIdx];
      finalCandidates = [wrongWord];
      this.stats.recordLog('info', `Anti: intentionally sending wrong scramble answer '${wrongWord}' instead of '${candidates[0]}'`);
    } else if (randomInt(0, 99) < ANTI_TYPO_RATE && candidates[0].length > 3) {
      // Anti-detection: typo in scramble answer
      const word = candidates[0];
      const pos = randomInt(0, word.length - 1);
      const orig = word[pos];
      const typoChar = fatFinger(orig);
      if (typoChar !== orig) {
        finalCandidates = [word.slice(0, pos) + typoChar + word.slice(pos + 1)];
        this.stats.recordLog('info', `Anti: typo in scramble answer ('${orig}'→'${typoChar}' at pos ${pos})`);
      }
    }

    // Truncate candidate list to max retries
    const truncated = finalCandidates.slice(0, ANTI_MAX_RETRIES);
    const scrambleDelay = typeDelay(truncated[0].length);

    this.activeScramble = {
      scrambled: result.scrambled,
      candidates: truncated,
      currentIndex: 0,
      won: false,
      otherPlayerWon: false,
      startTime: Date.now() + scrambleDelay,
    };

    this.stats.recordLog('info', `Answering scramble (1/${truncated.length}): ${truncated[0]} in ${scrambleDelay}ms`);
    this.schedule(scrambleDelay, () => {
      this.sendScrambleAttempt();
    });
  }

  sendScrambleAttempt() {
    if (!this.bot || !this.activeScramble || this.activeScramble.won || this.activeScramble.otherPlayerWon) return;

    const { candidates, currentIndex } = this.activeScramble;
    const answer = candidates[currentIndex];

    if (this.isBlocked(answer)) {
      this.stats.recordLog('warn', `Blocked: scramble attempt "${answer}" is on the blocklist — aborting`);
      this.activeScramble = null;
      return;
    }

    this.bot.chat(answer);
    this.stats.recordAnswer('scramble');
    const _sawUser = this._lastUserActivity > 0 && Date.now() - this._lastUserActivity < USER_ACTIVE_MS;
    if (!_sawUser) {
      this._consecutiveAnswers++;
      if (this._consecutiveAnswers >= FATIGUE_THRESHOLD) {
        this._fatigueRemaining = randomInt(FATIGUE_SKIP_MIN, FATIGUE_SKIP_MAX);
        this._consecutiveAnswers = 0;
        this.stats.recordLog('info', `Fatigue: will skip next ${this._fatigueRemaining} prompts`);
      }
    }
    this.stats.recordLog('info', `Sent scramble attempt (${currentIndex + 1}/${candidates.length}): ${answer}`);

    if (currentIndex + 1 < candidates.length) {
      const interval = randomInt(SCRAMBLE_INTERVAL_MIN, SCRAMBLE_INTERVAL_MAX);
      this.schedule(interval, () => {
        if (!this.activeScramble || this.activeScramble.won || this.activeScramble.otherPlayerWon) return;

        const elapsed = Date.now() - this.activeScramble.startTime;
        if (elapsed >= 7000) {
          this.stats.recordLog('info', 'Scramble timeout: 7s has passed since first attempt');
          this.activeScramble = null;
          return;
        }

        this.activeScramble.currentIndex++;
        this.sendScrambleAttempt();
      });
    } else {
      this.schedule(3000, () => {
        if (this.activeScramble && !this.activeScramble.won) {
          this.activeScramble = null;
        }
      });
    }
  }

  triggerGracefulReconnect(reason) {
    if (this.intentionalLeave) return;
    if (this.reconnectTimeout) return;

    const backoffMs = Math.min(10000 * Math.pow(2, this.reconnectAttempts), 300000);
    this.reconnectAttempts++;

    this.stats.recordLog('warn', `Unexpected disconnect (${reason}). Backing off for ${Math.round(backoffMs / 1000)}s before reconnect...`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.stats.recordLog('info', 'Attempting automatic reconnection...');
      this.join();
    }, backoffMs);
  }

  schedule(delayMs, callback) {
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(timer);
      callback();
    }, delayMs);
    this.scheduledTimers.add(timer);
  }

  clearTimers() {
    for (const timer of this.scheduledTimers) {
      clearTimeout(timer);
    }
    this.scheduledTimers.clear();
    for (const timer of this.scheduledCommandTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledCommandTimers.clear();
  }

  getScheduledCommands() {
    return this._scheduledCommands;
  }

  setScheduledCommands(cmds) {
    this._scheduledCommands = cmds;
    this.restartScheduledCommands();
  }

  scheduleAllUserCommands() {
    for (const timer of this.scheduledCommandTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledCommandTimers.clear();
    for (const cmd of this._scheduledCommands) {
      this.scheduleUserCommand(cmd);
    }
  }

  restartScheduledCommands() {
    for (const timer of this.scheduledCommandTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledCommandTimers.clear();
    if (this.bot && this.stats.snapshot().connected) {
      this.scheduleAllUserCommands();
    }
  }

  scheduleUserCommand(cmd) {
    if (!cmd.command || !cmd.intervalMs) return;
    const run = () => {
      if (!this.bot || !this.stats.snapshot().connected) return;
      this._lastCommandTime = Date.now();
      this.bot.chat(cmd.command);
      this.stats.recordLog('command', cmd.command);
    };
    run();
    const timer = setInterval(run, cmd.intervalMs);
    this.scheduledCommandTimers.set(cmd.command + cmd.intervalMs, timer);
  }

  isBlocked(word) {
    return BLOCKED_WORDS.has(word.toLowerCase());
  }

  isAnsweringEnabled() {
    return this._answeringEnabled;
  }

  setAnsweringEnabled(enabled) {
    this._answeringEnabled = !!enabled;
    return this._answeringEnabled;
  }

  getPrivateTarget() {
    return this._privateTarget;
  }

  isValidTypingAnswer(word) {
    if (!word || word.length < 2 || word.length > 40) return false;
    return /^[a-zA-Z][a-zA-Z\s]*[a-zA-Z]$/.test(word);
  }

  setAntiDetection(opts) {
    if (opts.skipRate !== undefined) ANTI_SKIP_RATE = opts.skipRate;
    if (opts.wrongRate !== undefined) ANTI_WRONG_RATE = opts.wrongRate;
    if (opts.maxRetries !== undefined) ANTI_MAX_RETRIES = opts.maxRetries;
    if (opts.typoRate !== undefined) ANTI_TYPO_RATE = opts.typoRate;
    if (opts.typoFixRate !== undefined) ANTI_TYPO_FIX_RATE = opts.typoFixRate;
    if (opts.activeStartHour !== undefined) ACTIVE_START_HOUR = opts.activeStartHour;
    if (opts.activeEndHour !== undefined) ACTIVE_END_HOUR = opts.activeEndHour;
    if (opts.activeJitterMinutes !== undefined) ACTIVE_JITTER_MINUTES = opts.activeJitterMinutes;
    if (opts.breakIntervalMin !== undefined) BREAK_INTERVAL_MIN = opts.breakIntervalMin;
    if (opts.breakIntervalMax !== undefined) BREAK_INTERVAL_MAX = opts.breakIntervalMax;
    if (opts.breakDurationMin !== undefined) BREAK_DURATION_MIN = opts.breakDurationMin;
    if (opts.breakDurationMax !== undefined) BREAK_DURATION_MAX = opts.breakDurationMax;
    if (opts.joinGraceMax !== undefined) JOIN_GRACE_MAX = opts.joinGraceMax;
    if (opts.fatigueThreshold !== undefined) FATIGUE_THRESHOLD = opts.fatigueThreshold;
    if (opts.fatigueSkipMin !== undefined) FATIGUE_SKIP_MIN = opts.fatigueSkipMin;
    if (opts.fatigueSkipMax !== undefined) FATIGUE_SKIP_MAX = opts.fatigueSkipMax;
    return this.getAntiDetection();
  }

  getAntiDetection() {
    return {
      skipRate: ANTI_SKIP_RATE,
      wrongRate: ANTI_WRONG_RATE,
      maxRetries: ANTI_MAX_RETRIES,
      typoRate: ANTI_TYPO_RATE,
      typoFixRate: ANTI_TYPO_FIX_RATE,
      activeStartHour: ACTIVE_START_HOUR,
      activeEndHour: ACTIVE_END_HOUR,
      activeJitterMinutes: ACTIVE_JITTER_MINUTES,
      breakIntervalMin: BREAK_INTERVAL_MIN,
      breakIntervalMax: BREAK_INTERVAL_MAX,
      breakDurationMin: BREAK_DURATION_MIN,
      breakDurationMax: BREAK_DURATION_MAX,
      joinGraceMax: JOIN_GRACE_MAX,
      fatigueThreshold: FATIGUE_THRESHOLD,
      fatigueSkipMin: FATIGUE_SKIP_MIN,
      fatigueSkipMax: FATIGUE_SKIP_MAX,
    };
  }

  reloadWords() {
    this.solver.reloadWords();
    const s = this.solver.stats;
    this.stats.recordLog('info', `Word list reloaded: ${s.loaded} loaded, ${s.skipped} skipped`);
    return { ok: true, loaded: s.loaded, skipped: s.skipped };
  }

  getRawScoreboard() {
    if (!this.bot) return { error: 'no bot', positions: null, scoreboards: null, teams: null };
    try {
      const pos = this.bot.scoreboard;
      const positions = {};
      for (const key of ['list', 'sidebar', 'belowName']) {
        const sb = pos?.[key];
        if (sb) {
          positions[key] = {
            name: sb.name,
            title: sb.title,
            items: (sb.items || []).map(i => ({
              name: i.name,
              value: i.value,
              displayName: i.displayName?.toString?.() ?? String(i.displayName ?? ''),
            })),
          };
        }
      }
      const scoreboards = {};
      for (const [name, sb] of Object.entries(this.bot.scoreboards ?? {})) {
        scoreboards[name] = {
          title: sb.title,
          items: (sb.items || []).map(i => ({
            name: i.name,
            value: i.value,
            displayName: i.displayName?.toString?.() ?? String(i.displayName ?? ''),
          })),
        };
      }
      const teams = {};
      for (const [teamName, team] of Object.entries(this.bot.teams ?? {})) {
        teams[teamName] = {
          name: team.name?.toString?.() ?? String(team.name ?? ''),
          prefix: team.prefix?.toString?.() ?? '',
          suffix: team.suffix?.toString?.() ?? '',
          members: team.members,
          line: (team.prefix?.toString?.() ?? '') + (team.suffix?.toString?.() ?? ''),
        };
      }
      return { positions, scoreboards, teams };
    } catch (err) {
      return { error: String(err) };
    }
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const QWERTY = new Map([
  ['q',['w','a']],   ['w',['q','e','s']],   ['e',['w','r','d']],
  ['r',['e','t','f']],['t',['r','y','g']],  ['y',['t','u','h']],
  ['u',['y','i','j']],['i',['u','o','k']],  ['o',['i','p','l']],
  ['p',['o']],
  ['a',['q','s','z']],  ['s',['w','a','d','x']],['d',['e','s','f','c']],
  ['f',['r','d','g','v']],['g',['t','f','h','b']],['h',['y','g','j','n']],
  ['j',['u','h','k','m']],['k',['i','j','l']],    ['l',['o','k','p']],
  ['z',['a','x']],  ['x',['s','z','c']],['c',['d','x','v']],
  ['v',['f','c','b']],['b',['g','v','n']],['n',['h','b','m']],
  ['m',['j','n']],
]);

function fatFinger(c) {
  const neighbors = QWERTY.get(c);
  if (!neighbors) return c;
  return neighbors[randomInt(0, neighbors.length - 1)];
}

function typeDelay(charLen) {
  const think = randomInt(2000, 5000);
  const perChar = randomInt(150, 200);
  return think + charLen * perChar;
}

const LOCALES = [
  'en_US', 'en_GB', 'en_AU', 'en_CA', 'es_ES', 'es_MX', 'fr_FR', 'fr_CA',
  'de_DE', 'pt_BR', 'pt_PT', 'it_IT', 'nl_NL', 'pl_PL', 'ru_RU', 'ja_JP',
  'ko_KR', 'zh_CN', 'zh_TW', 'sv_SE', 'no_NO', 'fi_FI', 'da_DK', 'cs_CZ',
  'hu_HU', 'ro_RO', 'vi_VN', 'th_TH', 'tr_TR', 'uk_UA', 'el_GR', 'ar_SA',
];

function randomLocale() {
  return LOCALES[randomInt(0, LOCALES.length - 1)];
}

function weightedParticle() {
  const r = Math.random();
  if (r < 0.75) return 0; // all — default majority of players
  if (r < 0.95) return 1; // decreased
  return 2;               // minimal
}

const PROTOCOL_ERROR_MSGS = [
  'si è verificato un errore interno nella connessione',
  'internal connection error',
];

function isProtocolError(reason) {
  if (!reason || typeof reason !== 'string') return false;
  const lower = reason.toLowerCase();
  return PROTOCOL_ERROR_MSGS.some(msg => lower.includes(msg));
}

function stringifyReason(reason) {
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function parseScoreboardLine(cleanName, score) {
  const parts = cleanName.split(/:+\s*/);
  if (parts.length >= 2) {
    const label = parts[0].replace(/^[^\w\s]+/, '').trim();
    const value = parts.slice(1).join(': ').trim();
    if (label && value) {
      const isMoney = value.startsWith('$');
      return {
        label,
        value,
        score,
        isMoney,
      };
    }
  }

  return {
    label: cleanName,
    value: String(score),
    score,
    isMoney: false,
  };
}
