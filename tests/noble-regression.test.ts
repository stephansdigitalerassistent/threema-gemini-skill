import { test, describe } from 'node:test';
import assert from 'node:assert';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { chacha20poly1305, chacha20 } from '@noble/ciphers/chacha.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

describe('Noble Regression Tests with Official Vectors', () => {
  describe('BLAKE2b-256', () => {
    test('Empty input', () => {
      const input = new Uint8Array(0);
      const hash = blake2b(input, { dkLen: 32 });
      const expected = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8';
      assert.strictEqual(bytesToHex(hash), expected);
    });

    test('Input "abc"', () => {
      const input = new TextEncoder().encode('abc');
      const hash = blake2b(input, { dkLen: 32 });
      // This is the value produced by @noble/hashes which matches its own reference
      const expected = 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319';
      assert.strictEqual(bytesToHex(hash), expected);
    });
  });

  describe('X25519 (Curve25519)', () => {
    test('Shared secret from libsodium vectors', () => {
      const aliceSk = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
      const bobPk = hexToBytes('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
      const expectedShared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

      const shared = x25519.getSharedSecret(aliceSk, bobPk);
      assert.strictEqual(bytesToHex(shared), expectedShared);
    });
  });

  describe('XSalsa20Poly1305 (crypto_secretbox)', () => {
    test('libsodium crypto_secretbox vector', () => {
      const key = hexToBytes('1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
      const nonce = hexToBytes('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37');
      const msg = new TextEncoder().encode('test');
      
      const cipher = xsalsa20poly1305(key, nonce);
      const ciphertext = cipher.encrypt(msg);
      
      // Values confirmed via tweetnacl and noble-ciphers consistency
      const expected = '07f360c987e5536e0eac2905d0b65bc044fb172e';
      assert.strictEqual(bytesToHex(ciphertext), expected);
    });
  });

  describe('Poly1305', () => {
    test('RFC 8439 vector prefix', () => {
      const key = hexToBytes('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abf46af12482307');
      const msg = new TextEncoder().encode('Cryptographic Forum Research Group');
      
      const tag = poly1305(msg, key);
      const expected = 'a8061dc1305136c6c22bdbaeddff5494';
      assert.strictEqual(bytesToHex(tag), expected);
    });
  });

  describe('ChaCha20', () => {
    test('libsodium Test Case 1 (Zero Key/Nonce IETF)', () => {
      const key = new Uint8Array(32);
      const nonce = new Uint8Array(12);
      const msg = new Uint8Array(64);
      
      const output = chacha20(key, nonce, msg);
      const expectedStart = '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586';
      assert.strictEqual(bytesToHex(output), expectedStart);
    });
  });

  describe('ChaCha20Poly1305 (AEAD)', () => {
    test('RFC 8439 A.5 vector tag', () => {
      const key = hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
      const nonce = hexToBytes('070000004041424344454647');
      const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7');
      const plaintext = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
      
      const cipher = chacha20poly1305(key, nonce, aad);
      const ciphertextWithTag = cipher.encrypt(plaintext);
      
      const expectedTag = '1ae10b594f09e26a7e902ecbd0600691';
      const tag = ciphertextWithTag.slice(-16);
      assert.strictEqual(bytesToHex(tag), expectedTag);
    });
  });

  test('hsalsa basic test', () => {
    const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    const key = new Uint32Array(8).fill(5);
    const nonce = new Uint32Array(4).fill(6);
    const out = new Uint32Array(8);
    hsalsa(sigma, key, nonce, out);
    assert.strictEqual(out.length, 8);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += out[i];
    assert.notStrictEqual(sum, 0);
  });
});
