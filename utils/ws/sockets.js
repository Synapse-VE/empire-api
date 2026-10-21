const { XMLParser } = require('fast-xml-parser');
const { GgeSocket } = require('./ggeSocket');
const { E4kSocket } = require('./e4kSocket');

function envList(name, fallback) {
    return String(process.env[name] || fallback || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function wantedZones() {
    return envList('GGE_ZONES', process.env.GGE_ZONE || 'EmpireEx_25');
}

function allServersEnabled() {
    return envBool('GGE_ALL_SERVERS', false) || wantedZones().includes('*');
}

function credentials() {
    const username = process.env.GGE_USERNAME;
    const password = process.env.GGE_PASSWORD;
    if (!username || !password) {
        throw new Error('GGE_USERNAME and GGE_PASSWORD are required');
    }
    return { username, password };
}

async function getGgeSockets() {
    const wanted = wantedZones();
    const allServers = allServersEnabled();
    const { username, password } = credentials();
    const sockets = {};

    // EN: Optional fixed URL: skips the network XML lookup. Useful when the
    //     player only needs one known server (HIS1 / EmpireEx_25). In
    //     all-servers mode the XML lookup is required.
    // ES: URL fija opcional: evita buscar en los XML de red. Util cuando
    //     solo se necesita un servidor conocido (HIS1 / EmpireEx_25). En
    //     modo todos-los-servidores se usa la busqueda por XML.
    const serverUrl = allServers ? '' : String(process.env.GGE_SERVER_URL || '').trim();
    if (serverUrl) {
        for (const zone of wanted) {
            sockets[zone] = new GgeSocket(
                serverUrl,
                zone,
                username,
                password,
                Number(process.env.GGE_NETWORK_ID || 0)
            );
        }
        return sockets;
    }

    const networkIds = envList('GGE_NETWORK_IDS', '1,5,11,26,34,39,64,65,68')
        .map(Number)
        .filter(Number.isFinite);

    for (const networkId of networkIds) {
        let response;
        try {
            response = await fetch(
                `https://media.goodgamestudios.com/games-config/network/12/live/${networkId}.xml`,
                { signal: AbortSignal.timeout(60 * 1000) }
            );
        } catch (error) {
            console.log(`### network ${networkId} config failed: ${error.message} ###`);
            continue;
        }
        if (!response.ok) {
            console.log(`### network ${networkId} config HTTP ${response.status} ###`);
            continue;
        }

        const data = new XMLParser().parse(await response.text());
        if (!data?.network?.instances?.instance) continue;

        const instances = Array.isArray(data.network.instances.instance)
            ? data.network.instances.instance
            : [data.network.instances.instance];

        for (const server of instances) {
            if (!allServers && !wanted.includes(server.zone)) continue;
            sockets[server.zone] = new GgeSocket(
                `wss://${server.server}:443`,
                server.zone,
                username,
                password,
                networkId
            );
        }
    }

    if (Object.keys(sockets).length === 0) {
        console.log(`### no socket found for zone(s): ${wanted.join(', ')} ###`);
    }
    return sockets;
}

async function getE4kSockets() {
    // EN: E4K is disabled by default; HIS1 only needs the GGE socket.
    // ES: E4K queda desactivado por defecto; HIS1 solo necesita el socket GGE.
    if (!envBool('GGE_E4K', false)) return {};

    const wanted = wantedZones();
    const allServers = allServersEnabled();
    const { username, password } = credentials();
    const sockets = {};
    const networkIds = envList('GGE_E4K_NETWORK_IDS', '72,77')
        .map(Number)
        .filter(Number.isFinite);

    for (const networkId of networkIds) {
        let response;
        try {
            response = await fetch(
                `https://media.goodgamestudios.com/games-config/network/16/live/${networkId}.xml`,
                { signal: AbortSignal.timeout(60 * 1000) }
            );
        } catch (error) {
            console.log(`### E4K network ${networkId} config failed: ${error.message} ###`);
            continue;
        }
        if (!response.ok) {
            console.log(`### E4K network ${networkId} config HTTP ${response.status} ###`);
            continue;
        }

        const data = new XMLParser().parse(await response.text());
        if (!data?.network?.instances?.instance) continue;

        const instances = Array.isArray(data.network.instances.instance)
            ? data.network.instances.instance
            : [data.network.instances.instance];

        for (const server of instances) {
            if (!allServers && !wanted.includes(server.zone)) continue;
            sockets[server.zone] = new E4kSocket(
                `tcp://${server.server}:443`,
                server.zone,
                username,
                password
            );
        }
    }
    return sockets;
}

async function getSockets() {
    return { ...(await getGgeSockets()), ...(await getE4kSockets()) };
}

function connectSockets(sockets) {
    for (const socket of Object.values(sockets)) {
        socket.connect();
    }
}

function restartSockets(sockets) {
    for (const socket of Object.values(sockets)) {
        socket.restart();
    }
}

module.exports = {
    getSockets,
    connectSockets,
    restartSockets,
    wantedZones,
};
