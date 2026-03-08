const { spawn } = require('child_process');
require('dotenv').config({ path: '/home/ubuntu/threema-gemini-skill/.env' });

const THREEMA_ID = process.env.THREEMA_ID;
const THREEMA_CLIENT_KEY = process.env.THREEMA_CLIENT_KEY;
const BRIDGE_PATH = '/home/ubuntu/threema-gemini-skill/rust-bridge/target/release/threema-gemini-bridge';

const bridge = spawn(BRIDGE_PATH, [
    '--consumer', 'production',
    '--threema-id', THREEMA_ID,
    '--client-key', THREEMA_CLIENT_KEY,
    '--csp-server-group', '16'
]);

bridge.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const output = JSON.parse(line);
            if (output.type === 'HandshakeComplete') {
                console.log("Connected. Sending message...");
                bridge.stdin.write(JSON.stringify({ 
                    type: 'SendMessage', 
                    recipient: process.env.STEPHAN_THREEMA_ID, 
                    text: 'Hallo Stephan! Hier ist ein erneuter Versuch der Threema-Nachricht. Der Listener läuft nun im Hintergrund. Dein digitaler Assistent.' 
                }) + '\n');
                
                // Wait longer (10 seconds) to ensure delivery
                setTimeout(() => {
                    console.log("Message delivery window closed. Exiting.");
                    bridge.kill();
                    process.exit(0);
                }, 10000);
            }
        } catch (e) {}
    }
});

bridge.stderr.on('data', (data) => {
    console.error(`Bridge Error: ${data.toString()}`);
});

bridge.on('close', (code) => {
    console.log(`Bridge process exited with code ${code}`);
});
