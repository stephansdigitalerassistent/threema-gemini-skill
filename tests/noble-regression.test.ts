import { test, describe } from 'node:test';
import assert from 'node:assert';
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { chacha20poly1305, chacha20 } from '@noble/ciphers/chacha.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';


interface Blake2bTestVector {
  name: string;
  input: Uint8Array;
  dkLen: number;
  expected: string;
}

interface X25519TestVector {
  name: string;
  aliceSk: string;
  bobPk: string;
  expectedShared: string;
}

interface XSalsa20Poly1305TestVector {
  name: string;
  key: string;
  nonce: string;
  msg: Uint8Array;
  expected: string;
}

interface Poly1305TestVector {
  name: string;
  key: string;
  msg: Uint8Array;
  expected: string;
}

interface ChaCha20TestVector {
  name: string;
  key: Uint8Array;
  nonce: Uint8Array;
  msg: Uint8Array;
  expectedStart: string;
}

interface ChaCha20Poly1305TestVector {
  name: string;
  key: string;
  nonce: string;
  aad: string;
  plaintext: Uint8Array;
  expectedTag: string;
}

describe('Noble Regression Tests with Official Vectors', () => {
  describe('BLAKE2b-256', () => {
    const blake2bVectors: Blake2bTestVector[] = [
      {
        name: 'Empty input',
        input: new Uint8Array(0),
        dkLen: 32,
        expected: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
      },
      {
        name: 'Input "abc"',
        input: new TextEncoder().encode('abc'),
        dkLen: 32,
        expected: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
      },
    ];

    blake2bVectors.forEach((v) => {
      test(v.name, () => {
        const hash = blake2b(v.input, { dkLen: v.dkLen });
        assert.strictEqual(bytesToHex(hash), v.expected);
      });
    });
  });

  describe('X25519 (Curve25519)', () => {
    const x25519Vectors: X25519TestVector[] = [
      {
        name: 'Shared secret from libsodium vectors',
        aliceSk: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
        bobPk: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
        expectedShared: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
      },
    ];

    x25519Vectors.forEach((v) => {
      test(v.name, () => {
        const aliceSkBytes = hexToBytes(v.aliceSk);
        const bobPkBytes = hexToBytes(v.bobPk);
        const shared = x25519.getSharedSecret(aliceSkBytes, bobPkBytes);
        assert.strictEqual(bytesToHex(shared), v.expectedShared);
      });
    });
  });

  describe('XSalsa20Poly1305 (crypto_secretbox)', () => {
    const xsalsa20poly1305Vectors: XSalsa20Poly1305TestVector[] = [
      {
        name: 'libsodium crypto_secretbox vector',
        key: '1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389',
        nonce: '69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37',
        msg: new TextEncoder().encode('test'),
        expected: '07f360c987e5536e0eac2905d0b65bc044fb172e',
      },
    ];

    xsalsa20poly1305Vectors.forEach((v) => {
      test(v.name, () => {
        const keyBytes = hexToBytes(v.key);
        const nonceBytes = hexToBytes(v.nonce);
        const cipher = xsalsa20poly1305(keyBytes, nonceBytes);
        const ciphertext = cipher.encrypt(v.msg);
        assert.strictEqual(bytesToHex(ciphertext), v.expected);
      });
    });
  });

  describe('Poly1305', () => {
    const poly1305Vectors: Poly1305TestVector[] = [
      {
        name: 'RFC 8439 vector prefix',
        key: '85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abf46af12482307',
        msg: new TextEncoder().encode('Cryptographic Forum Research Group'),
        expected: 'a8061dc1305136c6c22bdbaeddff5494',
      },
    ];

    poly1305Vectors.forEach((v) => {
      test(v.name, () => {
        const keyBytes = hexToBytes(v.key);
        const tag = poly1305(v.msg, keyBytes);
        assert.strictEqual(bytesToHex(tag), v.expected);
      });
    });
  });

  describe('ChaCha20', () => {
    const chacha20Vectors: ChaCha20TestVector[] = [
      {
        name: 'libsodium Test Case 1 (Zero Key/Nonce IETF)',
        key: new Uint8Array(32),
        nonce: new Uint8Array(12),
        msg: new Uint8Array(64),
        expectedStart: '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586',
      },
    ];

    chacha20Vectors.forEach((v) => {
      test(v.name, () => {
        const output = chacha20(v.key, v.nonce, v.msg);
        assert.strictEqual(bytesToHex(output), v.expectedStart);
      });
    });
  });

  describe('ChaCha20Poly1305 (AEAD)', () => {
    const chacha20Poly1305Vectors: ChaCha20Poly1305TestVector[] = [
      {
        name: 'RFC 8439 A.5 vector tag',
        key: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
        nonce: '070000004041424344454647',
        aad: '50515253c0c1c2c3c4c5c6c7',
        plaintext: new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."),
        expectedTag: '1ae10b594f09e26a7e902ecbd0600691',
      },
    ];

    chacha20Poly1305Vectors.forEach((v) => {
      test(v.name, () => {
        const keyBytes = hexToBytes(v.key);
        const nonceBytes = hexToBytes(v.nonce);
        const aadBytes = hexToBytes(v.aad);
        const cipher = chacha20poly1305(keyBytes, nonceBytes, aadBytes);
        const ciphertextWithTag = cipher.encrypt(v.plaintext);
        const tag = ciphertextWithTag.slice(-16);
        assert.strictEqual(bytesToHex(tag), v.expectedTag);
      });
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
