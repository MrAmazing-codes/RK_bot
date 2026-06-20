const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const SAVE_DIR = './saved_media';
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

let config = {
    viewStatus: true,
    saveViewOnce: true,
    saveDeleted: true,
    alwaysOnline: true
};
let deletedCache = new Map();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['Cloud Bot', 'Chrome', '1.0.0'],
        pairingCode: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, pairingCode, lastDisconnect } = update;
        if (pairingCode) {
            console.log(`\n🔑 PAIRING CODE: ${pairingCode}\n`);
            console.log('Open WhatsApp → Linked Devices → Link a Device → enter this code.\n');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(shouldReconnect ? '🔄 Reconnecting...' : '❌ Logged out.');
            if (shouldReconnect) setTimeout(startBot, 5000);
        } else if (connection === 'open') {
            console.log('✅ Bot connected! Send !config to see toggles.');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.id) deletedCache.set(msg.key.id, msg);

        if (msg.key.remoteJid === 'status@broadcast' && config.viewStatus) {
            await sock.readMessages([msg.key]);
            console.log('✅ Viewed a status');
        }

        if (msg.message?.viewOnceMessage) {
            const viewOnce = msg.message.viewOnceMessage;
            const mediaMsg = viewOnce.message?.imageMessage || viewOnce.message?.videoMessage;
            if (mediaMsg && config.saveViewOnce) {
                try {
                    const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    if (mediaBuffer) {
                        const ext = mediaMsg.mimetype.split('/')[1] || 'bin';
                        const filename = `viewonce_${Date.now()}.${ext}`;
                        const filepath = path.join(SAVE_DIR, filename);
                        fs.writeFileSync(filepath, mediaBuffer);
                        console.log(`💾 Saved view‑once: ${filename}`);
                        await sock.sendMessage(msg.key.remoteJid, { text: '📸 View‑once saved.' });
                    }
                } catch (e) { console.log('❌ Failed to save view‑once:', e.message); }
            }
        }

        if (msg.key.fromMe) {
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const cmd = text.toLowerCase().trim();
            if (cmd === '!status on') { config.viewStatus = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Status viewing ON.' }); }
            if (cmd === '!status off') { config.viewStatus = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Status viewing OFF.' }); }
            if (cmd === '!delete on') { config.saveDeleted = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Delete logging ON.' }); }
            if (cmd === '!delete off') { config.saveDeleted = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Delete logging OFF.' }); }
            if (cmd === '!viewonce on') { config.saveViewOnce = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ View‑once saving ON.' }); }
            if (cmd === '!viewonce off') { config.saveViewOnce = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ View‑once saving OFF.' }); }
            if (cmd === '!online on') { config.alwaysOnline = true; await sock.sendMessage(msg.key.remoteJid, { text: '✅ Always‑online ON.' }); }
            if (cmd === '!online off') { config.alwaysOnline = false; await sock.sendMessage(msg.key.remoteJid, { text: '❌ Always‑online OFF.' }); }
            if (cmd === '!config') {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `📋 Config:\n- Status: ${config.viewStatus}\n- Delete Log: ${config.saveDeleted}\n- ViewOnce: ${config.saveViewOnce}\n- Online: ${config.alwaysOnline}`
                });
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message?.protocolMessage?.type === 'revoke') {
                const key = update.key;
                const revoked = deletedCache.get(key.id);
                if (revoked && config.saveDeleted) {
                    const log = `[${new Date().toISOString()}] Deleted by ${key.participant || key.remoteJid}: ${revoked.message?.conversation || '[Media/Sticker]'}\n`;
                    const logPath = path.join(SAVE_DIR, 'deleted_log.txt');
                    fs.appendFileSync(logPath, log);
                    console.log('🗑️ Deleted message logged.');
                }
                deletedCache.delete(key.id);
            }
        }
    });

    setInterval(() => {
        if (config.alwaysOnline) {
            sock.sendPresenceUpdate('available').catch(() => {});
        }
    }, 15000);

    sock.ev.on('creds.update', saveCreds);
}

startBot().catch(err => console.error('Failed to start:', err));
