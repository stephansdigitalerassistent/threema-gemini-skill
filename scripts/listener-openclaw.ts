import { MediatorClient } from 'threema-openclaw/src/mediator-client.js';
import { resolveThreemaDataDir, resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import dotenv from 'dotenv';

const execAsync = util.promisify(exec);
const fsPromises = fs.promises;

// Resolve directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(SKILL_ROOT, '.env') });

// Load history helpers (ESM)
import {  addMessage, formatHistoryForPrompt, trackConsumption, getRemoteQuota, getConsumption  } from '/home/ubuntu/src/core/history.js';
import { runGeminiAsync, runSmartGemini } from '/home/ubuntu/.gemini/skills/common/gemini-manager.js';
import { addPendingRequest, updateRequestStatus, getIncompleteRequests, enqueueTask as dbEnqueueTask, setSessionContext, getSessionContext } from '/home/ubuntu/src/db/db_helper.js';
import { upsertContact, upsertGroup, getAllContacts, getAllGroups } from '/home/ubuntu/src/db/contacts.js';
import { checkIsCommand, createApprovalRequest } from '/home/ubuntu/.gemini/skills/common/approval-manager.js';

const DATA_DIR = path.join(SKILL_ROOT, 'data');
process.env.THREEMA_DATA_DIR = DATA_DIR;

// --- HEALTH TRACKING ---
let lastMessageReceivedAt = Date.now();
let lastSelfPingSuccess = true; 

async function performSelfPing(client: any, identity: any) {
    if (!client) return;
    
    // Check if we need to recover before pinging
    if (!client.isCspReady()) {
        await log(`[HealthCheck] Client not ready (CSP not established). Skipping ping.`);
        return;
    }

    try {
        await log(`[HealthCheck] Performing background self-ping...`);
        await client.sendTextMessage(identity.identity, `[HEALTH_CHECK_PING] ${new Date().toISOString()}`);
        lastSelfPingSuccess = true;
        await log(`[HealthCheck] Self-ping successful.`);
    } catch (e: any) {
        await log(`[HealthCheck] Self-ping FAILED: ${e.message}. Attempting recovery...`);
        lastSelfPingSuccess = false;
        
        if (e.message.includes('WebSocket') || e.message.includes('closed') || e.message.includes('not open')) {
            await log(`[Recovery] WebSocket issue detected. Re-connecting...`);
            client.connect().catch(() => {});
        }
    }
}
// -----------------------

const LOG_FILE = '/home/ubuntu/threema-listener.log';
const GEMINI_TIMEOUT = 600000; // 10 minutes

let activeTasks = 0;
const MAX_CONCURRENCY = 3;
const taskQueue: (() => Promise<void>)[] = [];

async function processQueue() {
    if (activeTasks >= MAX_CONCURRENCY || taskQueue.length === 0) return;
    activeTasks++;
    const task = taskQueue.shift();
    if (task) {
        try {
            await task();
        } catch (e: any) {
            log(`Task error: ${e.message}`);
        } finally {
            activeTasks--;
            processQueue();
        }
    }
}

function enqueueTask(task: () => Promise<void>) {
    taskQueue.push(task);
    processQueue();
}

async function log(msg: string) {
    const timestamp = new Date().toISOString();
    const fullMsg = `[${timestamp}] ${msg}\n`;
    process.stdout.write(fullMsg);
    try {
        await fsPromises.appendFile(LOG_FILE, fullMsg);
    } catch (e) {}
}

const identityPath = resolveThreemaIdentityPath(DATA_DIR);
if (!fs.existsSync(identityPath)) {
    console.error("ERROR: No Threema identity found. Please run pairing script first.");
    process.exit(1);
}

const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
const STEPHAN_THREEMA_ID = process.env.STEPHAN_THREEMA_ID;

log(`Starting Threema OpenClaw Listener for ${identity.identity}...`);

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const observedGroups = new Map<string, { name?: string, members: Set<string> }>();
const observedContacts = new Map<string, { firstName?: string, lastName?: string, nickname?: string }>();

import * as http from 'node:http';

const ipcServer = http.createServer((req, res) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/status') {
        const connectedToMediator = client.isCspReady() || (client as any).ws?.readyState === 1;
        const state = connectedToMediator ? (lastSelfPingSuccess ? 'CONNECTED' : 'DEGRADED') : 'CONNECTING';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(JSON.stringify({ 
            success: true, 
            state, 
            selfPing: lastSelfPingSuccess,
            lastActivity: new Date(lastMessageReceivedAt).toISOString(),
            uptime: process.uptime(),
            isLeader: client.isLeader(),
            isCspReady: client.isCspReady()
        }));
    } else if (req.method === 'POST' && req.url === '/send') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (data.to && data.message && client) {
                    if (data.to.includes('-')) {
                        // Assume it's a group creator-groupId
                        const [creator, groupIdHex] = data.to.split('-');
                        const groupId = Buffer.from(groupIdHex, 'hex');
                        const group = observedGroups.get(groupIdHex);
                        const members = Array.from(group?.members || [creator]).filter((id: string) => id !== identity.identity);
                        await client.sendGroupTextMessage(creator, groupId, members, data.message);
                    } else {
                        await client.sendTextMessage(data.to, data.message);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing to or message fields or client not ready' }));
                }
            } catch (e: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/delete') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (data.to && data.messageId && client) {
                    const fallbackText = "*(Nachricht zurückgezogen)*";
                    if (data.to.includes('-')) {
                        const [creator, groupIdHex] = data.to.split('-');
                        const groupId = Buffer.from(groupIdHex, 'hex');
                        const group = observedGroups.get(groupIdHex);
                        const members = Array.from(group?.members || [creator]).filter((id: string) => id !== identity.identity);
                        await client.sendGroupEditMessage(creator, groupId, members, BigInt(data.messageId), fallbackText);
                        await log(`[IPC] Deleted group message ${data.messageId} in ${data.to}`);
                    } else {
                        // Direct message edit/delete isn't explicitly supported by this OpenClaw version's API surface yet, 
                        // but we handle groups which is the primary use case.
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Direct message deletion not yet implemented in API' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing to or messageId fields or client not ready' }));
                }
            } catch (e: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});
ipcServer.listen(3003, '127.0.0.1', () => log('IPC Server listening on port 3003'));

