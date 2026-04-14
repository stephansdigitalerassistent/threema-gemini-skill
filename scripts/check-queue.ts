
import { MediatorClient } from 'threema-openclaw/src/mediator-client.js';
import { resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');

async function main() {
    const identityPath = resolveThreemaIdentityPath(DATA_DIR);
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

    const client = new MediatorClient({ identity, dataDir: DATA_DIR });

    client.on('serverInfo', (info) => {
        console.log('\n--- Threema Server Warteschlange ---');
        console.log(`Nachrichten in der Queue: ${info.reflectionQueueLength}`);
        console.log(`Maximale Device-Slots:  ${info.maxDeviceSlots}`);
        console.log(`Aktueller Slot-Status:  ${info.deviceSlotState === 0 ? 'NEW' : 'EXISTING'}`);
        console.log('------------------------------------\n');
        process.exit(0);
    });

    await client.connect();
    
    // Falls keine serverInfo kommt, Timeout nach 10s
    setTimeout(() => {
        console.log('Timeout: Keine Antwort vom Threema-Server erhalten.');
        process.exit(1);
    }, 10000);
}

main().catch(err => {
    console.error('Fehler:', err);
    process.exit(1);
});
