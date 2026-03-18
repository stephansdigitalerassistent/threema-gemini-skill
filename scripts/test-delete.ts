import { MediatorClient } from 'threema-openclaw/src/mediator-client.js';
import { resolveThreemaDataDir, resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(SKILL_ROOT, 'data');
process.env.THREEMA_DATA_DIR = DATA_DIR;

async function run() {
    const identityPath = resolveThreemaIdentityPath(DATA_DIR);
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
    
    const client = new MediatorClient({
        nodeUrl: 'ws://localhost:20202',
        identity: identity,
        deviceDisplayName: 'Gemini CLI',
        dataDir: DATA_DIR
    });
    
    await client.connect();
    await client.waitForLeaderAndCsp();
    
    const groupIdHex = '44a67c0d89fd43f2';
    const creator = '58DHN95R';
    const members = ['58DHN95R', 'FNA6JSWC', 'SKPHTNS8', 'W4KCS3D5'].filter(id => id !== identity.identity);
    
    const groupIdBytes = Buffer.from(groupIdHex, 'hex');
    
    // We know the id from the mediator log!
    const msgId = 13716347789382651904n;
    console.log('Editing message ' + msgId + '...');

    await client.sendGroupEditMessage(creator, groupIdBytes, members, msgId, '*(Nachricht vom Assistenten zurückgezogen: Entschuldigung, diese Testnachricht ist versehentlich im falschen Chat gelandet.)*');
    console.log('Done.');
    
    setTimeout(() => process.exit(0), 1000);
}

run().catch(console.error);