async function loadGroups() {
    try {
        const groups = await getAllGroups('threema');
        for (const g of groups) {
            observedGroups.set(g.external_id, {
                name: g.name,
                members: new Set(g.members || [])
            });
        }
        await log(`Loaded ${observedGroups.size} groups from database.`);
    } catch (e: any) {
        await log(`Error loading groups from DB: ${e.message}`);
    }
}

async function saveGroups() {
    try {
        for (const [id, val] of observedGroups.entries()) {
            await upsertGroup({
                externalId: id,
                channel: 'threema',
                name: val.name,
                members: Array.from(val.members)
            });
        }
    } catch (e: any) {
        await log(`Error saving groups to DB: ${e.message}`);
    }
}

async function loadContacts() {
    try {
        const contacts = await getAllContacts('threema');
        for (const c of contacts) {
            observedContacts.set(c.identity, {
                firstName: c.first_name,
                lastName: c.last_name,
                nickname: c.nickname
            });
        }
        await log(`Loaded ${observedContacts.size} contacts from database.`);
    } catch (e: any) {
        await log(`Error loading contacts from DB: ${e.message}`);
    }
}

async function saveContacts() {
    try {
        for (const [identity, val] of observedContacts.entries()) {
            await upsertContact({
                identity,
                channel: 'threema',
                ...val
            });
        }
    } catch (e: any) {
        await log(`Error saving contacts to DB: ${e.message}`);
    }
}

async function updateContact(identity: string, data: { firstName?: string, lastName?: string, nickname?: string }) {
    const existing = observedContacts.get(identity) || {};
    let changed = false;
    if (data.firstName && data.firstName !== existing.firstName) { existing.firstName = data.firstName; changed = true; }
    if (data.lastName && data.lastName !== existing.lastName) { existing.lastName = data.lastName; changed = true; }
    if (data.nickname && data.nickname !== existing.nickname) { existing.nickname = data.nickname; changed = true; }
    
    if (changed) {
        observedContacts.set(identity, existing);
        await saveContacts();
        await log(`Updated contact info for ${identity}: ${JSON.stringify(existing)}`);
    }
}

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: process.env.THREEMA_NICKNAME,
    onEnvelope: async (envelope) => {
        if (!client.isCspReady()) {
            await log(`[DEBUG] CSP not ready. Queuing envelope ${envelope.incomingMessage?.messageId.toString()}`);
            envelopeQueue.push(envelope);
            return;
        }
        await processEnvelope(envelope);
    }
});

const envelopeQueue: any[] = [];

