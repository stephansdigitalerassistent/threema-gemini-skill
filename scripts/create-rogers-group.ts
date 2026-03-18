import { MediatorClient } from 'threema-openclaw/src/mediator-client.js';
import { resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(SKILL_ROOT, 'data');
const identityPath = resolveThreemaIdentityPath(DATA_DIR);
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

console.log(`Connecting to Threema as ${identity.identity}...`);

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: 'Stephans Assistent'
});

client.on('cspReady', async () => {
    console.log(`🔐 CSP Ready. Creating group...`);
    try {
        const members = ['58DHN95R', '2H6SJ5U7']; // Stephan, Roger
        const groupName = 'Stephan, Roger & Assistent';

        console.log(`Creating group "${groupName}" with members: ${members.join(', ')}...`);
        
        // Use the proper method to create a group
        const result = await client.createGroupWithMembers({
            name: groupName,
            memberIdentities: members,
            requireCsp: true
        });
        
        const creator = identity.identity;
        const groupIdHex = Buffer.from(result.groupId).toString('hex');
        console.log(`✅ Group created successfully!`);
        console.log(`Creator: ${creator}`);
        console.log(`GroupId: ${groupIdHex}`);

        // Update local groups.json
        const groupKey = `${creator}-${groupIdHex}`;
        const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
        let groupsData: Record<string, string[]> = {};
        if (fs.existsSync(GROUPS_FILE)) {
            groupsData = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
        }
        
        // Members list should include everyone for the listener to work properly
        groupsData[groupKey] = [creator, ...result.members];
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupsData, null, 2));
        console.log(`Saved group ${groupKey} to groups.json`);

        // Send an initial message to the group
        console.log("Sending initial greeting to the group...");
        await client.sendGroupTextMessage(
            creator, 
            result.groupId, 
            result.members, 
            "Hallo zusammen!\nRoger, Stephan hat mich gebeten, diese Gruppe zu erstellen, damit du testen kannst. Mit bestem Dank von Stephan!"
        );
        
        console.log("✅ Initialization complete. Exiting in 3 seconds...");
        setTimeout(() => {
            process.exit(0);
        }, 3000);
    } catch (err) {
        console.error('❌ Failed to create group:', err);
        process.exit(1);
    }
});

client.connect().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
