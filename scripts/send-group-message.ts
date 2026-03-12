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

const groupKey = process.argv[2]; // format: creator-fullHex (which includes creator again)
const message = process.argv[3];

if (!groupKey || !message) {
    console.error('Usage: bun scripts/send-group-message.ts <groupKey> <message>');
    process.exit(1);
}

const parts = groupKey.split('-');
const creator = parts[0];
const fullHex = parts[1];
// The groupId is typically the last 8 bytes (16 hex chars) of the D2M-internal group ID
const groupIdHex = fullHex.slice(-16); 
const groupId = Buffer.from(groupIdHex, 'hex');

// Load members from groups.json
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
let members: string[] = [];
if (fs.existsSync(GROUPS_FILE)) {
    const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
    members = data[groupKey] || [];
}

if (members.length === 0) {
    console.error(`Error: No members found for group ${groupKey} in groups.json`);
    process.exit(1);
}

console.log(`Connecting to Threema as ${identity.identity}...`);
console.log(`Sending group message to ${members.length} members (Creator: ${creator}, GroupId: ${groupIdHex})...`);

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: process.env.THREEMA_NICKNAME
});

client.on('cspReady', async () => {
    console.log(`🔐 CSP Ready. Sending group message...`);
    try {
        const recipients = members.filter(id => id !== identity.identity);
        await client.sendGroupTextMessage(creator, groupId, recipients, message);
        console.log(`✅ Group message sent successfully to members: ${recipients.join(', ')}`);
        setTimeout(() => {
            process.exit(0);
        }, 2000);
    } catch (err) {
        console.error('❌ Failed to send group message:', err.message);
        process.exit(1);
    }
});

client.connect().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
