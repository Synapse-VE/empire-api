const { Event } = require('../event');
const { compareNestedHeaders } = require('../nestedHeaders');

function debugEnabled() {
    return String(process.env.GGE_DEBUG || '').trim() === '1';
}

function redact(value) {
    return String(value)
        .replace(/("PW"\s*:\s*")[^"]*(")/gi, '$1***$2')
        .replace(/("RCT"\s*:\s*")[^"]*(")/gi, '$1***$2')
        .replace(/("token"\s*:\s*")[^"]*(")/gi, '$1***$2')
        .replace(/("access_token"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

class BaseSocket {
    constructor(serverHeader, onSend = null, onOpen = null, onMessage = null, onError = null, onClose = null) {
        this.serverHeader = serverHeader;
        this.onSend = onSend;
        this.onOpen = onOpen;
        this.onMessage = onMessage;
        this.onError = onError;
        this.onClose = onClose;
        this.opened = new Event();
        this.closed = new Event();
        this.messages = [];
    }

    _onOpen() {
        this.opened.set();
        if (this.onOpen) this.onOpen();
    }

    async _onMessage(message) {
        let response;
        try {
            response = await this.parseResponse(message);
        } catch (error) {
            if (debugEnabled()) console.log(`Unparseable message: ${redact(message).slice(0, 500)}`);
            return;
        }
        this._processResponse(response);
        if (this.onMessage) this.onMessage(message);
    }

    _onError(error) {
        if (this.onError) this.onError(error);
    }

    _onClose(code, reason) {
        this.opened.clear();
        this.closed.set();
        if (this.onClose) this.onClose(code, reason);
    }

    _send(data) {
        throw new Error('_send() must be implemented by subclass');
    }

    close() {
        throw new Error('close() must be implemented by subclass');
    }

    send(data) {
        if (this.onSend) this.onSend(data);
        if (debugEnabled()) {
            console.log(`Sending data: ${redact(data).slice(0, 2000)}`);
        }
        this._send(data);
    }

    sendRaw(data) {
        this.send(data);
    }

    _sendCommandMessage(data) {
        this.send(`%${data.join('%')}%`);
    }

    sendRawCommand(command, data) {
        this._sendCommandMessage(['xt', this.serverHeader, command, '1', ...data]);
    }

    sendJsonCommand(command, data) {
        this._sendCommandMessage(['xt', this.serverHeader, command, '1', JSON.stringify(data)]);
    }

    sendXmlMessage(t, action, r, data) {
        this.send(`<msg t='${t}'><body action='${action}' r='${r}'>${data}</body></msg>`);
    }

    async _waitForResponse(type, conditions, timeout = 5000) {
        const event = new Event();
        const message = { type, conditions, response: null, event };
        this.messages.push(message);
        const result = await event.wait(timeout);
        this.messages = this.messages.filter((msg) => msg !== message);
        if (!result) throw new Error('Timeout waiting for response');
        return message.response;
    }

    waitForJsonResponse(command, data = false, timeout = 5000) {
        return this._waitForResponse('json', { command, data }, timeout);
    }

    waitForXmlResponse(t, action, r, timeout = 5000) {
        return this._waitForResponse('xml', { t, action, r }, timeout);
    }

    waitForAnyResponse(timeout = 5000) {
        return this._waitForResponse('any', {}, timeout);
    }

    raiseForStatus(response, expectedStatus = 0) {
        if (response.type === 'json' && response.payload.status !== expectedStatus) {
            throw new Error(`Unexpected status: ${response.payload.status}`);
        }
    }

    async parseResponse(response) {
        if (response.startsWith('<')) {
            const parsed = /<msg t='(.*?)'><body action='(.*?)' r='(.*?)'>(.*?)<\/body><\/msg>/.exec(response);
            if (!parsed) {
                return { type: 'raw', payload: { raw: response } };
            }
            return {
                type: 'xml',
                payload: {
                    t: parsed[1],
                    action: parsed[2],
                    r: parsed[3],
                    data: parsed[4],
                },
            };
        }

        const parsed = response.split('%').filter(Boolean);
        const payload = {
            command: parsed[1],
            status: +parsed[3],
            data: parsed.length > 4 ? parsed.slice(4).join('%') : null,
        };
        if (payload.data && payload.data.startsWith('{')) {
            try {
                payload.data = JSON.parse(payload.data);
            } catch (error) {
                // Keep the raw string if the payload is not valid JSON.
            }
        }
        return { type: 'json', payload };
    }

    _matches(message, response) {
        if (message.type === 'any') return false;
        if (response.type === 'json' && message.type === 'json') {
            return (
                message.conditions.command === response.payload.command &&
                (message.conditions.data === false ||
                    (message.conditions.data === true && response.payload.data !== null) ||
                    message.conditions.data === response.payload.data ||
                    (typeof response.payload.data === 'object' &&
                        typeof message.conditions.data === 'object' &&
                        compareNestedHeaders(message.conditions.data, response.payload.data)))
            );
        }
        if (response.type === 'xml' && message.type === 'xml') {
            return (
                message.conditions.t === response.payload.t &&
                message.conditions.action === response.payload.action &&
                message.conditions.r === response.payload.r
            );
        }
        return false;
    }

    _findMessage(response) {
        const exact = this.messages.find((message) => this._matches(message, response));
        if (exact) return exact;

        // EN: GGE responses do not always echo the request parameters. For a
        //     command with no exact match, resolve the oldest waiter for the
        //     same command (FIFO). This keeps gaa/ksc/gpi working.
        // ES: Las respuestas de GGE no siempre repiten los parametros del
        //     request. Si no hay match exacto, resolvemos el waiter mas viejo
        //     del mismo comando (FIFO). Asi funcionan gaa/ksc/gpi.
        return this.messages.find((message) => {
            if (message.type === 'any') return true;
            if (response.type === 'json' && message.type === 'json') {
                return message.conditions.command === response.payload.command;
            }
            if (response.type === 'xml' && message.type === 'xml') {
                return (
                    message.conditions.t === response.payload.t &&
                    message.conditions.action === response.payload.action
                );
            }
            return false;
        });
    }

    _processResponse(response) {
        const message = this._findMessage(response);
        if (!message) return;
        if (debugEnabled()) {
            const command =
                response.type === 'json'
                    ? `${response.payload.command} status=${response.payload.status}`
                    : `${response.payload.t}/${response.payload.action}`;
            console.log(`Response: ${command}`);
        }
        message.response = response;
        message.event.set();
    }
}

module.exports = { BaseSocket };
