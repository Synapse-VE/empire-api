const express = require('express');
const commands = require('./data/commands.json');
const { setNestedValue } = require('./utils/nestedHeaders');

const SECRET = String(process.env.API_PATH_SECRET || '').trim();
const API_KEY = String(process.env.API_KEY || '').trim();
const TIMEOUT = Number(process.env.GGE_RESPONSE_TIMEOUT_MS || 10000);
const CONFIGURED_ZONES = String(process.env.GGE_ZONES || process.env.GGE_ZONE || 'EmpireEx_25')
    .split(',')
    .map((zone) => zone.trim())
    .filter(Boolean);

// EN: Some commands are answered by the game under a different command.
// ES: Algunos comandos son respondidos por el juego con otro nombre.
const ANSWERED_AS = { jca: 'jaa' };

function expectedCommand(command) {
    return ANSWERED_AS[command] || command;
}

function parseHeaders(raw) {
    if (raw === undefined || raw === null) return {};
    let text = String(raw).trim();
    if (!text || text === 'null') return {};
    if (!text.startsWith('{')) text = `{${text}}`;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('headers must be a JSON object');
    }
    return parsed;
}

function buildConditions(command, headers) {
    const conditions = {};
    if (command in commands) {
        for (const [messageKey, responsePath] of Object.entries(commands[command])) {
            if (messageKey in headers) {
                setNestedValue(conditions, responsePath, headers[messageKey]);
            }
        }
    } else {
        for (const [key, value] of Object.entries(headers)) {
            conditions[key] = value;
        }
    }
    return conditions;
}

async function sendCommand(socket, command, headers) {
    const conditions = buildConditions(command, headers);
    const expected = expectedCommand(command);
    // EN: Register the waiter before sending so a fast answer is not lost.
    // ES: Registrar el waiter antes de enviar para no perder una respuesta rapida.
    const responsePromise = socket.socket.waitForJsonResponse(expected, conditions, TIMEOUT);
    socket.socket.sendJsonCommand(command, headers);
    return await responsePromise;
}

function statusPayload(sockets) {
    const status = {};
    for (const [server, socket] of Object.entries(sockets)) {
        status[server] = Boolean(socket?.connected?.isSet);
    }
    for (const zone of CONFIGURED_ZONES) {
        if (!(zone in status)) status[zone] = false;
    }
    if (SECRET) {
        status[SECRET] = Object.values(status).some(Boolean);
    }
    return status;
}

function commandFromFrame(frame) {
    if (!frame.startsWith('%xt%')) return null;
    const parts = frame.split('%').filter(Boolean);
    if (parts.length < 2) return null;
    const index = String(parts[1]).startsWith('EmpireEx_') ? 2 : 1;
    return parts[index] || null;
}

function sendError(res, error, server, command) {
    const message = error?.message || String(error);
    if (/Timeout/i.test(message)) {
        return res.status(504).json({ error: 'Timeout', server, command });
    }
    if (/not connected/i.test(message)) {
        return res.status(503).json({ error: 'Server not connected', server, command });
    }
    return res.status(400).json({ error: message || 'Invalid command or headers', server, command });
}