async function processEnvelope(envelope: any) {
    await log(`[DEBUG] processEnvelope triggered`);
    try {
        if (envelope.incomingMessage) {
            const msg = envelope.incomingMessage;
            const msgIdStr = msg.messageId.toString();
            await log(`[DEBUG] Raw envelope received from ${msg.senderIdentity}, type: ${msg.type}, id: ${msgIdStr}`);
            
            // Dump unknown/control messages (not text, media, or basic receipts)
            const isTextOrMediaOrReceipt = [1, 65, 2, 4, 5, 6, 23, 70, 128, 129, 130, 131].includes(msg.type);
            if (!isTextOrMediaOrReceipt) {
                try {
                    const dumpDir = path.join(DATA_DIR, 'unknown_messages');
                    try {
                        await fsPromises.access(dumpDir);
                    } catch (e) {
                        await fsPromises.mkdir(dumpDir, { recursive: true });
                    }
                    const dumpPath = path.join(dumpDir, `msg_type_${msg.type}_${Date.now()}.bin`);
                    await fsPromises.writeFile(dumpPath, msg.body);
                    await log(`[DEBUG] Saved raw binary dump of message type ${msg.type} to ${dumpPath}`);
                } catch(e: any) {
                    await log(`Failed to dump message type ${msg.type}: ${e.message}`);
                }
            }

            // Update contact info if provided in envelope
            if (msg.nickname) {
                await updateContact(msg.senderIdentity, { nickname: msg.nickname });
            }

            let text: string = "";
            let mediaPath: string | null = null;
            let groupContext: { creator: string, groupId: Uint8Array } | null = null;

            if (msg.type === 1) { // Text
                text = new TextDecoder().decode(msg.body);
            } else if (msg.type === 65) { // Group Text
                // Group text body format: creator(8) + groupId(8) + text(variable)
                if (msg.body.length > 16) {
                    const creator = new TextDecoder().decode(msg.body.subarray(0, 8)).replace(/\0+$/g, '');
                    const groupId = msg.body.subarray(8, 16);
                    const groupIdHex = Buffer.from(groupId).toString('hex');
                    await log(`[GROUP DEBUG] Received group text from ${msg.senderIdentity}. Creator: ${creator}, GroupId: ${groupIdHex}, FullKey: ${creator}-${groupIdHex}`);
                    groupContext = { creator, groupId };
                    text = new TextDecoder().decode(msg.body.subarray(16));
                } else {
                    text = "(Empty group message)";
                }
            } else if (msg.type === 0x4a || msg.type === 74) { // Group Setup / Member sync
                try {
                    if (msg.body.length >= 8) {
                        const creator = msg.senderIdentity;
                        const groupId = msg.body.subarray(0, 8);
                        const groupIdHex = Buffer.from(groupId).toString('hex');
                        const groupKey = groupIdHex;
                        
                        const membersSet = new Set(STEPHAN_THREEMA_ID ? [creator, STEPHAN_THREEMA_ID] : [creator]);
                        for (let i = 8; i + 8 <= msg.body.length; i += 8) {
                            const memberId = new TextDecoder().decode(msg.body.subarray(i, i + 8)).replace(/\0+$/g, '');
                            if (memberId && /^[A-Z0-9*]{8}$/.test(memberId)) {
                                membersSet.add(memberId);
                            }
                        }
                        const existing = observedGroups.get(groupKey) || { members: new Set() };
                        existing.members = membersSet;
                        observedGroups.set(groupKey, existing);
                        await saveGroups();
                        await log(`[GROUP SETUP] Synced members for ${groupKey}. Total: ${membersSet.size}.`);

                        // Send welcome message if this is a new group or we were just added
                        const welcomeMsg = `/🤖 Hello! I'm Stephan's assistant. In this group, I only react to 'assistent', 'assistant', '${identity.identity}' or '/'. / Hallo! Ich bin Stephans Assistent. In dieser Gruppe reagiere ich nur auf 'assistent', 'assistant', '${identity.identity}' oder '/'.`;
                        const members = Array.from(membersSet).filter((id: string) => id !== identity.identity);
                        await client.sendGroupTextMessage(creator, groupId, members, welcomeMsg).catch(e => log(`Error sending welcome: ${e.message}`));
                        }                } catch (e: any) { await log(`Error parsing group setup: ${e.message}`); }
            } else if (msg.type === 0x4b || msg.type === 75) { // Group Name
                try {
                    if (msg.body.length >= 8) {
                        const groupId = msg.body.subarray(0, 8);
                        const groupIdHex = Buffer.from(groupId).toString('hex');
                        const groupName = new TextDecoder().decode(msg.body.subarray(8)).replace(/\0+$/g, '');
                        
                        const existing = observedGroups.get(groupIdHex) || { members: new Set([msg.senderIdentity]) };
                        existing.name = groupName;
                        observedGroups.set(groupIdHex, existing);
                        await saveGroups();
                        await log(`[GROUP NAME] Updated name for ${groupIdHex}: "${groupName}"`);
                    }
                } catch (e: any) { await log(`Error parsing group name: ${e.message}`); }
            } else if (msg.type === 0x4c || msg.type === 76) { // Group Leave
                try {
                    if (msg.body.length >= 16) {
                        const creator = new TextDecoder().decode(msg.body.subarray(0, 8)).replace(/\0+$/g, '');
                        const groupId = msg.body.subarray(8, 16);
                        const groupIdHex = Buffer.from(groupId).toString('hex');
                        const groupKey = groupIdHex;
                        
                        const group = observedGroups.get(groupKey);
                        if (group && group.members.has(msg.senderIdentity)) {
                            group.members.delete(msg.senderIdentity);
                            observedGroups.set(groupKey, group);
                            await saveGroups();
                            await log(`[GROUP LEAVE] Removed ${msg.senderIdentity} from ${groupKey}. Total left: ${group.members.size}.`);
                        }
                    }
                } catch (e: any) { await log(`Error parsing group leave: ${e.message}`); }
            } else if ([131].includes(msg.type)) { // Group Reaction
                await log(`[GROUP DEBUG] Ignored group control type ${msg.type} from ${msg.senderIdentity}.`);
            } else if ([2, 4, 5, 6, 23, 70].includes(msg.type)) { // Image, Audio, Video, File, Type 23 (Voice), Group File
                try {
                    let bodyToSave = msg.body;
                    if (msg.type === 70 && msg.body.length > 16) {
                        const creator = new TextDecoder().decode(msg.body.subarray(0, 8)).replace(/\0+$/g, '');
                        const groupId = msg.body.subarray(8, 16);
                        groupContext = { creator, groupId };
                        bodyToSave = msg.body.subarray(16);
                    }
                    const tempDir = path.join(process.env.HOME || '/home/ubuntu', 'tmp', 'threema-media');
                    try {
                        await fsPromises.access(tempDir);
                    } catch (e) {
                        await fsPromises.mkdir(tempDir, { recursive: true });
                    }
                    const ext = (msg.type === 2) ? '.jpg' : (msg.type === 4 || msg.type === 23) ? '.ogg' : (msg.type === 5) ? '.mp4' : '.bin';
                    mediaPath = path.join(tempDir, `threema_${msgIdStr}${ext}`);
                    await fsPromises.writeFile(mediaPath, bodyToSave);
                    await log(`Saved Threema media (type ${msg.type}) to ${mediaPath}`);
                    
                    // --- NEUES FEATURE: TRANSKRIPTION ---
                    if (msg.type === 4 || msg.type === 6 || msg.type === 23 || msg.type === 70) {
                        const { transcribeAudio } = await import('/home/ubuntu/scripts/transcribe.cjs');
                        let audioToTranscribe: string | null = null;
                        
                        if (msg.type === 4) {
                            audioToTranscribe = mediaPath;
                            await log(`Direkte Sprachnachricht erkannt.`);
                        } else {
                            // Datei oder Gruppendatei (Blob-Pointer), Typ 23 ist auch ein Blob-Pointer
                            await log(`Datei/Gruppendatei erkannt (Typ ${msg.type}). Prüfe auf Audio...`);
                            try {
                                const resolved = (msg.type === 70) 
                                    ? await client.resolveGroupFileMessageBody(msg.body)
                                    : await client.resolveDirectFileMessageBody(msg.body);
                                
                                if (resolved && resolved.file && resolved.descriptor) {
                                    const mediaType = resolved.descriptor.mediaType || "";
                                    const fileName = resolved.descriptor.fileName || "";
                                    const isAudio = mediaType.startsWith("audio/") || fileName.endsWith(".aac") || fileName.endsWith(".m4a") || fileName.endsWith(".ogg");
                                    const isVideo = mediaType.startsWith("video/") || fileName.endsWith(".mp4") || fileName.endsWith(".mov");
                                    
                                    if (isAudio) {
                                        await log(`Audio-Blob gefunden (${mediaType}). Lade herunter...`);
                                        const ext = mediaType.includes("aac") ? ".aac" : mediaType.includes("mp4") ? ".m4a" : ".ogg";
                                        const blobPath = path.join(path.dirname(mediaPath!), `blob_${msgIdStr}${ext}`);
                                        await fsPromises.writeFile(blobPath, resolved.file.bytes);
                                        audioToTranscribe = blobPath;
                                    } else {
                                        await log(`Datei ist kein unterstütztes Audio (${mediaType} / ${fileName}).`);
                                        if (isVideo) {
                                            const caption = resolved.descriptor.caption || "";
                                            if (caption.trim().length > 0) {
                                                text = `[Video mit Text/Auftrag]: ${caption}`;
                                                mediaPath = null;
                                            } else {
                                                text = "";
                                                mediaPath = null;
                                                await log(`Video ohne Text wird ignoriert.`);
                                            }
                                        } else {
                                            text = `(Sent media of type ${msg.type}: ${mediaType})`;
                                        }
                                    }
                                }
                            } catch (e: any) {
                                await log(`Fehler beim Auflösen des Blobs: ${e.message}`);
                            }
                        }

                        if (audioToTranscribe) {
                            await log(`Starte Transkription für ${audioToTranscribe}...`);
                            try {
                                const transcript = await transcribeAudio(audioToTranscribe);
                                if (transcript) {
                                    const contact = observedContacts.get(msg.senderIdentity);
                                    const displayName = contact?.firstName || contact?.nickname || msg.senderIdentity;
                                    
                                    // Wir speichern die Transkription in 'text', damit handleMessage sie verarbeitet
                                    // und Gemini darauf reagieren kann.
                                    text = `[Sprachnachricht von @${displayName}]: \n${transcript}`;
                                    await log(`Transkription für Gemini bereitgestellt: ${transcript.substring(0, 50)}...`);
                                    
                                    const header = `Transkription (@${displayName}):\n\n`;
                                    const fullTranscriptMsg = header + transcript;

                                    await log(`Transkription erfolgreich erstellt: ${transcript.substring(0, 50)}...`);
                                    
                                    // Transkription direkt in den Chat posten
                                    if (groupContext) {
                                        const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
                                        const group = observedGroups.get(groupIdHex);
                                        const members = Array.from(group?.members || [msg.senderIdentity]).filter((id: any) => id !== identity.identity);
                                        await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, fullTranscriptMsg).catch(e => log(`Senden der Transkription fehlgeschlagen: ${e.message}`));
                                    } else {
                                        await client.sendTextMessage(msg.senderIdentity, fullTranscriptMsg).catch(e => log(`Senden der Transkription fehlgeschlagen: ${e.message}`));
                                    }
                                }
                            } catch (e: any) {
                                await log(`Transkriptionsfehler: ${e.message}`);
                                text = `(Fehler bei der Transkription der Sprachnachricht)`;
                            }
                        } else if (text === "") {
                            // Text is empty (e.g. video without caption), keep it empty
                        } else if (!text || text.startsWith("(Sent media")) {
                            if (!text) text = `(Sent media of type ${msg.type})`;
                        }
                    } else if (msg.type === 5) {
                        text = "";
                        mediaPath = null;
                        await log(`Legacy Video (Typ 5) wird ignoriert.`);
                    } else {
                        text = `(Sent media of type ${msg.type})`;
                    }
                    // --------------------------------------------
                } catch (e: any) {
                    await log(`Error saving Threema media: ${e.message}`);
                }
            }

            if (text || mediaPath) {
                await handleMessage(msg.senderIdentity, text, mediaPath, groupContext, msgIdStr);
            } else {
                let typeName = `Type ${msg.type}`;
                let bodyInfo = "";
                
                if (msg.type === 128) typeName = 'DELIVERY RECEIPT (Delivered)';
                if (msg.type === 129) typeName = 'READ RECEIPT (Read)';
                if (msg.type === 130) typeName = 'USER TYPING / SEEN';
                if (msg.type === 131) typeName = 'GROUP CONTROL / REACTION';

                if (msg.body && msg.body.length > 0 && msg.body.length <= 32) {
                    try {
                        bodyInfo = ` (Body: ${Buffer.from(msg.body).toString('hex')})`;
                    } catch (e) {}
                }

                await log(`[RECEIPT/CONTROL] Received ${typeName} from ${msg.senderIdentity} for msgId: ${msgIdStr}${bodyInfo}`);
            }
        } else {
            await log(`[DEBUG] Envelope received without incomingMessage property.`);
        }
    } catch (error: any) {
        await log(`[ERROR] processEnvelope: ${error.message}`);
    }
}

