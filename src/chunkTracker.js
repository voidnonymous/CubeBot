function fnv1a(buf) {
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export class ChunkTracker {
  constructor(bot, stats) {
    this.bot = bot;
    this.stats = stats;
    this.hashes = new Map();
    this.changedKeys = new Set();
    this._onChunk = null;
  }

  start() {
    if (this.bot._client) {
      this.bot.settings.renderDistance = 2;
      this.bot._client.write('settings', {
        locale: this.bot.settings.locale || 'en_US',
        viewDistance: 2,
        chatFlags: this.bot.settings.chatFlags ?? 0,
        chatColors: this.bot.settings.chatColors !== false,
        skinParts: this.bot.settings.skinParts ?? 0,
        mainHand: this.bot.settings.mainHand ?? 1,
        enableTextFiltering: !!this.bot.settings.enableTextFiltering,
        enableServerListing: this.bot.settings.enableServerListing !== false,
        particleStatus: this.bot.settings.particleStatus ?? 0,
      });
      this.stats.recordLog('info', 'ChunkTracker: render distance set to 2');
    }

    this._onChunk = (x, z) => {
      setImmediate(() => {
        try {
          const col = this.bot.world.getColumn(x, z);
          if (!col || typeof col.dump !== 'function') return;
          const buf = col.dump();
          const hash = fnv1a(buf);
          const key = `${x},${z}`;
          const prev = this.hashes.get(key);
          if (prev && prev !== hash) {
            this.changedKeys.add(key);
            this.stats.recordLog('warn', `Chunk ${key} changed — possible block activity`);
          }
          this.hashes.set(key, hash);
        } catch (err) {
          this.stats.recordLog('warn', `ChunkTracker error on chunk [${x}, ${z}]: ${err.message}`);
        }
      });
    };

    this.bot.on('chunkLoad', this._onChunk);
  }

  stop() {
    if (this._onChunk) {
      this.bot.removeListener('chunkLoad', this._onChunk);
      this._onChunk = null;
    }
    this.hashes.clear();
    this.changedKeys.clear();
  }

  getChangedKeys() {
    const keys = [...this.changedKeys];
    this.changedKeys.clear();
    return keys;
  }

  getStats() {
    return {
      chunksTracked: this.hashes.size,
      changed: this.changedKeys.size,
    };
  }
}
