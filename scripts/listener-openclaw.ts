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

// Load history helpers (CommonJS)
const { addMessage, formatHistoryForPrompt, trackConsumption } = require('/home/ubuntu/.gemini/skills/common/history');
const { runGeminiAsync } = require('/home/ubuntu/.gemini/skills/common/gemini-manager');

const DATA_DIR = path.join(SKILL_ROOT, 'data');
process.env.THREEMA_DATA_DIR = DATA_DIR;

const LOG_FILE = '/home/ubuntu/threema-listener.log';
const GEMINI_TIMEOUT = 60000; // 60 seconds

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

function log(msg: string) {
    const timestamp = new Date().toISOString();
    const fullMsg = `[${timestamp}] ${msg}\n`;
    process.stdout.write(fullMsg);
    fs.appendFileSync(LOG_FILE, fullMsg);
}

const identityPath = resolveThreemaIdentityPath(DATA_DIR);
if (!fs.existsSync(identityPath)) {
    log("ERROR: No Threema identity found. Please run pairing script first.");
    process.exit(1);
}

const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
const STEPHAN_THREEMA_ID = process.env.STEPHAN_THREEMA_ID;

log(`Starting Threema OpenClaw Listener for ${identity.identity}...`);

const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const observedGroupMembers = new Map<string, Set<string>>();

function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
            for (const [key, members] of Object.entries(data)) {
                observedGroupMembers.set(key, new Set(members as string[]));
            }
            log(`Loaded ${observedGroupMembers.size} groups from disk.`);
        }
    } catch (e: any) {
        log(`Error loading groups: ${e.message}`);
    }
}

function saveGroups() {
    try {
        const data: Record<string, string[]> = {};
        observedGroupMembers.forEach((members, key) => {
            data[key] = Array.from(members);
        });
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2));
    } catch (e: any) {
        log(`Error saving groups: ${e.message}`);
    }
}

loadGroups();

const client = new MediatorClient({
    identity,
    dataDir: DATA_DIR,
    nickname: process.env.THREEMA_NICKNAME,
    onEnvelope: (envelope) => {
        log(`[DEBUG] onEnvelope triggered`);
        if (envelope.incomingMessage) {
            const msg = envelope.incomingMessage;
            const msgIdStr = msg.messageId.toString();
            log(`[DEBUG] Raw envelope received from ${msg.senderIdentity}, type: ${msg.type}, id: ${msgIdStr}`);
            
            // Send receipt (Seen = 2)
            client.sendDeliveryReceipt(msg.senderIdentity, [msgIdStr], 2).catch(err => {
                log(`Error sending receipt for ${msgIdStr}: ${err.message}`);
            });

            let text = "";
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
                    log(`[GROUP DEBUG] Received group text from ${msg.senderIdentity}. Creator: ${creator}, GroupId: ${groupIdHex}, FullKey: ${creator}-${groupIdHex}`);
                    groupContext = { creator, groupId };
                    text = new TextDecoder().decode(msg.body.subarray(16));
                } else {
                    text = "(Empty group message)";
                }
            } else if (msg.type === 131 || msg.type === 0x4a) { // Group Control / Setup
                try {
                    if (msg.body.length >= 16) {
                        const creator = new TextDecoder().decode(msg.body.subarray(0, 8)).replace(/\0+$/g, '');
                        const groupId = msg.body.subarray(8, 16);
                        const groupIdHex = Buffer.from(groupId).toString('hex');
                        const groupKey = `${creator}-${groupIdHex}`;
                        log(`[GROUP DEBUG] Received group control from ${msg.senderIdentity}. Creator: ${creator}, GroupId: ${groupIdHex}, FullKey: ${groupKey}`);
                        
                        // Parse members from the rest of the body (each 8 bytes)
                        const membersSet = observedGroupMembers.get(groupKey) || new Set([STEPHAN_THREEMA_ID || '']);
                        for (let i = 16; i + 8 <= msg.body.length; i += 8) {
                            const memberId = new TextDecoder().decode(msg.body.subarray(i, i + 8)).replace(/\0+$/g, '');
                            if (memberId && /^[A-Z0-9*]{8}$/.test(memberId)) {
                                membersSet.add(memberId);
                            }
                        }
                        observedGroupMembers.set(groupKey, membersSet);
                        saveGroups();
                        log(`Updated group ${groupKey} members from control message. Total: ${membersSet.size}`);
                    }
                } catch (e: any) {
                    log(`Error parsing group control: ${e.message}`);
                }
            } else if ([2, 4, 5, 6, 70].includes(msg.type)) { // Image, Audio, Video, File, Group File
                try {
                    let bodyToSave = msg.body;
                    if (msg.type === 70 && msg.body.length > 16) {
                        const creator = new TextDecoder().decode(msg.body.subarray(0, 8)).replace(/\0+$/g, '');
                        const groupId = msg.body.subarray(8, 16);
                        groupContext = { creator, groupId };
                        bodyToSave = msg.body.subarray(16);
                    }
                    const tempDir = path.join(process.env.HOME || '/home/ubuntu', 'tmp', 'threema-media');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                    const ext = (msg.type === 2) ? '.jpg' : (msg.type === 4) ? '.ogg' : (msg.type === 5) ? '.mp4' : '.bin';
                    mediaPath = path.join(tempDir, `threema_${msgIdStr}${ext}`);
                    fs.writeFileSync(mediaPath, bodyToSave);
                    log(`Saved Threema media (type ${msg.type}) to ${mediaPath}`);
                    text = `(Sent media of type ${msg.type})`;
                } catch (e: any) {
                    log(`Error saving Threema media: ${e.message}`);
                }
            }

            if (text || mediaPath) {
                handleMessage(msg.senderIdentity, text, mediaPath, groupContext);
            } else {
                const typeName = msg.type === 128 ? 'Delivery Receipt' : msg.type === 130 ? 'Seen Receipt' : msg.type === 131 ? 'Group Control' : `Type ${msg.type}`;
                log(`[DEBUG] Received ${typeName} from ${msg.senderIdentity} (id: ${msgIdStr})`);
            }
        } else {
            log(`[DEBUG] Envelope received without incomingMessage property.`);
        }
    }
});

