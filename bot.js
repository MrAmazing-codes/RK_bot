const { default: makeWASocket, DisconnectReason, downloadMediaMessage, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

// ---------- Clear old auth folder ----------
const AUTH_DIR = './auth_info';
if (fs.existsSync(AUTH_DIR)) {
    console.log('🗑️ Removing old auth...');
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

const SAVE_DIR = './saved_media';
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// ---------- Global state ----------
let qrData = null;
let pairingCode = null;
let connected = false;

// ---------- Config ----------
let config = {
    viewStatus: true,
    saveViewOnce: true,
    saveDeleted: true,
    alwaysOnline: true
};
let deletedCache = new Map();

// ---------- Express server ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/qr', (req, res) => {
    res.json({ qr: qrData });
});
app.get('/pairing', (req, res) => {
    res.json({ code: pairingCode });
});
app.get('/status', (req, res) => {
    res.json({ connected });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; }
                #qr img { border: 5px solid black; max-width: 100%; }
                #pairing { font-size: 40px; letter-spacing: 5px; font-weight: bold; }
            </style>
            <script>
                async function update() {
                    try {
                        const qrResp = await fetch('/qr');
                        const qrData = await qrResp.json();
                        const qrDiv = document.getElementById('qr');
                        if (qrData.qr) {
                            const img = document.createElement('img');
                            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qrData.qr);
                            qrDiv.innerHTML = '';
                            qrDiv.appendChild(img);
                        } else {
                            qrDiv.innerHTML = '<p>⏳ Waiting for QR...</p>';
                        }

                        const pairResp = await fetch('/pairing');
                        const pairData = await pairResp.json();
                        const pairDiv = document.getElementById('pairing');
                        if (pairData.code) {
                            pairDiv.innerHTML = '🔑 ' + pairData.code;
                        } else {
                            pairDiv.innerHTML = '⏳ Generating pairing code...';
                        }

                        const statResp = await fetch('/status');
                        const stat = await statResp.json();
                        document.getElementById('status').innerText = stat.connected ? '✅ Connected! Send !config' : '⏳ Not connected yet...';
                    } catch(e) { }
                }
                setInterval(update, 3000);
                update();
            </script>
        </head>
        <body>
            <h1>🤖 WhatsApp Bot</h1>
            <div id="qr"><p>⏳ Loading QR...</p></div>
            <hr>
            <h2>🔑 Pairing Code</h2>
            <div id="pairing">⏳ Loading...</div>
            <hr>
            <div id="status">⏳ Connecting...</div>
            <p><small>If QR doesn't appear, use the pairing code above in WhatsApp → Linked Devices → Link with phone number.</small></p>
        </body>
        </html>
    `);
});

app.listen(PORT, () => console.log(`✅ Web server on port ${PORT}`));

// ---------- Bot ----------
async function startBot() {
    console.log('🔧 Initializing WhatsApp bot...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['Cloud Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrData = qr;
            console.log('📱 QR code generated!');
            console.log(qr);
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                setTimeout(startBot, 3000);
            } else {
                console.log('❌ Logged out.');
            }
        } else if (connection === 'open') {
            connected = true;
            console.log('✅ Bot connected! Send !config to see toggles.');
        }
    });

    // Request pairing code after 5 seconds
    setTimeout(async () => {
        try {
            console.log('📱 Requesting pairing code...');
            const code = await sock.requestPairingCode('255761600360');
            pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 Pairing code: ${pairingCode}`);
        } catch (e) {
            console.log('❌ Pairing request failed:', e.message);
        }
    }, 5000);

    // ---- Message handlers (same as before) ----
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.id) deletedCache.set(msg.key.id, msg);

        if (msg.key.remoteJid === 'status@broadcast' && config.viewStatus) {
            await sock.readMessages([msg.key]);
            console.log('✅ Viewed status');
        }

        if (msg.message?.viewOnceMessage) {
            const vm = msg.message.viewOnceMessage;
            const media = vm.message?.imageMessage || vm.message?.videoMessage;
            if (media && config.saveViewOnce) {
                try {
                    const buf = await downloadMediaMessage(msg, 'buffer', {});
                    if (buf) {
                        const ext = media.mimetype.split('/')[1] || 'bin';
                        const fname = `viewonce_${Date.now()}.${ext}`;
                        const fpath = path.join(SAVE_DIR, fname);
                        fs.writeFileSync(fpath, buf);
                        console.log(`💾 Saved view-once: ${fname}`);
                        await sock.sendMessage(msg.key.remoteJid, { text: '📸 View-once saved.' });
                    }
                } catch (e) { console.log('❌ Save view-once error:', e.message); }
            }
        }

        if (msg.key.fromMe) {
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const cmd = text.toLowerCase().trim();
            if (cmd === '!status on') { config.viewStatus = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Status ON' }); }
            if (cmd === '!status off') { config.viewStatus = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Status OFF' }); }
            if (cmd === '!delete on') { config.saveDeleted = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Delete logging ON' }); }
            if (cmd === '!delete off') { config.saveDeleted = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Delete logging OFF' }); }
            if (cmd === '!viewonce on') { config.saveViewOnce = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ View-once saving ON' }); }
            if (cmd === '!viewonce off') { config.saveViewOnce = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ View-once saving OFF' }); }
            if (cmd === '!online on') { config.alwaysOnline = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Always-online ON' }); }
            if (cmd === '!online off') { config.alwaysOnline = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Always-online OFF' }); }
            if (cmd === '!config') {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `📋 Config:\n- Status: ${config.viewStatus}\n- Delete Log: ${config.saveDeleted}\n- ViewOnce: ${config.saveViewOnce}\n- Online: ${config.alwaysOnline}`
                });
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const u of updates) {
            if (u.update?.message?.protocolMessage?.type === 'revoke') {
                const key = u.key;
                const revoked = deletedCache.get(key.id);
                if (revoked && config.saveDeleted) {
                    const log = `[${new Date().toISOString()}] Deleted: ${revoked.message?.conversation || '[Media]'}\n`;
                    fs.appendFileSync(path.join(SAVE_DIR, 'deleted_log.txt'), log);
                    console.log('🗑️ Deleted logged');
                }
                deletedCache.delete(key.id);
            }
        }
    });

    setInterval(() => {
        if (config.alwaysOnline) sock.sendPresenceUpdate('available').catch(() => {});
    }, 15000);

    sock.ev.on('creds.update', saveCreds);
}

startBot().catch(err => {
    console.error('❌ Bot crashed:', err);
});
