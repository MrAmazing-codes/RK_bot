const { default: makeWASocket, DisconnectReason, downloadMediaMessage, useSingleFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const express = require('express');

// Use SINGLE file auth (more reliable)
const AUTH_FILE = './auth_info.json';
if (fs.existsSync(AUTH_FILE)) {
    console.log('🗑️ Removing old auth...');
    fs.unlinkSync(AUTH_FILE);
}

const SAVE_DIR = './saved_media';
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

let config = {
    viewStatus: true,
    saveViewOnce: true,
    saveDeleted: true,
    alwaysOnline: true
};
let deletedCache = new Map();
let qrCode = null;
let pairingCode = null;

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    let html = '<h1>🔗 Connect WhatsApp</h1>';
    if (qrCode) {
        const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCode)}`;
        html += `<h2>📱 Scan this QR:</h2><img src="${qrImage}" style="border:5px solid black;"/>`;
    }
    if (pairingCode) {
        html += `<h2>🔑 Or use code:</h2><h3 style="font-size:40px;letter-spacing:5px;">${pairingCode}</h3>`;
        html += `<p>WhatsApp → Linked Devices → Link with phone number</p>`;
    }
    res.send(html);
});

app.listen(PORT, () => console.log(`✅ Web server on port ${PORT}`));

async function startBot() {
    console.log('🔧 Initializing bot...');
    const { state, saveCreds } = useSingleFileAuthState(AUTH_FILE);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['Cloud Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCode = qr;
            console.log('📱 QR generated');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startBot, 3000);
            else console.log('❌ Logged out.');
        } else if (connection === 'open') {
            console.log('✅ Bot connected! Send !config');
        }
    });

    // Request pairing code
    setTimeout(async () => {
        try {
            const code = await sock.requestPairingCode('255761600360');
            pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 Pairing code: ${pairingCode}`);
        } catch (e) { console.log('❌ Pairing failed:', e.message); }
    }, 5000);

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
                        console.log(`💾 Saved: ${fname}`);
                        await sock.sendMessage(msg.key.remoteJid, { text: '📸 View-once saved.' });
                    }
                } catch (e) {}
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

startBot().catch(err => console.error('Failed:', err));