const originalSendTextMessage = client.sendTextMessage.bind(client);
client.sendTextMessage = async (recipient: string, text: string) => {
    try {
        (await import('/home/ubuntu/src/db/db_helper.js')).logMessage({
            direction: 'outbound',
            channel: 'threema',
            sender_id: 'assistant',
            sender_name: 'Assistant',
            group_id: null, // Threema openclaw group sends might not be just plain sendTextMessage, but let's leave it null for now
            content: text || '[Non-Text]'
        });
    } catch(e: any) { await log('DB Log Outbound Error: ' + e.message); }
    return await originalSendTextMessage(recipient, text);
};

function cleanGeminiOutput(text: string): string {
    let result = text;

    // 0. Always clean up thinking blocks FIRST, so they don't leak no matter where they are
    result = result.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '');

    // 1. If there's a <REPLY> tag, simply take everything after it.
    const replyIndex = result.toUpperCase().indexOf('<REPLY>');
    if (replyIndex !== -1) {
        // Start right after the <REPLY> tag
        const startIdx = replyIndex + '<REPLY>'.length;
        result = result.substring(startIdx);
    }

    // 2. Clean up any closing tags or remaining internal tags
    result = result.replace(/<\/REPLY>/gi, '');
    result = result.replace(/<\/thinking>/gi, '');
    result = result.replace(/<function_calls>[\s\S]*?(?:<\/function_calls>|$)/gi, '');
    result = result.replace(/<function_outputs>[\s\S]*?(?:<\/function_outputs>|$)/gi, '');
    result = result.replace(/<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/gi, '');

    let lines = result.split('\n');
    let filtered = lines.filter(line => {
        const l = line.trim();
        if (l.startsWith('I will now') || l.startsWith('I am now') || l.startsWith('Ich werde nun')) return false;
        // Basic fallback filters just in case
        if (l.startsWith('Error executing tool') || l.startsWith('[LocalAgentExecutor]') || (l.startsWith('Attempt') && l.includes('failed'))) return false;
        return true;
    });
    
    result = filtered.join('\n');
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

