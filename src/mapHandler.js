import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OLLAMA_URL = 'http://192.168.68.74:11434/api/generate';
const OLLAMA_MODEL = 'gemma4:e2b';

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

function indexToRGB(index) {
  if (index < 0 || index > 255) return [0, 0, 0];
  const cid = Math.floor(index / 4);
  const shade = index % 4;
  const base = BASE_COLORS[cid];
  if (!base) return [0, 0, 0];
  const m = SHADE_MULTS[shade];
  return [Math.floor(base[0] * m / 255), Math.floor(base[1] * m / 255), Math.floor(base[2] * m / 255)];
}

function toTimestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `map-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}.png`;
}

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

function createPNG(width, height, rgba) {
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

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export class MapHandler {
  constructor(bot, logFn) {
    this.bot = bot;
    this.log = logFn;
    this.mapData = new Map();
    this._lastMapIds = new Set();
    this._pollTimer = null;

    bot._client.on('map', (packet) => {
      if (packet.columns > 0 && packet.rows > 0 && packet.data) {
        this.mapData.set(packet.itemDamage, packet);
      }
    });

    this._pollTimer = setInterval(() => this.pollMap(), 2000);
  }

  pollMap() {
    if (!this.bot?.inventory) return;
    const items = this.bot.inventory.items();
    const currentIds = new Set();

    for (const item of items) {
      if (item.name !== 'filled_map') continue;
      let mapId = null;

      if (item.componentMap?.has('map_id')) {
        mapId = item.componentMap.get('map_id').data;
      } else if (item.metadata != null && item.metadata > 0) {
        mapId = item.metadata;
      }

      if (mapId == null) continue;
      currentIds.add(mapId);

      if (!this._lastMapIds.has(mapId) && this.mapData.has(mapId)) {
        this.handleMap(mapId);
      }
    }

    this._lastMapIds = currentIds;
  }

  async handleMap(mapId) {
    const packet = this.mapData.get(mapId);
    if (!packet) return;

    const id = packet.itemDamage;
    const cols = packet.columns;
    const rows = packet.rows;
    const buf = packet.data;

    const pixels = Buffer.alloc(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      const [r, g, b] = indexToRGB(buf[i]);
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }

    const png = createPNG(cols, rows, pixels);
    const filename = toTimestampName();
    const filepath = path.resolve(process.cwd(), filename);
    fs.writeFileSync(filepath, png);

    this.log('info', `Map #${id} saved as ${filename}`);

    try {
      await this.equipMap(mapId);
      const text = await this.askOllama(png);
      if (text) {
        this.log('info', `Ollama returned: "${text}"`);
        this.bot.chat(text);
        this.log('info', `Sent CAPTCHA response: ${text}`);
      }
    } catch (err) {
      this.log('error', `Map #${id} handler failed: ${err.message}`);
    }
  }

  async equipMap(mapId) {
    const items = this.bot.inventory.items();
    for (const item of items) {
      if (item.name !== 'filled_map') continue;
      let id = item.componentMap?.get('map_id')?.data ?? item.metadata;
      if (id === mapId) {
        try {
          await this.bot.equip(item, 'hand');
          this.log('info', `Equipped map #${mapId}`);
        } catch (err) {
          this.log('warn', `Could not equip map #${mapId}: ${err.message}`);
        }
        return;
      }
    }
  }

  async askOllama(pngBuf) {
    const b64 = pngBuf.toString('base64');
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'Extract the text from this image. Return ONLY the text, nothing else, no explanation.',
        images: [b64],
        stream: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return (data.response || '').trim();
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.mapData.clear();
  }
}
