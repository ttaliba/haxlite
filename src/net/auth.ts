/**
 * Player identity (docs/01 §4).
 *
 * Clients own an ECDSA P-256 key (`player_auth_key` = `idkey.<x>.<y>.<d>`,
 * JWK components in base64url). On join the host sends an 8-byte challenge;
 * the client answers with an auth blob:
 *
 * ```
 * u8   1                        (ignored by the host)
 * u16  L                        (big-endian)
 * L bytes signed = string x | string y | challenge (raw, rest of the L bytes)
 * rest = ECDSA P-256 / SHA-256 signature of `signed` (WebCrypto format, r||s)
 * ```
 *
 * The host (`ua.ri`) checks that the challenge matches byte for byte, imports
 * `{kty:'EC', crv:'P-256', x, y}` and verifies; success => `auth = x`
 * (haxlite: the canonical base64url re-encoding of x, see `verifyAuthBlob`).
 * Verification failure => `auth = null` but the player still joins (policy
 * `allowNullAuth`, default true for parity).
 */
import { webcrypto } from 'node:crypto';
import { Reader, Writer } from '../codec/index.js';

const subtle = webcrypto.subtle;
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const; // `ua.sg`
const SIGN_ALGORITHM = { name: 'ECDSA', hash: { name: 'SHA-256' } } as const; // `ua.ci`

/** Length of the join challenge (official: 8 bytes = f64 Math.random()). */
export const CHALLENGE_LENGTH = 8;

/**
 * New challenge. The official host writes `f64(Math.random())`; any 8 bytes
 * are accepted by clients, so haxlite uses 8 CSPRNG bytes (same length/format,
 * unpredictable).
 */
export function createChallenge(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH));
}

/**
 * Verifies an auth blob against the challenge that was sent. Resolves with
 * the public key `x` (the player's `auth`), rejects on any failure.
 */
export async function verifyAuthBlob(blob: Uint8Array, challenge: Uint8Array): Promise<string> {
  const r = new Reader(blob);
  r.u8();
  const signed = r.bytes(r.u16());
  const signature = r.bytes();
  const sr = new Reader(signed);
  const x = sr.string();
  const y = sr.string();
  const echoed = sr.bytes();
  if (echoed.length !== challenge.length) throw new Error('challenge mismatch');
  for (let i = 0; i < echoed.length; i++) if (echoed[i] !== challenge[i]) throw new Error('challenge mismatch');
  const key = await subtle.importKey(
    'jwk',
    { crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x, y },
    KEY_ALGORITHM,
    true,
    ['verify'],
  );
  const ok = await subtle.verify(SIGN_ALGORITHM, key, signature as Uint8Array<ArrayBuffer>, signed as Uint8Array<ArrayBuffer>);
  if (!ok) throw new Error('invalid signature');
  // `auth` is the canonical base64url of the key's x coordinate, NOT the string
  // the client sent: WebCrypto's JWK import is lenient (standard base64 `+/=`,
  // non-zero trailing bits in the last char, embedded whitespace...), so one
  // key could otherwise yield many distinct `auth` strings and dodge auth bans.
  // Re-exporting gives exactly the coordinate that was verified. Official
  // clients generate their key with `exportKey('jwk')`, which is already
  // canonical, so for them this equals `x` (parity with the official host /
  // node-haxball, which return `x` verbatim).
  const canonical = (await subtle.exportKey('jwk', key)).x;
  if (!canonical) throw new Error('invalid key');
  return canonical;
}

// ------------------------------------------------------------------ client side (tools/tests)

/** A player identity (what the official client keeps in `player_auth_key`). */
export interface PlayerIdentity {
  readonly x: string;
  readonly y: string;
  readonly d: string;
  readonly privateKey: webcrypto.CryptoKey;
}

/** Generates a fresh identity (`V.gp` in the client). */
export async function generateIdentity(): Promise<PlayerIdentity> {
  const pair = (await subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { x: jwk.x!, y: jwk.y!, d: jwk.d!, privateKey: pair.privateKey };
}

/** Parses `idkey.<x>.<y>.<d>` (`V.fp`). */
export async function identityFromKey(key: string): Promise<PlayerIdentity> {
  const parts = key.split('.');
  if (parts.length !== 4 || parts[0] !== 'idkey') throw new Error('Invalid id format');
  const [, x, y, d] = parts as [string, string, string, string];
  const privateKey = await subtle.importKey(
    'jwk',
    { crv: 'P-256', ext: true, key_ops: ['sign'], kty: 'EC', x, y, d },
    KEY_ALGORITHM,
    true,
    ['sign'],
  );
  return { x, y, d, privateKey };
}

/** `idkey.<x>.<y>.<d>` (`V.vs`). */
export function identityToKey(id: PlayerIdentity): string {
  return `idkey.${id.x}.${id.y}.${id.d}`;
}

/** Builds the signed auth blob for `challenge` (`V.ks`). */
export async function createAuthBlob(id: PlayerIdentity, challenge: Uint8Array): Promise<Uint8Array> {
  const w = new Writer(256);
  w.u8(1);
  const lenAt = w.pos;
  w.u16(0);
  const start = w.pos;
  w.string(id.x);
  w.string(id.y);
  w.bytes(challenge);
  const len = w.pos - start;
  w.setU16At(lenAt, len);
  const signed = w.copyBytes().subarray(start, start + len);
  const sig = new Uint8Array(await subtle.sign(SIGN_ALGORITHM, id.privateKey, signed as Uint8Array<ArrayBuffer>));
  w.bytes(sig);
  return w.copyBytes();
}
