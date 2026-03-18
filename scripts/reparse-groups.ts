import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const UNKNOWN_DIR = path.join(DATA_DIR, 'unknown_messages');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

async function reparse() {
    let groups: any = {};
    try {
        groups = JSON.parse(await fs.readFile(GROUPS_FILE, 'utf-8'));
    } catch(e) {}

    const files = await fs.readdir(UNKNOWN_DIR);
    for (const file of files) {
        if (file.startsWith('msg_type_75_')) {
            const data = await fs.readFile(path.join(UNKNOWN_DIR, file));
            if (data.length >= 8) {
                const groupIdHex = Buffer.from(data.subarray(0, 8)).toString('hex');
                const groupName = new TextDecoder().decode(data.subarray(8)).replace(/\0+$/g, '');
                if (!groups[groupIdHex]) {
                    groups[groupIdHex] = { members: [] };
                }
                groups[groupIdHex].name = groupName;
                console.log(`Reparsed group ${groupIdHex}: "${groupName}"`);
            }
        }
    }

    await fs.writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2));
    console.log("Updated groups.json");
}

reparse();
