# MINIRUNNER

Standalone headless Node.js Minecraft runner for `play.manacube.com`.

## Setup

```sh
cd MINIRUNNER
npm install
npm start
```

After clicking Join, the web UI shows the Microsoft device-code URL and code while login is waiting. Complete that once and mineflayer caches the session.

## Environment

```sh
MC_USERNAME=you@example.com
MC_AUTH=microsoft
PROFILES_FOLDER=.minecraft-auth
MC_HOST=play.manacube.com
MC_VERSION=1.21.11
WEB_HOST=0.0.0.0
WEB_PORT=3694
WORD_LIST_PATH=../src/main/resources/chatrace_words.txt
```

Defaults are already set for ManaCube, Minecraft `1.21.11`, and the bundled word list from the parent mod.

## Web UI / API

Open:

```txt
http://127.0.0.1:3694/
```

Endpoints:

- `GET /api/stats`
- `GET /api/auth`
- `POST /api/join`
- `POST /api/leave`
- `POST /api/reset`
- `POST /api/hardcore`
- `POST /api/warp-afk`
