---
name: threema-integration
description: Integration script to connect Gemini CLI to a Threema account using libthreema, allowing the CLI to respond to messages.
---
# Threema Integration Skill

## Overview
This skill provides a background script that connects your Gemini CLI to your Threema account. It listens for **all incoming messages** and uses the Gemini CLI to automatically respond to them.

## Prerequisites
The integration requires a compiled version of the `libthreema` CLI bridge and some Node.js packages.

### Install Node.js dependencies
```bash
npm install anyhow
```

### Build the Threema CLI bridge
The bridge is written in Rust. You need to have Rust and Cargo installed.
```bash
cd rust-bridge
cargo build --release
```

## How to use
### Configure credentials
You need to provide your Threema ID and Client Key. Set them as environment variables:
```bash
export THREEMA_ID="ABCDEFGH"
export THREEMA_CLIENT_KEY="0123456789abcdef..."
```

### Run the listener
Run the listener script provided in the `scripts` folder to handle incoming messages:
```bash
node scripts/listener.js
```

## Security
The bridge uses the official Threema for Android protocol implementation (`libthreema`), ensuring high security and privacy.

## Notes
- To prevent infinite loops, the script includes a check that ignores any messages you send manually.
- To keep the listener running in the background, consider using `pm2`.
