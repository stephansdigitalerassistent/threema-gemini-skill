const { spawn } = require('child_process');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { addMessage, formatHistoryForPrompt, trackConsumption } = require('/home/ubuntu/.gemini/skills/common/history');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const THREEMA_ID = process.env.THREEMA_ID;
const THREEMA_CLIENT_KEY = process.env.THREEMA_CLIENT_KEY;
const BRIDGE_PATH = path.join(__dirname, '../rust-bridge/target/release/threema-gemini-bridge');
const LOG_FILE = '/home/ubuntu/threema-listener.log';

if (!THREEMA_ID || !THREEMA_CLIENT_KEY) {
    console.error("Please set THREEMA_ID and THREEMA_CLIENT_KEY environment variables.");
    process.exit(1);
}

function log(msg) {
    const timestamp = new Date().toISOString();
    const fullMsg = `[${timestamp}] ${msg}\n`;
    process.stdout.write(fullMsg);
    fs.appendFileSync(LOG_FILE, fullMsg);
}

log("Starting Threema Gemini Bridge...");

const bridge = spawn(BRIDGE_PATH, [
    '--consumer', 'production',
    '--threema-id', THREEMA_ID,
    '--client-key', THREEMA_CLIENT_KEY,
    '--csp-server-group', '16' // Example server group
]);

bridge.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const output = JSON.parse(line);
            if (output.type === 'Message') {
                handleMessage(output);
            } else if (output.type === 'HandshakeComplete') {
                log("Handshake complete. Connected to Threema server.");
            }
        } catch (e) {
            log(`Bridge Output: ${line}`);
        }
    }
});

bridge.stderr.on('data', (data) => {
    log(`Bridge Error: ${data.toString()}`);
});

bridge.on('close', (code) => {
    log(`Bridge process exited with code ${code}`);
    process.exit(code);
});

async function handleMessage(msg) {
    const senderId = msg.sender;
    
    // Anti-loop guard: Ignore messages from our own bot ID
    if (senderId === THREEMA_ID) {
        log(`Ignored message from self (${THREEMA_ID}).`);
        return;
    }

    log(`Received message from ${senderId}: ${msg.text}`);

    const STEPHAN_THREEMA_ID = process.env.STEPHAN_THREEMA_ID;
    let userName = "Someone";
    let userRole = "Someone else";

    if (senderId === STEPHAN_THREEMA_ID) {
        userName = "Stephan";
        userRole = "Stephan (Primary User)";
    } else {
        // Mirror unauthorized messages to Telegram
        log(`Mirroring unauthorized message from ${senderId} to Telegram.`);
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const STEPHAN_TG_ID = process.env.STEPHAN_TG_ID;
        if (BOT_TOKEN && STEPHAN_TG_ID) {
            try {
                const text = `🔔 *Threema von ${senderId}*:\n\n${msg.text}`;
                exec(`curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" -d "chat_id=${STEPHAN_TG_ID}" -d "text=${encodeURIComponent(text)}" -d "parse_mode=Markdown"`);
            } catch (e) {
                log(`Failed to notify Stephan: ${e.message}`);
            }
        }
    }

    try {
        const instruction = `Follow core instructions in /home/ubuntu/ASSISTANT_INSTRUCTIONS.md. Message from ${userName} via Threema.`;
        
        addMessage(senderId, 'threema', userName, msg.text);
        const historyContext = formatHistoryForPrompt(senderId, 'threema');

        const fullQuery = instruction + historyContext + "\n\nUser message: " + msg.text;
        
        log(`Asking Gemini for response to ${userName}...`);
        exec(`/home/ubuntu/gemini-wrapper.js --approval-mode yolo -p "${fullQuery.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }, (error, stdout, stderr) => {
            if (error) {
                log(`Gemini Error: ${error.message}`);
                return;
            }
            let response = stdout.trim();

            trackConsumption('threema', fullQuery.length, response.length);
            addMessage(senderId, 'threema', 'Assistant', response);

            // Send response back to Threema
            bridge.stdin.write(JSON.stringify({ type: 'SendMessage', recipient: senderId, text: response }) + '\n');
            log(`Gemini response: ${response}`);
        });
    } catch (error) {
        log(`ERROR: ${error.message}`);
    }
}