module.exports = function (sockets) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,POST');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
        next();
    });

    app.get('/', (req, res) => res.status(200).send('API running'));

    app.get('/status', (req, res) => {
        res.status(200).json(statusPayload(sockets));
    });

    app.get('/ready', (req, res) => {
        const status = statusPayload(sockets);
        const ready = Object.values(status).some(Boolean);
        res.status(ready ? 200 : 503).json({ ready, status });
    });

    // EN: Optional secret-path auth. Requests must start with
    //     /<API_PATH_SECRET>/EmpireEx_25/...; clients that can send headers
    //     may use X-API-Key instead. With neither configured, the API is
    //     open (local/private Docker only).
    // ES: Auth opcional por path secreto. Los requests deben empezar con
    //     /<API_PATH_SECRET>/EmpireEx_25/...; los clientes que puedan mandar
    //     headers pueden usar X-API-Key. Sin ninguno configurado, la API
    //     queda abierta (solo Docker local/privado).
    app.use((req, res, next) => {
        let secretOk = false;
        if (SECRET) {
            const prefix = `/${SECRET}`;
            if (req.path === prefix || req.path.startsWith(`${prefix}/`)) {
                secretOk = true;
                req.url = req.url.slice(prefix.length) || '/';
            }
        }
        req.secretOk = secretOk;
        if (secretOk) return next();
        if (API_KEY && req.get('X-API-Key') === API_KEY) return next();
        if (!SECRET && !API_KEY) return next();
        if (SECRET) return res.status(404).json({ error: 'Not found' });
        return res.status(401).json({ error: 'Unauthorized' });
    });

    // EN: CORS proxy for GGS XML/translations. Kept for compatibility.
    // ES: Proxy CORS para XML/traducciones de GGS. Se mantiene por compatibilidad.
    app.get('/proxy', async (req, res) => {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'Missing url query param' });
        }
        const allowed = [
            'https://media.goodgamestudios.com/',
            'https://empire-html5.goodgamestudios.com/',
            'https://translations-api-test.public.ggs-ep.com/',
            'https://raw.githubusercontent.com/',
        ];
        if (!allowed.some((prefix) => url.startsWith(prefix))) {
            return res.status(403).json({ error: 'Domain not allowed' });
        }
        try {
            if (String(process.env.GGE_DEBUG || '') === '1') {
                console.log(`proxy -> ${url}`);
            }
            const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            const body = await upstream.text();
            res.header('Content-Type', upstream.headers.get('content-type') || 'text/plain');
            res.status(upstream.status).send(body);
        } catch (err) {
            console.log(`proxy FAILED: ${err.message}`);
            res.status(502).json({ error: err.message });
        }
    });

    // EN: Raw frame endpoint for arbitrary game-generated commands.
    // ES: Endpoint de frames crudos para comandos arbitrarios del juego.
    app.post('/:server/raw', async (req, res) => {
        const server = req.params.server;
        const frame = req.body?.frame || req.body?.raw;
        if (typeof frame !== 'string' || !frame.trim()) {
            return res.status(400).json({ error: 'Missing frame' });
        }
        const socket = sockets[server];
        if (!socket) return res.status(404).json({ error: 'Server not found' });
        if (!socket.connected?.isSet || !socket.socket) {
            return res.status(503).json({ error: 'Server not connected' });
        }

        const command = commandFromFrame(frame);
        const expected = command ? expectedCommand(command) : null;
        try {
            const responsePromise = expected
                ? socket.socket.waitForJsonResponse(expected, false, TIMEOUT)
                : socket.socket.waitForAnyResponse(TIMEOUT);
            socket.socket.sendRaw(frame);
            const response = await responsePromise;
            if (command) {
                return res.status(200).json({
                    server,
                    command,
                    return_code: response.payload.status,
                    content: response.payload.data,
                });
            }
            return res.status(200).json({ server, response: response.payload ?? response });
        } catch (error) {
            return sendError(res, error, server, command);
        }
    });

    // EN: JSON command with the headers in the body (large payloads / POST).
    // ES: Comando JSON con headers en el body (payloads grandes / POST).
    app.post('/:server/:command', async (req, res) => {
        const server = req.params.server;
        const command = req.params.command;
        const socket = sockets[server];
        if (!socket) return res.status(404).json({ error: 'Server not found' });
        if (!socket.connected?.isSet || !socket.socket) {
            return res.status(503).json({ error: 'Server not connected' });
        }
        const body = req.body?.headers && typeof req.body.headers === 'object' ? req.body.headers : req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'headers must be a JSON object' });
        }
        try {
            const response = await sendCommand(socket, command, body);
            return res.status(200).json({
                server,
                command,
                return_code: response.payload.status,
                content: response.payload.data,
            });
        } catch (error) {
            return sendError(res, error, server, command);
        }
    });

    // EN: Tracker-compatible endpoint: /<server>/<command>/<headers>.
    //     headers is JSON without the outer braces; "null" means {}.
    // ES: Endpoint compatible con el tracker: /<server>/<command>/<headers>.
    //     headers es JSON sin las llaves externas; "null" significa {}.
    app.get('/:server/:command/:headers?', async (req, res) => {
        const server = req.params.server;
        const command = req.params.command;
        const socket = sockets[server];
        if (!socket) return res.status(404).json({ error: 'Server not found' });
        if (!socket.connected?.isSet || !socket.socket) {
            return res.status(503).json({ error: 'Server not connected' });
        }

        let headers;
        try {
            headers = parseHeaders(req.params.headers);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        try {
            const response = await sendCommand(socket, command, headers);
            return res.status(200).json({
                server,
                command,
                return_code: response.payload.status,
                content: response.payload.data,
            });
        } catch (error) {
            return sendError(res, error, server, command);
        }
    });

    app.use((err, req, res, next) => {
        if (err?.type === 'entity.parse.failed') {
            return res.status(400).json({ error: 'Invalid JSON body' });
        }
        return next(err);
    });

    return app;
};