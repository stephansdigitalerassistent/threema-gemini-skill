import { EventEmitter } from 'node:events';

declare module 'threema-openclaw/src/mediator-client.js' {
    import { EventEmitter } from 'node:events';
    export class MediatorClient extends EventEmitter {
        constructor(options: any);
        connect(): Promise<void>;
        close(): Promise<void>;
        disconnect(): void;
        sendTextMessage(recipient: string, text: string): Promise<any>;
        sendGroupTextMessage(
            groupCreator: string,
            groupId: Uint8Array,
            memberIdentities: string[],
            text: string,
            options?: { requireCsp?: boolean }
        ): Promise<bigint>;
        sendGroupEditMessage(
            groupCreator: string,
            groupId: Uint8Array,
            memberIdentities: string[],
            editedMessageIdInput: bigint | string | number,
            text: string,
            options?: { requireCsp?: boolean }
        ): Promise<bigint>;
        createGroup(title: string, members: string[]): Promise<any>;
        isCspReady(): boolean;
        sendTypingIndicator(recipient: string, typing: boolean): Promise<any>;
        waitForLeaderAndCsp(timeoutMs?: number): Promise<void>;
    }
}

declare module 'threema-openclaw/src/runtime-paths.js' {
    export function resolveThreemaDataDir(identityPath: string): string;
    export function resolveThreemaIdentityPath(identityPath: string): string;
}

declare module 'threema-openclaw/src/rendezvous.js' {
    export function setupRendezvous(identity: any): Promise<any>;
}

declare module 'threema-openclaw/src/device-join.js' {
    export function runDeviceJoin(options: any): Promise<any>;
}

declare module 'threema-openclaw/src/rph-emoji.js' {
    export function rphToEmojiSequence(rph: any, count?: number): string[];
}