async function handleMessage(senderId: string, text: string, mediaPath: string | null = null, groupContext: { creator: string, groupId: Uint8Array } | null = null, msgIdStr: string | null = null) {
    if (senderId === identity.identity) {
        return; // Ignore self
    }

    if (text && text.includes('[HEALTH_CHECK_PING]')) {
        return; // Ignore internal health pings
    }
    
    if (senderId === 'ECHOECHO') {
        const contextStr = groupContext ? `in group ${groupContext.creator}-${Buffer.from(groupContext.groupId).toString('hex')}` : 'directly';
        await log(`Ignored message from ECHOECHO ${contextStr} to prevent loop: ${text}`);
        if (msgIdStr) {
            client.sendDeliveryReceipt(senderId, [msgIdStr], 3).catch(err => {
                log(`Error sending read receipt for ECHOECHO ${msgIdStr}: ${err.message}`);
            });
        }
        return;
    }

    try {
        const groupIdHex = groupContext ? Buffer.from(groupContext.groupId).toString('hex') : null;
        const logged = await (await import('/home/ubuntu/src/db/db_helper.js')).logMessage({
            direction: 'inbound',
            channel: 'threema',
            sender_id: senderId,
            sender_name: senderId, // Nickname fetching is async or cached, sticking to ID for safety
            group_id: groupIdHex,
            content: text || (mediaPath ? `[Media: ${path.basename(mediaPath)}]` : '[Unknown]'),
            provider_msg_id: msgIdStr,
            status: 'processing'
        });

        if (!logged && msgIdStr) {
            await log(`[Deduplication] Skipping already processed message ${msgIdStr}`);
            client.sendDeliveryReceipt(senderId, [msgIdStr], 3).catch(err => {
                log(`Error sending late read receipt for duplicate ${msgIdStr}: ${err.message}`);
            });
            return;
        }

        // --- SUCCESS: Message is in DB. Now we can acknowledge to Threema ---
        if (msgIdStr && !text.includes('[HEALTH_CHECK_PING]')) {
            client.sendDeliveryReceipt(senderId, [msgIdStr], 3).catch(err => {
                log(`Error sending late read receipt for ${msgIdStr}: ${err.message}`);
            });
        }
    } catch(e: any) { await log('DB Log Inbound Error: ' + e.message); }

    let groupName: string | undefined;
    if (groupContext) {
        const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
        const group = observedGroups.get(groupIdHex) || { members: new Set(STEPHAN_THREEMA_ID ? [STEPHAN_THREEMA_ID] : []) };
        const oldSize = group.members.size;
        group.members.add(senderId);
        observedGroups.set(groupIdHex, group);
        if (group.members.size !== oldSize) {
            await saveGroups();
        }
        groupName = group.name;
    }

    await log(`Received message from ${senderId}: ${text}`);

    const contact = observedContacts.get(senderId);
    let userName = contact?.firstName || contact?.nickname || senderId;
    if (senderId === STEPHAN_THREEMA_ID) userName = "Stephan";
    
    let userRole = senderId === STEPHAN_THREEMA_ID ? "Stephan (Primary User)" : "Someone else";

    if (senderId !== STEPHAN_THREEMA_ID) {
        // Mirror unauthorized
        await log(`Mirroring unauthorized message from ${userName} (${senderId}) to Telegram.`);
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const STEPHAN_TG_ID = process.env.STEPHAN_TG_ID;
        if (BOT_TOKEN && STEPHAN_TG_ID) {
            try {
                const groupInfo = groupName ? ` in Gruppe "<b>${groupName}</b>"` : "";
                
                // Escape HTML special characters in the raw text to prevent injection/crashing
                const safeText = text
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");

                const notifyText = `🔔 <b>Threema von ${userName}</b> (${senderId})${groupInfo}:\n\n${safeText}`;
                
                const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: STEPHAN_TG_ID,
                        text: notifyText,
                        parse_mode: 'HTML'
                    })
                });
            } catch (e: any) {
                await log(`Failed to notify Stephan: ${e.message}`);
            }
        }
    }

    const isNaturalReminder = text.toLowerCase().includes('erinnere mich') || text.toLowerCase().startsWith('remind me');
    if ((text.startsWith('/remind ') || isNaturalReminder) && senderId === STEPHAN_THREEMA_ID) {
        const reminderQuery = text.startsWith('/remind ') ? text.substring(8).trim() : text;
        enqueueTask(async () => {
            try {
                const prompt = `Du bist ein Zeit-Parser. Extrahiere Datum/Uhrzeit und die Nachricht aus diesem Text: "${reminderQuery}". 
Aktuelle Lokalzeit in Zürich ist: ${new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}. 
Gib NUR ein JSON Objekt zurück: {"time": "ISO_TIMESTAMP", "message": "DEINE_NACHRICHT"}. 
WICHTIG: Erzeuge den ISO_TIMESTAMP für die Zürcher Zeitzone (Europa/Zurich).
Wenn keine Zeit gefunden wird, nimm in 1 Stunde an.`;
                
                await log("Parsing reminder in-process (Threema)...");
                const resultGemini = await runGeminiAsync(['--model', 'gemini-3.1-flash-lite-preview', '--approval-mode', 'yolo', '-p', prompt]);
                const stdout = resultGemini.stdout;
                const result = JSON.parse(stdout.substring(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
                
                const { addReminder } = await import('/home/ubuntu/src/db/db_helper.js');
                await addReminder(result.time, result.message);
                
                const dateStr = new Date(result.time).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
                await client.sendTextMessage(senderId, `✅ Erinnerung gespeichert: "${result.message}" am ${dateStr}`);
            } catch (e: any) {
                await log(`Reminder Error: ${e.message}`);
                await client.sendTextMessage(senderId, "❌ Fehler beim Speichern der Erinnerung. Bitte versuche es präziser.");
            }
        });
        if (mediaPath) try { await fsPromises.unlink(mediaPath); } catch (e) {}
        return;
    }

    if (text.trim().startsWith('/status') && senderId === STEPHAN_THREEMA_ID) {
        enqueueTask(async () => {
            try {
                await log(`Generating status report for Stephan...`);
                let statusMsg = "📊 *System Status*:\n\n";

                try {
                    const localStatsInfo = await execAsync('node /home/ubuntu/scripts/get-full-status.mjs', { encoding: 'utf-8' });
                    statusMsg += localStatsInfo.stdout;
                } catch (e: any) {
                    statusMsg += "❌ Fehler beim Abrufen lokaler Stats.\n\n";
                }

                // Remote Quota Stats
const remoteQuota = await getRemoteQuota();
                if (remoteQuota && Array.isArray(remoteQuota)) {
                    statusMsg += `\n*🤖 Model Quotas*:\n`;
                    statusMsg += `\`Model                Usage    Resets in\`\n`;

                    const grouped: any = {};
                    remoteQuota.forEach((q: any) => {
                        if (q.error) return;
                        const baseModel = q.model.replace('_vertex', '').toLowerCase();
                        let family = "Other";
                        if (baseModel.includes("lite")) family = "Lite";
                        else if (baseModel.includes("pro")) family = "Pro";
                        else if (baseModel.includes("flash")) family = "Flash";
                        else if (baseModel.includes("veo")) family = "Veo";
                        else if (baseModel.includes("imagen")) family = "Imagen";

                        const currentPct = parseFloat(q.percent) || 0;
                        if (family === "Other" && currentPct === 0) return;

                        if (!grouped[family]) {
                            grouped[family] = { ...q, display: family, minRemaining: currentPct };
                        } else {
                            if (currentPct < grouped[family].minRemaining) {
                                grouped[family].minRemaining = currentPct;
                                grouped[family].percent = q.percent;
                                grouped[family].resetTime = q.resetTime || grouped[family].resetTime;
                            }
                        }
                    });

                    const order: any = { "Flash": 1, "Pro": 2, "Lite": 3, "Imagen": 4, "Veo": 5, "Other": 6 };
                    Object.values(grouped).sort((a: any, b: any) => (order[a.display] || 99) - (order[b.display] || 99)).forEach((q: any) => {
                        const resetDate = q.resetTime ? new Date(q.resetTime) : null;
                        let resetStr = "-";
                        if (resetDate && !isNaN(resetDate.getTime())) {
                            const diffMs = resetDate.getTime() - Date.now();
                            if (diffMs > 0) {
                                const diffH = Math.floor(diffMs / 3600000);
                                const diffM = Math.floor((diffMs % 3600000) / 60000);
                                resetStr = `${diffH}h ${diffM}m`;
                            } else {
                                resetStr = "now";
                            }
                        }
                        const modelName = ("*" + q.display + "*").padEnd(20).substring(0, 20);
                        const usage = `${q.percent}%`.padStart(6);
                        statusMsg += `\`${modelName} ${usage}    ${resetStr}\`\n`;
                    });
                } else {
                    statusMsg += `\n⚠️ *Model Quotas*: Keine Daten verfügbar.\n`;
                }


                const consumption = await getConsumption();

                const calcCost = (inChars: number, outChars: number) => {
                     return ((inChars / 1000000) * 0.075) + ((outChars / 1000000) * 0.30);
                };

                const costToday = calcCost(consumption?.today?.in || 0, consumption?.today?.out || 0);
                const costYesterday = calcCost(consumption?.yesterday?.in || 0, consumption?.yesterday?.out || 0);
                const costMonth = calcCost(consumption?.thisMonth?.in || 0, consumption?.thisMonth?.out || 0);

                statusMsg += `\n*Verbrauch & Kosten* (Gemini 1.5 Flash):\n`;
                statusMsg += `\`Zeitraum  In(k) Out(k)  Cost($)\`\n`;
                statusMsg += `\`Heute   ${((consumption?.today?.in||0)/1000).toFixed(1).padStart(6)} ${((consumption?.today?.out||0)/1000).toFixed(1).padStart(6)} ${costToday.toFixed(4).padStart(8)}\`\n`;
                statusMsg += `\`Gestern ${((consumption?.yesterday?.in||0)/1000).toFixed(1).padStart(6)} ${((consumption?.yesterday?.out||0)/1000).toFixed(1).padStart(6)} ${costYesterday.toFixed(4).padStart(8)}\`\n`;
                statusMsg += `\`Monat   ${((consumption?.thisMonth?.in||0)/1000).toFixed(1).padStart(6)} ${((consumption?.thisMonth?.out||0)/1000).toFixed(1).padStart(6)} ${costMonth.toFixed(4).padStart(8)}\`\n`;

                statusMsg += `\n📈 Aktuelle Rate: ${((consumption?.rates?.lastHour||0) / 1000).toFixed(1)}k Chars/h\n`;

                if (groupContext) {
                    const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
                    const group = observedGroups.get(groupIdHex);
                    const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                    await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, statusMsg);
                } else {
                    await client.sendTextMessage(senderId, statusMsg);
                }
            } catch (e: any) {
                await log(`Failed to generate status: ${e.message}`);
            }
        });
        return;
    }

    try {
        let chatContext = groupContext ? `GROUP_CHAT (Name: ${groupName || "Unknown"})` : 'DIRECT_MESSAGE';

        // Select system prompt based on user
        const systemPromptPath = (senderId === STEPHAN_THREEMA_ID) 
            ? '/home/ubuntu/.gemini/ADMIN_FULL.md' 
            : '/home/ubuntu/.gemini/GUEST_FULL.md';

        let instruction = `CRITICAL MESSENGER RULES:\n1. CHAT TYPE: ${chatContext}. ${groupContext ? 'In a GROUP_CHAT, you MUST stay silent and NOT respond unless explicitly mentioned.' : 'Direct conversation.'}\n2. Message from ${userName} via Threema.`;

        await addMessage(senderId, 'threema', userName, text);

        if (groupContext) {
            const lowerQuery = (text || "").toLowerCase();
            const botMention = identity.identity.toLowerCase();
            const triggerWords = ['assistent', 'assistant', botMention];
            const isMentioned = triggerWords.some(word => lowerQuery.includes(word)) || lowerQuery.startsWith('/');
            if (!isMentioned) {
                await log(`[DEBUG] Group message stored but ignored for Gemini (no explicit mention).`);
                return;
            }
        }

        const historyContext = await formatHistoryForPrompt(senderId, 'threema');

        let fullQuery = instruction + historyContext + "\n\nUser message: " + text;
        if (mediaPath) {
            fullQuery += `\n\nIMPORTANT: A media file was sent with this message and saved to: ${mediaPath}. Please read and analyze this file to fulfill the request.`;
        }
        
        await log(`Asking Gemini for response to ${userName}...`);
        const modeFlag = (senderId === STEPHAN_THREEMA_ID) ? '--approval-mode yolo' : '--approval-mode auto_edit';
        
        let groupContextObj: any = null;
        if (groupContext) {
             groupContextObj = {
                 creator: groupContext.creator,
                 groupIdHex: Buffer.from(groupContext.groupId).toString('hex')
             };
        }

        const requestId = await addPendingRequest('threema', senderId, text, {
             userName,
             groupContext: groupContextObj,
             mediaPath
        });

        // --- START NEUES SMART ROUTING ---
        const isTrustedAdmin = (senderId === STEPHAN_THREEMA_ID);

        let shouldIntercept = false;
        if (groupContext && isTrustedAdmin && text) {
            shouldIntercept = await checkIsCommand(text);
        }

        if (shouldIntercept) {
            const taskQueryObj = {
                instruction,
                historyContext,
                messageText: text,
                mediaPath,
                systemPromptPath
            };
            const approvalId = await createApprovalRequest('Threema Group', senderId, text, taskQueryObj);
            await log(`Intercepted group command from Stephan, created approval request ${approvalId}`);
            await updateRequestStatus(requestId, 'completed');
            return;
        }

        // --- ENTWICKLER-STEUERUNG (INTENT 4) ---
        if (isTrustedAdmin && (text.startsWith('/ok dev') || text.startsWith('/ok commit') || text.startsWith('/fix'))) {
            const devContext = await getSessionContext(senderId, 'developer');
            if (devContext) {
                await dbEnqueueTask({
                    channel: 'threema', senderId: senderId, senderName: userName, groupId: groupIdHex,
                    content: text,
                    metadata: { ...devContext, systemPromptPath, isTrustedAdmin, requestId }
                });
                await updateRequestStatus(requestId, 'processing');
                return;
            }
        }
        // ----------------------------------------

        enqueueTask(async () => {
            try {
                await updateRequestStatus(requestId, 'processing');
                await log(`Asking Cognitive Proxy (Smart) for response to ${userName}...`);

                const result = await runSmartGemini({
                    message: fullQuery,
                    userName,
                    channel: 'threema',
                    senderId: senderId,
                    groupId: groupIdHex,
                    isTrustedAdmin,
                    mediaPath: mediaPath, // PASS MEDIA TO GEMINI
                    options: {
                        timeout: GEMINI_TIMEOUT,
                        env: {
                            ...process.env,
                            LANG: 'en_US.UTF-8',
                            GEMINI_UI_INLINETHINKINGMODE: 'hidden',
                            GEMINI_SYSTEM_MD: systemPromptPath
                        }
                    }
                });

                if (result.persistent) {
                    await log(`[GeminiManager] Request enqueued persistently for ${userName}.`);
                    const persistentMsg = cleanGeminiOutput(result.stdout || "");
                    if (groupContext) {
                        const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
                        const group = observedGroups.get(groupIdHex);
                        const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                        await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, persistentMsg);
                    } else {
                        await client.sendTextMessage(senderId, persistentMsg);
                    }
                    await updateRequestStatus(requestId, 'processing', 'ENQUEUED_IN_DB');
                    return;
                }
                
                if (result.routingAction === 'developer_plan') {
                    await setSessionContext(senderId, 'developer', {
                        originalQuery: text,
                        plan: result.stdout,
                        files: result.files
                    });
                }

                let response = cleanGeminiOutput(result.stdout || "");
                
                if (result.routingAction === 'intercept') {
                    // Intercepted / Blocked (e.g. Pro required)
                    if (groupContext) {
                        const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
                        const group = observedGroups.get(groupIdHex);
                        const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                        await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, response);
                    } else {
                        await client.sendTextMessage(senderId, response);
                    }
                    await updateRequestStatus(requestId, 'completed', response);
                    return;
                }

                if (!response) {
                    if (result.status !== 0) {
                        response = `❌ Ein interner Fehler ist aufgetreten (Code ${result.status}). Bitte versuche es später noch einmal.`;
                        if (result.stderr && (result.stderr.includes('429') || result.stderr.includes('exhausted'))) {
                             response = `❌ Meine Kapazitäten sind derzeit leider erschöpft (Quota Limit). Bitte versuche es in ein paar Minuten noch einmal.`;
                        }
                        await log(`Error status ${result.status} without output. Sending error to user.`);
                    } else {
                        await log('Warning: Cleaned response is empty. Skipping output.');
                        await updateRequestStatus(requestId, 'completed', '');
                        return;
                    }
                }

                await trackConsumption('threema', fullQuery.length, response.length);
                await addMessage(senderId, 'threema', 'Assistant', response);

                // Send response
                if (groupContext) {
                    const groupIdHex = Buffer.from(groupContext.groupId).toString('hex');
                    const group = observedGroups.get(groupIdHex);
                    const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                    await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, response);
                    await log(`Gemini response sent to group: ${response}`);
                } else {
                    await client.sendTextMessage(senderId, response);
                    await log(`Gemini response sent to ${senderId}: ${response}`);
                }
                
                await updateRequestStatus(requestId, 'completed', response);
            } catch (error: any) {
                await log(`Gemini Error: ${error.message}`);
                await updateRequestStatus(requestId, 'failed', error.message);
                if (error.killed) {
                    await client.sendTextMessage(senderId, "⌛ Die Anfrage hat zu lange gedauert (Timeout).");
                }
            } finally {
                if (mediaPath) try { await fsPromises.unlink(mediaPath); } catch (e) {}
            }
        });
        // --- ENDE NEUES SMART ROUTING ---
    } catch (error: any) {
        await log(`ERROR: ${error.message}`);
    }
}


