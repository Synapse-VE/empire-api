const { BaseWsSocket } = require('./baseWsSocket');
const { BaseTcpSocket } = require('./baseTcpSocket');
const { Event } = require('../event');

class GgeSocket {
    constructor(url, serverHeader, username, password, networkId) {
        this.url = url;
        this.serverHeader = serverHeader;
        this.username = username;
        this.password = password;
        this.networkId = networkId;
        this.connected = new Event();
        this.reconnect = true;
        this.socket = null;
        this.cooldownTimer = null;
    }

    _lliPayload() {
        return {
            CONM: 175,
            RTM: 24,
            ID: 0,
            PL: 1,
            NOM: this.username,
            PW: this.password,
            LT: null,
            LANG: process.env.GGE_LANG || 'fr',
            DID: process.env.GGE_DID || '0',
            AID: process.env.GGE_AID || '1674256959939529708',
            KID: '',
            REF: 'https://empire.goodgamestudios.com',
            GCI: '',
            SID: 9,
            PLFID: 1,
        };
    }

    async connect() {
        this.reconnect = true;
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = null;
        }
        try {
            if (this.url.startsWith('ws')) {
                this.socket = new BaseWsSocket(this.url, this.serverHeader);
            } else {
                this.socket = new BaseTcpSocket(this.url, this.serverHeader);
            }

            this.socket.onError = (error) => {
                console.log(`### error in socket ${this.serverHeader} ###`);
                console.log(error.message);
                if (['ENOTFOUND', 'ETIMEDOUT'].includes(error.code)) {
                    this.disconnect(false);
                } else {
                    this.disconnect(true);
                }
            };

            this.socket.onClose = (code, reason) => {
                console.log(`### socket ${this.serverHeader} closed${this.reconnect ? '' : ' permanently'} ###`);
                if (this.reconnect) {
                    this.disconnect(true);
                    setTimeout(() => this.connect(), 10 * 1000);
                } else {
                    this.disconnect(false);
                }
            };

            if (!(await this.socket.opened.wait(60000))) throw new Error('Socket not connected');
            console.log(`### socket ${this.serverHeader} connected ###`);

            const apiOkPromise = this.socket.waitForXmlResponse('sys', 'apiOK', '0');
            this.socket.sendXmlMessage('sys', 'verChk', '0', "<ver v='166' />");
            await apiOkPromise;

            const responseAsync = this.socket.waitForJsonResponse('nfo');
            this.socket.sendXmlMessage(
                'sys',
                'login',
                '0',
                `<login z='${this.serverHeader}'><nick><![CDATA[]]></nick><pword><![CDATA[1065004%fr%0]]></pword></login>`
            );
            const nfoResponse = await responseAsync;
            this.socket.raiseForStatus(nfoResponse);

            const joinOkPromise = this.socket.waitForXmlResponse('sys', 'joinOK', '1');
            this.socket.sendXmlMessage('sys', 'autoJoin', '-1', '');
            await joinOkPromise;

            const roundTripPromise = this.socket.waitForXmlResponse('sys', 'roundTripRes', '1');
            this.socket.sendXmlMessage('sys', 'roundTrip', '1', '');
            await roundTripPromise;

            const lliPromise = this.socket.waitForJsonResponse('lli');
            this.socket.sendJsonCommand('lli', this._lliPayload());
            const lliResponse = await lliPromise;

            if (lliResponse.payload.status === 0) {
                this.connected.set();
                this.ping();
                await this.checkConnection();
            } else if (lliResponse.payload.status === 453) {
                const cooldown = (lliResponse.payload.data?.CD || 60) * 1000;
                console.log(
                    `### socket ${this.serverHeader} rate limited, retrying in ${cooldown / 1000}s ###`
                );
                this.socket.onClose = () => {};
                this.socket.onError = () => {};
                this.socket.close();
                this.cooldownTimer = setTimeout(() => {
                    this.cooldownTimer = null;
                    this.connect();
                }, cooldown);
                return;
            } else if (lliResponse.payload.status === 21) {
                // EN: Auto-registration is intentionally disabled. The account
                //     must already exist on this zone (HIS1 / EmpireEx_25).
                // ES: El registro automatico esta desactivado a proposito. La
                //     cuenta debe existir en esta zona (HIS1 / EmpireEx_25).
                console.log(
                    `### socket ${this.serverHeader}: account not registered; auto-registration disabled ###`
                );
                this.disconnect(false);
            } else {
                console.log(
                    `### socket ${this.serverHeader}: login failed with status ${lliResponse.payload.status} ###`
                );
                this.disconnect(false);
            }
        } catch (error) {
            console.log(`### error connecting to socket ${this.serverHeader} ###`);
            console.log(error.message);
            this.disconnect(false);
        }
    }

    disconnect(reconnect = true) {
        this.connected.clear();
        this.reconnect = reconnect;
        if (this.socket) this.socket.close();
        if (!reconnect) this.socket = null;
    }

    async restart() {
        this.disconnect(false);
        this.reconnect = true;
        await this.connect();
    }

    async ping() {
        if (!this.connected.isSet || !this.socket) return;
        try {
            this.socket.sendRawCommand('pin', ['<RoundHouseKick>']);
        } catch (error) {
            this.disconnect(true);
            return;
        }
        setTimeout(() => this.ping(), 30 * 1000);
    }

    async checkConnection() {
        if (!this.connected.isSet || !this.socket) return;
        try {
            const gpiPromise = this.socket.waitForJsonResponse('gpi');
            this.socket.sendJsonCommand('gpi', {});
            await gpiPromise;
            setTimeout(() => this.checkConnection(), 15 * 60 * 1000);
        } catch (error) {
            this.disconnect(true);
        }
    }

    sendRaw(frame) {
        if (!this.connected.isSet || !this.socket) {
            throw new Error('Socket not connected');
        }
        this.socket.sendRaw(frame);
    }

    sendJsonCommand(command, data) {
        if (!this.connected.isSet || !this.socket) {
            throw new Error('Socket not connected');
        }
        this.socket.sendJsonCommand(command, data);
    }

    waitForJsonResponse(command, data, timeout) {
        if (!this.socket) throw new Error('Socket not connected');
        return this.socket.waitForJsonResponse(command, data, timeout);
    }
}

module.exports = { GgeSocket };
