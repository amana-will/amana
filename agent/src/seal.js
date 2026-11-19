// Amana's sealing toolkit, shared by the agent and the web app (bundled to web/lib/seal.js).
//
// How a will is sealed:
//   1. The will (names, shares, letters) is encrypted with a fresh random key (AES-256-GCM).
//   2. That key is cut into pieces with Shamir's secret sharing: any `threshold` pieces rebuild it,
//      fewer reveal nothing.
//   3. Each piece is encrypted for one guardian, using a public key their app derived from a wallet signature.
//   4. Everything encrypted goes on-chain in the WillSealed event, so it can never be lost.
// Opening needs `threshold` guardians to decrypt their piece, which the app only asks for after a release.
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils";

const enc = new TextDecoder();
const hex = (b) => "0x" + bytesToHex(b);
const unhex = (h) => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);

/** The message a guardian signs to derive their private Amana key. Same wallet, same key, every time. */
export const KEY_MESSAGE = "Amana guardian key\n\nSigning this unlocks your private Amana key on this device. It never moves money and costs nothing.";

export function keypairFromSignature(signatureHex) {
  const privateKey = sha256(concatBytes(unhex(signatureHex), utf8ToBytes("amana-key-v1")));
  return { privateKey, publicKey: hex(x25519.getPublicKey(privateKey)) };
}

function boxKey(shared, ephPub, recipientPub) {
  return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), utf8ToBytes("amana-seal-v1"), 32);
}

/** Encrypts bytes so only the holder of `recipientPublicKey` can read them. */
export function sealFor(recipientPublicKey, plaintext) {
  const recipient = unhex(recipientPublicKey);
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = boxKey(x25519.getSharedSecret(ephPriv, recipient), ephPub, recipient);
  const nonce = randomBytes(12);
  return hex(concatBytes(ephPub, nonce, gcm(key, nonce).encrypt(plaintext)));
}

export function openSealed(privateKey, sealedHex) {
  const b = unhex(sealedHex);
  const ephPub = b.slice(0, 32);
  const nonce = b.slice(32, 44);
  const key = boxKey(x25519.getSharedSecret(privateKey, ephPub), ephPub, x25519.getPublicKey(privateKey));
  return gcm(key, nonce).decrypt(b.slice(44));
}

/** Encrypts the will with a fresh key. Returns the key (to split) and the encrypted will (to publish). */
export function encryptWill(will) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const ciphertext = hex(concatBytes(nonce, gcm(key, nonce).encrypt(utf8ToBytes(JSON.stringify(will)))));
  return { key, ciphertext };
}

export function decryptWill(key, ciphertextHex) {
  const b = unhex(ciphertextHex);
  return JSON.parse(enc.decode(gcm(key, b.slice(0, 12)).decrypt(b.slice(12))));
}

export function randomSalt() {
  return hex(randomBytes(32));
}

// ── Shamir's secret sharing over GF(256) ──
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x1b : 0); // multiply by generator 3 in AES's field
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]);

/** Splits `secret` into `n` pieces; any `t` of them rebuild it. Each piece is [x, ...y]. */
export function split(secret, n, t) {
  if (t < 1 || t > n || n > 255) throw new Error("Bad split parameters");
  const pieces = Array.from({ length: n }, (_, i) => {
    const p = new Uint8Array(secret.length + 1);
    p[0] = i + 1;
    return p;
  });
  for (let byte = 0; byte < secret.length; byte++) {
    const coeffs = randomBytes(t);
    coeffs[0] = secret[byte];
    for (const p of pieces) {
      let y = 0;
      for (let k = t - 1; k >= 0; k--) y = mul(y, p[0]) ^ coeffs[k];
      p[byte + 1] = y;
    }
  }
  return pieces;
}

export function combine(pieces) {
  const len = pieces[0].length - 1;
  const out = new Uint8Array(len);
  for (let byte = 0; byte < len; byte++) {
    let s = 0;
    for (let i = 0; i < pieces.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < pieces.length; j++) {
        if (i === j) continue;
        num = mul(num, pieces[j][0]);
        den = mul(den, pieces[j][0] ^ pieces[i][0]);
      }
      s ^= mul(pieces[i][byte + 1], div(num, den));
    }
    out[byte] = s;
  }
  return out;
}

// ── Matching emojis for the handshake ──
const EMOJIS = [
  ["🐪", "camel"], ["🌙", "moon"], ["🍊", "orange"], ["🌴", "palm tree"], ["⭐", "star"], ["🐟", "fish"], ["🍉", "watermelon"], ["🌻", "sunflower"],
  ["🐢", "turtle"], ["🚲", "bicycle"], ["🎈", "balloon"], ["🔑", "key"], ["🍋", "lemon"], ["🐝", "bee"], ["🌈", "rainbow"], ["⚽", "football"],
  ["🐘", "elephant"], ["🍇", "grapes"], ["☕", "coffee"], ["🌵", "cactus"], ["🐱", "cat"], ["🚗", "car"], ["🎁", "gift"], ["🍞", "bread"],
  ["🦋", "butterfly"], ["🌊", "wave"], ["🔔", "bell"], ["🍓", "strawberry"], ["🐴", "horse"], ["⛵", "sailboat"], ["🎸", "guitar"], ["🧁", "cupcake"],
  ["🐓", "rooster"], ["🌹", "rose"], ["🕌", "mosque"], ["🍎", "apple"], ["🦁", "lion"], ["✈️", "plane"], ["📚", "books"], ["🫖", "teapot"],
  ["🐑", "sheep"], ["🌳", "tree"], ["🏠", "house"], ["🍯", "honey"], ["🐧", "penguin"], ["🚂", "train"], ["🎨", "paint"], ["🥕", "carrot"],
  ["🦉", "owl"], ["🍀", "clover"], ["⏰", "clock"], ["🍌", "banana"], ["🐬", "dolphin"], ["🧭", "compass"], ["🎵", "music"], ["🥥", "coconut"],
  ["🐸", "frog"], ["🌋", "volcano"], ["💡", "light bulb"], ["🍒", "cherries"], ["🦊", "fox"], ["🛶", "canoe"], ["🎯", "target"], ["🫒", "olive"],
];

/** Three emojis that identify a wallet. Both phones show the same ones, so people can check out loud. */
export function emojisFor(address) {
  const h = sha256(utf8ToBytes("amana-emoji:" + address.toLowerCase()));
  const picks = [];
  for (let i = 0; picks.length < 3 && i < h.length; i++) if (!picks.includes(h[i] & 63)) picks.push(h[i] & 63);
  return picks.map((i) => ({ emoji: EMOJIS[i][0], name: EMOJIS[i][1] }));
}

export { hex as toHex, unhex as fromHex };