client.on('cspReady', async () => {
    await log('🔐 Threema CSP handshake completed. Ready.');
    
    // Process queued envelopes
    if (envelopeQueue.length > 0) {
        await log(`[DEBUG] Processing ${envelopeQueue.length} queued envelopes...`);
        while (envelopeQueue.length > 0) {
            const env = envelopeQueue.shift();
            await processEnvelope(env);
        }
    }

    // Heartbeat to keep connection alive (every 2 minutes)
    setInterval(async () => {
        if (client.isCspReady() && STEPHAN_THREEMA_ID) {
            client.sendTypingIndicator(STEPHAN_THREEMA_ID, false).catch(() => {});
        }
    }, 120000);

    setTimeout(resumeRequests, 3000);
});

async function resumeRequests() {
    try {
        const pending = await getIncompleteRequests();
        const myPending = pending.filter((r: any) => r.source === 'threema');
        if (myPending.length === 0) return;

        await log(`[RECOVERY] Found ${myPending.length} incomplete Threema requests. Resuming...`);
        for (const req of myPending) {
            await log(`[RECOVERY] Resuming request ${req.id} from ${req.chat_id}...`);
            const senderId = req.chat_id;
            const text = req.content;
            const userName = req.metadata.userName;
            const groupContextObj = req.metadata.groupContext;
            const mediaPath = req.metadata.mediaPath;

            // Notify user
            if (groupContextObj) {
                const group = observedGroups.get(groupContextObj.groupIdHex);
                const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                await client.sendGroupTextMessage(groupContextObj.creator, Buffer.from(groupContextObj.groupIdHex, 'hex'), members, "🔄 *System-Neustart*: Ich habe deine letzte Anfrage gerade wieder aufgenommen und bearbeite sie jetzt fertig...");
            } else {
                await client.sendTextMessage(senderId, "🔄 *System-Neustart*: Ich habe deine letzte Anfrage gerade wieder aufgenommen und bearbeite sie jetzt fertig...");
            }

            let chatContext = groupContextObj ? `GROUP_CHAT` : 'DIRECT_MESSAGE';
            
            // Select system prompt based on user
            const systemPromptPath = (senderId === STEPHAN_THREEMA_ID) 
                ? '/home/ubuntu/.gemini/ADMIN_FULL.md' 
                : '/home/ubuntu/.gemini/GUEST_FULL.md';

            let instruction = `CRITICAL MESSENGER RULES:\n1. CHAT TYPE: ${chatContext}.\n2. Message from ${userName} via Threema.`;

            const historyContext = await formatHistoryForPrompt(senderId, 'threema');
            let fullQuery = instruction + historyContext + "\n\nUser message: " + text;
            if (mediaPath) fullQuery += `\n\nIMPORTANT: Media saved to: ${mediaPath}. Analyze this file.`;

            const isTrustedAdmin = (senderId === STEPHAN_THREEMA_ID);
            
            await client.sendTypingIndicator(senderId, true).catch(() => {});

            enqueueTask(async () => {
                try {
                    await updateRequestStatus(req.id, 'processing');
                    await log(`Asking Cognitive Proxy (Recovery Smart) for response to ${userName}...`);

                    const result = await runSmartGemini({
                        message: fullQuery,
                        userName,
                        isTrustedAdmin,
                        mediaPath: mediaPath, // PASS MEDIA TO GEMINI
                        options: {
                            timeout: GEMINI_TIMEOUT,
                            env: {
                                ...process.env,
                                LANG: 'en_US.UTF-8',
                                GEMINI_UI_INLINETHINKINGMODE: 'hidden',
                                GEMINI_SYSTEM_MD: systemPromptPath
                            }
                        }
                    });
                    
                    let response = cleanGeminiOutput(result.stdout || "");

                    if (result.routingAction === 'intercept') {
                        if (groupContextObj) {
                            const group = observedGroups.get(groupContextObj.groupIdHex);
                            const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                            await client.sendGroupTextMessage(groupContextObj.creator, Buffer.from(groupContextObj.groupIdHex, 'hex'), members, response);
                        } else {
                            await client.sendTextMessage(senderId, response);
                        }
                        await updateRequestStatus(req.id, 'completed', response);
                        return;
                    }

                    if (!response) {
                        if (result.status !== 0) {
                            response = `❌ Ein interner Fehler ist aufgetreten (Code ${result.status}). Bitte versuche es später noch einmal.`;
                            if (result.stderr && (result.stderr.includes('429') || result.stderr.includes('exhausted'))) {
                                 response = `❌ Meine Kapazitäten sind derzeit leider erschöpft (Quota Limit). Bitte versuche es in ein paar Minuten noch einmal.`;
                            }
                            await log(`Error status ${result.status} without output. Sending error to user.`);
                        } else {
                            await log('Warning: (Recovery) Cleaned response is empty. Skipping output.');
                            await updateRequestStatus(req.id, 'completed', '');
                            return;
                        }
                    }

                    await trackConsumption('threema', fullQuery.length, response.length);
                    await addMessage(senderId, 'threema', 'Assistant', response);

                    if (groupContextObj) {
                        const group = observedGroups.get(groupContextObj.groupIdHex);
                        const members = Array.from(group?.members || [senderId]).filter(id => id !== identity.identity);
                        await client.sendGroupTextMessage(groupContextObj.creator, Buffer.from(groupContextObj.groupIdHex, 'hex'), members, response);
                    } else {
                        await client.sendTextMessage(senderId, response);
                    }
                    await updateRequestStatus(req.id, 'completed', response);
                } catch (error: any) {
                    await log(`Recovery Gemini Error: ${error.message}`);
                    await updateRequestStatus(req.id, 'failed', error.message);
                }
            });
        }
    } catch (e: any) {
        await log(`[RECOVERY ERROR] ${e.message}`);
    }
}