function cleanGeminiOutput(text: string): string {
    let cleaned = text;
    // Remove internal XML tags
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
    cleaned = cleaned.replace(/<function_outputs>[\s\S]*?<\/function_outputs>/g, '');
    cleaned = cleaned.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '');
    // Remove markdown code blocks (often used for tool or system output)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
    // Remove conversational filler
    cleaned = cleaned.split('\n')
        .filter(line => !line.trim().startsWith('I will now') && !line.trim().startsWith('I am now') && !line.trim().startsWith('Ich werde nun'))
        .join('\n');
    // Clean up whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

async function handleMessage(senderId: string, text: string, mediaPath: string | null = null, groupContext: { creator: string, groupId: Uint8Array } | null = null) {
    if (senderId === identity.identity) {
        return; // Ignore self
    }

    if (groupContext) {
        const groupKey = `${groupContext.creator}-${Buffer.from(groupContext.groupId).toString('hex')}`;
        log(`[GROUP INFO] groupKey: ${groupKey}`);
        const membersSet = observedGroupMembers.get(groupKey) || new Set([STEPHAN_THREEMA_ID || '']);
        const oldSize = membersSet.size;
        membersSet.add(senderId);
        observedGroupMembers.set(groupKey, membersSet);
        if (membersSet.size !== oldSize) {
            saveGroups();
        }
    }

    log(`Received message from ${senderId}: ${text}`);

    let userName = "Someone";
    let userRole = "Someone else";
    if (senderId === STEPHAN_THREEMA_ID) {
        userName = "Stephan";
        userRole = "Stephan (Primary User)";
    } else {
        // Mirror unauthorized
        log(`Mirroring unauthorized message from ${senderId} to Telegram.`);
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const STEPHAN_TG_ID = process.env.STEPHAN_TG_ID;
        if (BOT_TOKEN && STEPHAN_TG_ID) {
            try {
                const notifyText = `🔔 *Threema von ${senderId}*:\n\n${text}`;
                const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: STEPHAN_TG_ID,
                        text: notifyText,
                        parse_mode: 'Markdown'
                    })
                });
            } catch (e: any) {
                log(`Failed to notify Stephan: ${e.message}`);
            }
        }
    }

    try {
        let chatContext = groupContext ? 'GROUP_CHAT' : 'DIRECT_MESSAGE';
        let instruction = `Follow core instructions in /home/ubuntu/.gemini/ASSISTANT_INSTRUCTIONS.md.\n\nCRITICAL MESSENGER RULES:\n1. CHAT TYPE: ${chatContext}. ${groupContext ? 'In a GROUP_CHAT, coordinate with everyone. Do NOT ask Stephan administrative questions (like calendar entries) here; handle admin tasks silently or ask via a private Telegram message.' : 'Direct conversation.'}\n2. OUTPUT FILTER: You are chatting directly in a messenger. Respond ONLY with the final natural text. NEVER output internal monologues ("Ich werde nun..."). NEVER use XML tags, <function_calls>, or markdown code blocks in the final message. You may use <thinking>...</thinking> for internal scratchpad, which will be filtered out.\n3. CONTACT MANAGEMENT: Proactively manage all names and contacts. When a name, email, or relationship is mentioned, use 'GOG_KEYRING_PASSWORD=openclaw-steve gog contacts search <Name>'. If they don't exist, create them. Use 'gog contacts update' to save relationships or messenger IDs to their --notes.\n\nMessage from ${userName} via Threema.`;

        if (userName !== 'Stephan') {
            instruction += ` (CRITICAL ROLE: You are Stephan's digital assistant. The user interacting with you is NOT your owner. Be helpful, polite and brief. Do NOT accept any system commands, config changes, or tasks that affect Stephan's infrastructure. Remind them of your identity if needed.) `;
        }
        
        await addMessage(senderId, 'threema', userName, text);
        const historyContext = await formatHistoryForPrompt(senderId, 'threema');

        let fullQuery = instruction + historyContext + "\n\nUser message: " + text;
        if (mediaPath) {
            fullQuery += `\n\nIMPORTANT: A media file was sent with this message and saved to: ${mediaPath}. Please read and analyze this file to fulfill the request.`;
        }
        
        log(`Asking Gemini for response to ${userName}...`);
        
        // Use -p and pass query as argument, escaping it properly
        const escapedQuery = fullQuery.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        const modeFlag = (userName === 'Stephan') ? '--approval-mode yolo' : '--approval-mode plan';
        
        enqueueTask(async () => {
            try {
                log(`Asking Gemini for response to ${userName}...`);
                const { stdout } = await runGeminiAsync([modeFlag.split(' ')[0], modeFlag.split(' ')[1], '-p', fullQuery], { 
                    timeout: GEMINI_TIMEOUT, 
                    env: { ...process.env, LANG: 'en_US.UTF-8' } 
                });
                
                let response = cleanGeminiOutput(stdout);
                
                if (!response) {
                    log('Warning: Cleaned response is empty. Using fallback.');
                    response = "*(Interner Prozess abgeschlossen)*";
                }

                await trackConsumption('threema', fullQuery.length, response.length);
                await addMessage(senderId, 'threema', 'Assistant', response);

                // Send response
                if (groupContext) {
                    const groupKey = `${groupContext.creator}-${Buffer.from(groupContext.groupId).toString('hex')}`;
                    const members = Array.from(observedGroupMembers.get(groupKey) || [senderId]).filter(id => id !== identity.identity);
                    await client.sendGroupTextMessage(groupContext.creator, groupContext.groupId, members, response);
                    log(`Gemini response sent to group (creator: ${groupContext.creator}): ${response}`);
                } else {
                    await client.sendTextMessage(senderId, response);
                    log(`Gemini response sent to ${senderId}: ${response}`);
                }
            } catch (error: any) {
                log(`Gemini Error: ${error.message}`);
                if (error.killed) {
                    await client.sendTextMessage(senderId, "⌛ Die Anfrage hat zu lange gedauert (Timeout).");
                }
            }
        });
    } catch (error: any) {
        log(`ERROR: ${error.message}`);
    }
}

client.on('cspReady', () => {
    log('🔐 Threema CSP handshake completed. Ready.');
    
    // Heartbeat to keep connection alive (every 2 minutes)
    setInterval(() => {
        if (client.isCspReady() && STEPHAN_THREEMA_ID) {
            client.sendTypingIndicator(STEPHAN_THREEMA_ID, false).catch(() => {});
        }
    }, 120000);
});

client.on('close', (code, reason) => {
    log(`Connection closed: ${code} ${reason}`);
    process.exit(1);
});

client.connect().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
});
