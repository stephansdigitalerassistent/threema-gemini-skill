import { test, describe } from 'node:test';
import assert from 'node:assert';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

describe('Noble Regression Tests', () => {
  test('blake2b-256 basic test vector', () => {
    const input = new Uint8Array(0);
    const hash = blake2b(input, { dkLen: 32 });
    const expected = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8';
    assert.strictEqual(bytesToHex(hash), expected);
  });

  test('x25519 shared secret', () => {
    const privA = new Uint8Array(32).fill(1);
    const privB = new Uint8Array(32).fill(2);
    const pubA = x25519.getPublicKey(privA);
    const pubB = x25519.getPublicKey(privB);

    const sharedA = x25519.getSharedSecret(privA, pubB);
    const sharedB = x25519.getSharedSecret(privB, pubA);

    assert.deepStrictEqual(sharedA, sharedB);
    assert.strictEqual(sharedA.length, 32);
  });

  test('xsalsa20poly1305 encrypt/decrypt', () => {
    const key = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const msg = new TextEncoder().encode('Threema message');

    const cipher = xsalsa20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(msg);
    
    const decipher = xsalsa20poly1305(key, nonce);
    const decrypted = decipher.decrypt(ciphertext);

    assert.deepStrictEqual(decrypted, msg);
  });

  test('hsalsa basic test', () => {
    // Sigma constants for "expand 32-byte k"
    const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    const key = new Uint32Array(8).fill(5);
    const nonce = new Uint32Array(4).fill(6);
    const out = new Uint32Array(8);
    hsalsa(sigma, key, nonce, out);
    assert.strictEqual(out.length, 8);
    // Ensure something was written
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += out[i];
    assert.notStrictEqual(sum, 0);
  });

  test('chacha20poly1305 encrypt/decrypt', () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(12).fill(8);
    const msg = new TextEncoder().encode('Rendezvous message');

    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(msg);
    
    const decipher = chacha20poly1305(key, nonce);
    const decrypted = decipher.decrypt(ciphertext);

    assert.deepStrictEqual(decrypted, msg);
  });
});
