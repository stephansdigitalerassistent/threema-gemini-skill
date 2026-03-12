import { setupRendezvous } from 'threema-openclaw/src/rendezvous.js';
import { runDeviceJoin } from 'threema-openclaw/src/device-join.js';
import { rphToEmojiSequence } from 'threema-openclaw/src/rph-emoji.js';
import { resolveThreemaDataDir, resolveThreemaIdentityPath } from 'threema-openclaw/src/runtime-paths.js';
import qrcode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(SKILL_ROOT, 'data');
process.env.THREEMA_DATA_DIR = DATA_DIR;

function rphToEmoji(rph: Uint8Array): string {
  const emojis = rphToEmojiSequence(rph, 3).join('   ');
  const hex = Buffer.from(rph).toString('hex');
  return `Trust symbols: ${emojis}\nRPH: ${hex.slice(0, 8)}...${hex.slice(-8)}`;
}

async function main() {
  console.log('=== Threema Device Linking (OpenClaw/Ibex) ===\n');
  const setup = await setupRendezvous();
  const qrPath = path.join(process.cwd(), 'threema_qr_new.png');
  await qrcode.toFile(qrPath, setup.joinUri);
  console.log('QR Code saved to:', qrPath);

  // Send to Stephan via Telegram
  try {
    const scriptPath = '/home/ubuntu/scripts/send-photo-to-stephan.js';
    const envStr = `TELEGRAM_BOT_TOKEN="${process.env.TELEGRAM_BOT_TOKEN}" STEPHAN_TG_ID="${process.env.STEPHAN_TG_ID}"`;
    execSync(`${envStr} node ${scriptPath} ${qrPath} "Hallo Stephan, hier ist der NEUE QR-Code für die Threema-Verbindung. Scanne ihn bitte in deiner Threema-App unter Einstellungen > Verbundene Geräte > Neues Gerät verknüpfen."`);
    console.log('QR Code sent to Stephan via Telegram.');
  } catch (err) {
    console.error('Failed to send QR code:', err.message);
  }

  console.log('\nWaiting for phone to scan...\n');
  const conn = await setup.connect();
  console.log('\n' + rphToEmoji(conn.rph));
  console.log('Verify this matches what your phone shows.\n');
  
  const result = await runDeviceJoin(conn);
  
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const identityFile = resolveThreemaIdentityPath(DATA_DIR);
  
  const identityData = {
    identity: result.identity,
    clientKey: Buffer.from(result.clientKey).toString('hex'),
    serverGroup: result.serverGroup,
    deviceGroupKey: Buffer.from(result.deviceGroupKey).toString('hex'),
    deviceCookie: Buffer.from(result.deviceCookie).toString('hex'),
    contactCount: result.contacts.length,
    groupCount: result.groups.length,
    linkedAt: new Date().toISOString(),
  };
  
  fs.writeFileSync(identityFile, JSON.stringify(identityData, null, 2));
  console.log(`\n✅ Identity saved to ${identityFile}`);
  
  const contactsFile = path.join(DATA_DIR, 'contacts.json');
  const contactData = result.contacts.map(c => ({
    identity: c.identity,
    publicKey: Buffer.from(c.publicKey).toString('hex'),
    firstName: c.firstName,
    lastName: c.lastName,
    nickname: c.nickname,
  }));
  fs.writeFileSync(contactsFile, JSON.stringify(contactData, null, 2));
  
  if (result.groups.length > 0) {
    const groupsFile = path.join(DATA_DIR, 'groups.json');
    fs.writeFileSync(groupsFile, JSON.stringify(result.groups, null, 2));
  }
  
  console.log('\n🎉 Device linked successfully!');
  
  // Final notification
  try {
    const scriptPath = '/home/ubuntu/scripts/send-to-stephan.js';
    const envStr = `TELEGRAM_BOT_TOKEN="${process.env.TELEGRAM_BOT_TOKEN}" STEPHAN_TG_ID="${process.env.STEPHAN_TG_ID}"`;
    execSync(`${envStr} node ${scriptPath} "Die Threema-Verbindung wurde erfolgreich hergestellt!"`);
  } catch (err) {
    console.error('Failed to send final notification:', err.message);
  }
  
  conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Error:', err);
  process.exit(1);
});
