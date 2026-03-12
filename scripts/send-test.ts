import { MediatorClient } from 'threema-openclaw/src/mediator-client.js';
import { resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(SKILL_ROOT, '.env') });

const DATA_DIR = path.join(SKILL_ROOT, 'data');
const identityPath = resolveThreemaIdentityPath(DATA_DIR);
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
const STEPHAN_THREEMA_ID = process.env.STEPHAN_THREEMA_ID || '7PERE7EP';

console.log(`Connecting to Threema as ${identity.identity}...`);

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: process.env.THREEMA_NICKNAME
});

client.on('cspReady', async () => {
    console.log('🔐 CSP Ready. Sending test message to ' + STEPHAN_THREEMA_ID + '...');
    try {
        const msgId = await client.sendTextMessage(STEPHAN_THREEMA_ID, 'Hallo Stephan! Dies ist eine Test-Nachricht von deinem digitalen Assistenten über Threema mit PFS-Verschlüsselung. Alles läuft jetzt wie gewünscht! Dein digitaler Assistent');
        console.log(`✅ Message sent successfully! (ID: ${msgId})`);
        setTimeout(() => {
            client.close();
            process.exit(0);
        }, 2000);
    } catch (err) {
        console.error('❌ Failed to send message:', err.message);
        process.exit(1);
    }
});

client.connect().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