client.on('cspError', async (error) => {
    await log(`[CRITICAL] CSP Encryption Error detected: ${error.message}. Forcing restart for self-healing...`);
    process.exit(1);
});

client.on('close', async (code, reason) => {
    await log(`Connection closed: ${code} ${reason}`);
    
    // 1011: Server error (Mediator protocol/session issues). 
    // Usually fixed by re-generating a device ID (Slot State: NEW).
    if (code === 1011) {
        try {
            await log(`[Self-Healing] Detected 1011 Server error. Resetting deviceId for next connection...`);
            const currentIdentity = JSON.parse(await fsPromises.readFile(identityPath, 'utf-8'));
            if (currentIdentity.deviceId) {
                delete currentIdentity.deviceId;
                await fsPromises.writeFile(identityPath, JSON.stringify(currentIdentity, null, 2));
                await log(`[Self-Healing] Stale deviceId removed successfully.`);
            }
        } catch (e: any) {
            await log(`[Self-Healing] Failed to reset identity: ${e.message}`);
        }
    }
    
    process.exit(1);
});

async function start() {
    await loadGroups();
    await loadContacts();

    client.connect().then(() => {
        // Start background ping every 15 minutes (to avoid spamming, but verify connection)
        setInterval(() => performSelfPing(client, identity), 15 * 60 * 1000);
        // Initial ping after 60 seconds
        setTimeout(() => performSelfPing(client, identity), 60 * 1000);
    }).catch(async err => {
        await log(`FATAL: ${err.message}`);
        process.exit(1);
    });
}

start();
