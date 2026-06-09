require('dotenv').config();
const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    delay, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState 
} = require('@whiskeysockets/baileys');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const app = express();
app.use(express.json());

const GATEWAY_AUTH_TOKEN = process.env.GATEWAY_AUTH_TOKEN;
const PERSONAL_NUMBER = process.env.PERSONAL_NUMBER; // Format: E.164 without '+' (e.g., 254XXXXXXXXX)
let sock;

/** * PRISMA AUTH STATE IMPLEMENTATION (BUFFER-SAFE serialization)
 */
async function usePrismaAuthState() {
    const bufferReplacer = (key, value) => {
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
            return { type: 'Buffer', data: Buffer.from(value.data).toString('base64') };
        }
        return value;
    };

    const bufferReviver = (key, value) => {
        if (value && value.type === 'Buffer' && typeof value.data === 'string') {
            return Buffer.from(value.data, 'base64');
        }
        return value;
    };

    const readData = async (id) => {
        try {
            const res = await prisma.session.findUnique({ where: { id } });
            return res ? JSON.parse(res.data, bufferReviver) : null;
        } catch (err) { 
            console.error(`[AUTH DB READ ERROR] ID: ${id}`, err);
            return null; 
        }
    };

    const writeData = async (id, data) => {
        try {
            const str = JSON.stringify(data, bufferReplacer);
            await prisma.session.upsert({
                where: { id },
                update: { data: str },
                create: { id, data: str }
            });
        } catch (err) {
            console.error(`[AUTH DB WRITE ERROR] ID: ${id}`, err);
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        const { creds: newCreds } = await useMultiFileAuthState('temp');
        creds = newCreds;
        await writeData('creds', creds);
    }

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore({
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = value;
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const key = `${type}-${id}`;
                            if (value) {
                                await writeData(key, value);
                            } else {
                                await prisma.session.delete({ where: { id: key } }).catch(() => {});
                            }
                        }
                    }
                }
            }, pino({ level: 'silent' }))
        },
        saveCreds: () => writeData('creds', creds)
    };
}

/**
 * WHATSAPP CONNECTION ENGINE
 */
async function connectToWhatsApp() {
    const { state, saveCreds } = await usePrismaAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Linux", "Chrome", "120.0.0.0"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PERSONAL_NUMBER);
                console.log(`\x1b[32m[GATEWAY]\x1b[0m Your WhatsApp 8-Character Pairing Code: ${code}`);
            } catch (err) {
                console.error('[GATEWAY ERROR] Failed to generate pairing code. Check PERSONAL_NUMBER format.', err);
            }
        }, 6000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[GATEWAY] Connection closed. Reason: ${lastDisconnect.error}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('[GATEWAY] WhatsApp Connection successfully established and synced.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        
        // Filter rules: Ignore status updates, group chats, historical syncs, or self-sent outgoing messages
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us') || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const phoneNumber = remoteJid.split('@')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!text) return;

        // Pull previous conversation context and handover status
        const lastChat = await prisma.supportChat.findFirst({
            where: { phone_number: phoneNumber },
            orderBy: { timestamp: 'desc' }
        });

        const currentStatus = lastChat ? lastChat.status : 'BOT_HANDLED';

        // Log incoming message to Supabase
        await prisma.supportChat.create({
            data: {
                phone_number: phoneNumber,
                message_body: text,
                sender: 'USER',
                status: currentStatus
            }
        });

        // Intercept if Human Administrator has taken over control
        if (currentStatus === 'HUMAN_REQUIRED') {
            console.log(`[GATEWAY CHAT] Human interception active for ${phoneNumber}. Bot processing bypassed.`);
            return;
        }

        // Simulate Human Typing State (Presence update)
        try {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const randomDelay = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
            await delay(randomDelay);
            await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (presenceErr) {
            console.error('[PRESENCE ERROR]', presenceErr);
        }

        // AI Engine Initialization and Execution
        const systemPrompt = `You are the official AI Support Agent for our secure financial investment platform. Be polite, professional, and concise. We offer investment packages scaling from hours, days, weeks, to months, including a 2-day internship trial earning KES 100/day (requires a recharge/deposit to unlock withdrawals). All transactions are automated securely via Safaricom M-Pesa STK push and payouts through PayHero channels. Always request the user's specific Transaction/Deposit Reference Code (DEP-XXXX) or Withdrawal Reference Code (WTH-XXXX) for any transaction issues. If you cannot solve a problem or the user is frustrated, state that you are looping in a human manager.`;

        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-1.5-flash",
                systemInstruction: systemPrompt
            });

            const result = await model.generateContent(text);
            const aiResponse = result.response.text();

            // Reply back to user via WhatsApp Gateway
            await sock.sendMessage(remoteJid, { text: aiResponse });

            // Write back response tracking state to Supabase
            await prisma.supportChat.create({
                data: {
                    phone_number: phoneNumber,
                    message_body: aiResponse,
                    sender: 'AI',
                    status: 'BOT_HANDLED'
                }
            });
        } catch (aiError) {
            console.error('[AI PROCESSING ERROR]', aiError);
        }
    });
}

/**
 * GATEWAY TRANSACTIONAL HTTP API ENDPOINTS
 */
app.post('/api/send-message', async (req, res) => {
    const authHeader = req.headers['x-gateway-auth'];
    if (!authHeader || authHeader !== GATEWAY_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Gateway-Auth token' });
    }

    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'Validation Error: phoneNumber and message fields are required' });
    }

    try {
        // Formats number accurately to Baileys formatting standard
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, status: 'Message successfully sent through gateway pipeline' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to broadcast message via gateway instance', details: error.message });
    }
});

// App Engine/Railway Instance Health Verification Route
app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Isolated WhatsApp Gateway API active on port ${PORT}`);
    connectToWhatsApp();
});
