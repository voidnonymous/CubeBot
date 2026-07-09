import http from 'node:http';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

function acceptsEncoding(headers, encoding) {
  const ae = (headers?.['accept-encoding'] || '').toLowerCase();
  return ae.includes(encoding);
}

function compressResponse(response, status, contentType, body) {
  const acceptGzip = acceptsEncoding(response.req?.headers, 'gzip');
  const acceptBr = acceptsEncoding(response.req?.headers, 'br');

  if (acceptBr && body.length > 512) {
    zlib.brotliCompress(body, (err, compressed) => {
      if (err || compressed.length >= body.length) {
        response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      } else {
        response.writeHead(status, { 'content-type': contentType, 'content-encoding': 'br', 'cache-control': 'no-store' });
        response.end(compressed);
      }
    });
  } else if (acceptGzip && body.length > 512) {
    zlib.gzip(body, (err, compressed) => {
      if (err || compressed.length >= body.length) {
        response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      } else {
        response.writeHead(status, { 'content-type': contentType, 'content-encoding': 'gzip', 'cache-control': 'no-store' });
        response.end(compressed);
      }
    });
  } else {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  }
}

export function createServer({ stats, botController }) {
  // Periodic GC every 30 minutes
  setInterval(() => {
    if (typeof global.gc === 'function') {
      global.gc();
      console.log('[GC] Periodic garbage collection completed');
    }
  }, 1800000);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === 'GET' && url.pathname === '/') {
        return sendFile(response, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
      }

      if (request.method === 'GET' && url.pathname === '/api/stats') {
        const snap = stats.snapshot();
        const mem = process.memoryUsage();
        snap.memory = {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        };
        snap.chunks = botController.chunkTracker ? botController.chunkTracker.getStats() : { chunksTracked: 0, changed: 0 };
        return sendJson(response, 200, snap);
      }

      if (request.method === 'POST' && url.pathname === '/api/gc') {
        if (typeof global.gc === 'function') {
          global.gc();
          const mem = process.memoryUsage();
          return sendJson(response, 200, {
            ok: true,
            message: 'GC triggered',
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          });
        }
        return sendJson(response, 200, { ok: false, message: 'GC not available (--expose-gc missing)' });
      }

      if (request.method === 'GET' && url.pathname === '/api/auth') {
        return sendJson(response, 200, stats.snapshot().microsoftAuth);
      }

      if (request.method === 'GET' && url.pathname === '/api/scoreboard') {
        return sendJson(response, 200, stats.getScoreboard());
      }

      if (request.method === 'GET' && url.pathname === '/api/players') {
        return sendJson(response, 200, stats.snapshot().onlinePlayers);
      }

      if (request.method === 'GET' && url.pathname === '/api/longterm') {
        return sendJson(response, 200, stats.snapshot().longTerm);
      }

      if (request.method === 'POST' && url.pathname === '/api/join') {
        return sendJson(response, 200, botController.join());
      }

      if (request.method === 'POST' && url.pathname === '/api/leave') {
        return sendJson(response, 200, botController.leave());
      }

      if (request.method === 'POST' && url.pathname === '/api/reset') {
        stats.resetCounters();
        return sendJson(response, 200, { ok: true, message: 'Stats reset.' });
      }

      if (request.method === 'POST' && url.pathname === '/api/hardcore') {
        return sendJson(response, 200, botController.runHardcore());
      }

      if (request.method === 'POST' && url.pathname === '/api/warp-afk') {
        return sendJson(response, 200, botController.runWarpAfk());
      }

      if (request.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(response, 200, {
          host: config.bot.host,
          port: config.bot.port,
          version: config.bot.version,
          username: config.bot.username,
          auth: config.bot.auth,
          acceptResourcePack: config.bot.acceptResourcePack,
          hardcoreDelayMs: config.bot.hardcoreDelayMs,
          warpAfkDelayMs: config.bot.warpAfkDelayMs,
          discordWebhookUrl: config.discordWebhookUrl,
          scheduledCommands: botController.getScheduledCommands(),
          antiDetection: botController.getAntiDetection(),
          answeringEnabled: botController.isAnsweringEnabled(),
          privateTarget: botController.getPrivateTarget(),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/config') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        try {
          const data = JSON.parse(body);
          const updates = {};
          const botKeys = ['host', 'port', 'version', 'username', 'auth', 'acceptResourcePack', 'hardcoreDelayMs', 'warpAfkDelayMs'];
          for (const k of botKeys) {
            if (data[k] !== undefined) config.bot[k] = data[k];
          }
          if (data.discordWebhookUrl !== undefined) {
            updates.discordWebhookUrl = data.discordWebhookUrl;
          }
          if (Object.keys(updates).length) config.saveLocalConfig(updates);
          if (data.scheduledCommands) {
            botController.setScheduledCommands(data.scheduledCommands);
          }
          if (data.antiDetection) {
            botController.setAntiDetection(data.antiDetection);
          }
          if (data.answeringEnabled !== undefined) {
            botController.setAnsweringEnabled(data.answeringEnabled);
          }
          return sendJson(response, 200, { ok: true, message: 'Configuration saved.' });
        } catch {
          return sendJson(response, 400, { ok: false, message: 'Invalid payload.' });
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/send') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        try {
          const { message } = JSON.parse(body);
          if (message) {
            return sendJson(response, 200, botController.sendUserCommand(message));
          }
        } catch {
          return sendJson(response, 400, { ok: false, message: 'Invalid payload.' });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/raw-scoreboard') {
        return sendJson(response, 200, botController.getRawScoreboard());
      }

      if (request.method === 'POST' && url.pathname === '/api/reload-words') {
        return sendJson(response, 200, botController.reloadWords());
      }

      if (request.method === 'GET' && url.pathname === '/api/private-mode') {
        return sendJson(response, 200, { target: botController.getPrivateTarget() });
      }

      return sendJson(response, 404, { ok: false, message: 'Not found.' });
    } catch (error) {
      return sendJson(response, 500, { ok: false, message: error.message });
    }
  });
}

export function listen(server) {
  server.listen(config.web.port, config.web.host, () => {
    console.log(`MINIRUNNER web server listening on http://${config.web.host}:${config.web.port}`);
  });
}

async function sendFile(response, filePath, contentType) {
  const body = await readFile(filePath);
  compressResponse(response, 200, contentType, body);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  compressResponse(response, status, 'application/json; charset=utf-8', body);
}
