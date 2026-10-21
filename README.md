# empire-api — HIS1 bridge

Fork of [danadum/empire-api](https://github.com/danadum/empire-api) adapted for
**HIS1 / `EmpireEx_25`** and for the `gge-tracker` scrapers.

EN: Lightweight Express + `ws` bridge designed for **one game zone** by
default (`EmpireEx_25`), keeping the socket alive and exposing the game
commands as an HTTP API. No Chrome, no GUI. Auto-registration is disabled.
All-server mode is opt-in (`GGE_ALL_SERVERS=1`).

ES: Puente liviano Express + `ws` disenado para **una sola zona** del juego
por defecto (`EmpireEx_25`), manteniendo el socket vivo y exponiendo los
comandos como API HTTP. Sin Chrome, sin GUI. El registro automatico esta
desactivado. El modo todos-los-servidores es opt-in (`GGE_ALL_SERVERS=1`).

## Requirements

- Node.js 22+ (the Dockerfile uses `node:22-alpine`).
- Network access to `media.goodgamestudios.com` and the game WebSocket.
- A test/dedicated account that already exists on `EmpireEx_25` (or the selected zones).

## Environment

```env
GGE_USERNAME=...
GGE_PASSWORD=...
GGE_ZONE=EmpireEx_25
GGE_ALL_SERVERS=0
GGE_LANG=fr
API_PATH_SECRET=long-random-secret
GGE_RESPONSE_TIMEOUT_MS=10000
GGE_E4K=0
PORT=3000
```

See `.env.example` for the full list. `GGE_SERVER_URL` is optional and skips
the network XML lookup. `GGE_DEBUG=1` logs frames with `PW`/tokens redacted.

## Single server vs all servers

**Default: one server.** `GGE_ZONE=EmpireEx_25` and `GGE_ALL_SERVERS=0` make
the bridge log in only to HIS1. That is the recommended mode: one account, one
socket, no multi-server rate-limit surprises.

**All GGE servers (opt-in).** Set:

```env
GGE_ALL_SERVERS=1
# GGE_ZONES=*     # equivalent, all zones from the network XMLs
# GGE_E4K=1       # also include Empire: Four Kingdoms, optional
# GGE_SERVER_URL must be empty in this mode
```

Then restart the API. It fetches every network XML, creates one socket per GGE
zone and connects all of them. `/status` returns every connected zone, and the
tracker uses `/<secret>/<zone>/...` as usual.

**Back to one server:** set `GGE_ALL_SERVERS=0`, keep
`GGE_ZONE=EmpireEx_25`, restart.

> All-server mode logs the same account into every server. Use a dedicated
> account, expect rate limits, and remember auto-registration is disabled: a
> zone where the account does not exist is logged out instead of registered.

## Run

```sh
npm install
npm start
```

Or:

```sh
docker build -t empire-api-his1 .
docker run --rm -p 3000:3000 --env-file .env empire-api-his1
```

## Endpoints

With `API_PATH_SECRET=secret`, command requests look like:

```text
GET  /secret/EmpireEx_25/gpi/null
GET  /secret/EmpireEx_25/hgh/"LT":1,"LID":1,"SV":"1"
GET  /secret/EmpireEx_25/gdi/"PID":123
GET  /secret/EmpireEx_25/gaa/"KID":1,"AX1":0,"AY1":0,"AX2":12,"AY2":12
POST /secret/EmpireEx_25/raw       { "frame": "%xt%EmpireEx_25%..." }
```

- `headers` is JSON **without** the outer braces; `null`/empty means `{}`.
- Response: `{"server":"EmpireEx_25","command":"...","return_code":0,"content":...}`.
- `POST /secret/EmpireEx_25/<command>` accepts the headers as a JSON body.
- `POST /secret/EmpireEx_25/raw` sends a raw game frame (`%xt%...%` or `<msg...>`)
  and waits for the response. This is intentionally powerful: protect it.
- `GET /status` is public and returns `{ "EmpireEx_25": true, "<secret>": true }`.
- `GET /ready` returns 200 only when the socket is connected.
- `X-API-Key` is accepted as an alternative to the secret path when `API_KEY`
  is configured.

The tracker uses `GET /<zone>/<command>/<headers>` and `/status`; set its
`GGE_API_URL*` variables to:

```env
GGE_API_URL=https://host/<secret>
GGE_API_URL_REALTIME=https://host/<secret>
GGE_API_URL_RANKINGS=https://host/<secret>
```

The tracker will build `https://host/<secret>/EmpireEx_25/...`. The
`/status` alias keeps its zone health check working.

## Render

- Deploy as a **Docker** web service, plan Free.
- Set `GGE_USERNAME`, `GGE_PASSWORD`, `GGE_ZONE=EmpireEx_25` and
  `API_PATH_SECRET` in the dashboard (never commit them).
- Health check: `/status` (returns 200 while the socket logs in).
- Free services sleep after inactivity; use an external cron ping to `/status`
  every 10 minutes if you need it awake (750 h/month).
- Cold start reconnects/logs in; the tracker already polls `/status`.

`render.yaml` contains a minimal blueprint.

## Security / limits

- **Any command is allowed**, including actions such as `ksc`. This is not a
  read-only API; use a dedicated account and a strong secret.
- No auto-registration: a status `21` (account not on that zone) logs out.
- **reCAPTCHA is only part of the registration flow.** Login does not use it
  and auto-registration is disabled. Datacenter WAF/anti-bot blocking may
  still happen; if Render is blocked, run this bridge on a residential
  machine and expose it through a tunnel.
- Do not run this bridge and Chrome with the same account at the same time
  without testing: one session may kick the other.
- Logs redact `PW`/tokens; keep `GGE_DEBUG=0` in production.

## License / credits

Based on [danadum/empire-api](https://github.com/danadum/empire-api).
Use it on your own account and at your own risk.
