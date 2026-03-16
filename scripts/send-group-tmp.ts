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

const creator = '7PERE7EP';
const groupIdHex = 'e937585cdec2256a';
const groupId = Buffer.from(groupIdHex, 'hex');

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
const members = data[groupIdHex]?.members || [];

const message = process.argv[2];

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: process.env.THREEMA_NICKNAME
});

client.on('cspReady', async () => {
    try {
        const recipients = members.filter(id => id !== identity.identity);
        console.log(`Sending to: ${recipients.join(', ')}`);
        await client.sendGroupTextMessage(creator, groupId, recipients, message);
        console.log(`✅ Sent successfully!`);
        setTimeout(() => process.exit(0), 2000);
    } catch (err) {
        console.error('❌ Failed:', err.message);
        process.exit(1);
    }
});
client.connect().catch(e => { console.error(e); process.exit(1); });
