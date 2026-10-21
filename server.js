require('node:dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

const { getSockets, restartSockets } = require('./utils/ws/sockets');

async function main() {
    // EN: Start the HTTP API before the game login so Render's health check
    //     and the tracker's /status polling work during cold starts.
    // ES: Arrancar la API HTTP antes del login del juego para que el health
    //     check de Render y el polling de /status funcionen en cold starts.
    const sockets = {};
    const app = require('./app')(sockets);
    const PORT = process.env.PORT ?? 3000;
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`API running on port ${PORT}`);
    });

    let refreshing = false;

    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        try {
            const next = await getSockets();
            for (const [zone, socket] of Object.entries(next)) {
                if (!(zone in sockets) || sockets[zone].socket === null) {
                    sockets[zone] = socket;
                    socket.connect();
                    console.log(`### connecting ${zone} ###`);
                }
            }
            if (Object.keys(sockets).length === 0) {
                console.log('### no sockets configured yet; retrying in 10 minutes ###');
            }
        } catch (error) {
            console.log(`### socket refresh failed: ${error.message} ###`);
        } finally {
            refreshing = false;
        }
    }

    await refresh();
    setInterval(refresh, 10 * 60 * 1000);

    setInterval(() => {
        const zones = Object.keys(sockets);
        if (!zones.length) return;
        if (Object.values(sockets).some((socket) => socket.socket === null)) {
            console.log('### a socket is down; restarting process ###');
            process.exit(1);
        }
        restartSockets(sockets);
    }, 24 * 60 * 60 * 1000);

    function shutdown(signal) {
        console.log(`### received ${signal}; shutting down ###`);
        for (const socket of Object.values(sockets)) {
            try {
                socket.disconnect(false);
            } catch (error) {
                // Ignore shutdown errors.
            }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
