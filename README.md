# MINIRUNNER

Headless Node.js chat-race bot for ManaCube with a WebUI control panel.

**Minecraft 1.21.11, Node >=20, mineflayer ^4.29.0**

## Setup

```sh
npm install
npm start
```

Server starts on `http://localhost:3694`. Open it, click Join, and complete the Microsoft device-code login in your browser. Session is cached after that.

## WebUI

Catppuccin Mocha themed. Tabs: Players, Chat, Logs, Config. KB shortcuts Ctrl+1-4, Ctrl+Enter to send. Config panel lets you tune anti-detection live.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Full state snapshot (players, chats, logs, memory, mana history) |
| GET | `/api/config` | Current config |
| POST | `/api/config` | Update config |
| GET | `/api/scoreboard` | Parsed scoreboard entries |
| GET | `/api/raw-scoreboard` | Raw scoreboard JSON |
| GET | `/api/private-mode` | Private messaging target |
| GET | `/api/auth` | Auth status |
| POST | `/api/send` | Send a chat message |
| POST | `/api/join` | Join server |
| POST | `/api/leave` | Leave server |
| POST | `/api/hardcore` | Hardcore mode |
| POST | `/api/warp-afk` | Warp to AFK |
| POST | `/api/reset` | Reset stats |
| POST | `/api/reload-words` | Reload word list |
| POST | `/api/gc` | Trigger garbage collection |
| POST | `/api/longterm` | Long-term stats |

## Env (all optional, sensible defaults)

| Variable | Default |
|----------|---------|
| `MC_USERNAME` | *from config* |
| `MC_AUTH` | microsoft |
| `MC_HOST` | play.manacube.com |
| `MC_VERSION` | 1.21.11 |
| `WEB_HOST` | 0.0.0.0 |
| `WEB_PORT` | 3694 |
| `AUTO_JOIN` | false |
