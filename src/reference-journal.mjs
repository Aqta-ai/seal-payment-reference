import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const REFERENCE_PROFILE = 'SEAL-REFERENCE-EVENT-v1';
const ZERO = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAYLOAD_KEYS = ['workflowId', 'operationId', 'sequence', 'previousHash', 'timestamp', 'type', 'details'];

/** Canonical JSON for this declared reference profile, not ATTESTATION-v1. */
export function canonicalJson(value) {
  let nodes = 0;
  function encode(item, depth = 0) {
    if (++nodes > 20000 || depth > 32) throw new TypeError('Reference value is too large.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${Array.from(item, child => encode(child, depth + 1)).join(',')}]`;
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
    }
    throw new TypeError('Reference values must be JSON.');
  }
  return encode(value);
}

export const referenceHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function payloadValid(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every(key => Object.hasOwn(payload, key))
    && typeof payload.workflowId === 'string' && ID.test(payload.workflowId)
    && typeof payload.operationId === 'string' && ID.test(payload.operationId)
    && Number.isSafeInteger(payload.sequence) && payload.sequence > 0
    && HASH.test(payload.previousHash) && typeof payload.timestamp === 'string'
    && Number.isFinite(Date.parse(payload.timestamp)) && new Date(payload.timestamp).toISOString() === payload.timestamp
    && typeof payload.type === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(payload.type)
    && payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details);
}

function publicKeyOf(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 256) throw new TypeError('Invalid reference key.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new TypeError('Invalid reference key.');
  const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Invalid reference key type.');
  return key;
}

export function createReferenceSigner({ privateKeyPem } = {}) {
  const key = privateKeyPem ? createPrivateKey(privateKeyPem) : generateKeyPairSync('ed25519').privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Use an Ed25519 reference key.');
  const bytes = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const publicKey = bytes.toString('base64');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    profile: REFERENCE_PROFILE, publicKey, fingerprint,
    signEvent(payload) {
      if (!payloadValid(payload)) throw new TypeError('Invalid reference event.');
      const copied = JSON.parse(canonicalJson(payload));
      const signature = sign(null, Buffer.from(canonicalJson({ profile: REFERENCE_PROFILE, payload: copied })), key).toString('base64url');
      const envelope = { profile: REFERENCE_PROFILE, payload: copied, publicKey, signature };
      return { ...envelope, eventHash: referenceHash(envelope) };
    },
  });
}

/** Only trusted startup code supplies this path. It is never an HTTP upload. */
export function loadReferenceSigner(filename) {
  if (typeof filename !== 'string' || !filename) throw new TypeError('A private reference-key path is required.');
  mkdirSync(dirname(filename), { recursive: true });
  if (!existsSync(filename)) {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    let fd;
    try {
      fd = openSync(filename, 'wx', 0o600);
      writeFileSync(fd, pem); fsyncSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error('Reference key must be a private 0600 file.');
    return createReferenceSigner({ privateKeyPem: readFileSync(fd, 'utf8') });
  } finally { closeSync(fd); }
}

/** Integrity under a separately pinned reference key. A valid prefix is possible. */
export function verifyReferenceJournal({ events, trustedPublicKey, expectedHead, ledger, workflowId, operationId } = {}) {
  const errors = [];
  let head = ZERO, seenWorkflow = workflowId, seenOperation = operationId;
  const committed = [];
  try {
    const key = publicKeyOf(trustedPublicKey);
    if (!Array.isArray(events) || !events.length || events.length > 10000) throw new Error('A non-empty reference journal is required.');
    for (const [index, event] of events.entries()) {
      const proof = event?.proof;
      const payload = proof?.payload;
      if (!proof || proof.profile !== REFERENCE_PROFILE || proof.publicKey !== trustedPublicKey || !payloadValid(payload)
        || Object.keys(proof).sort().join(',') !== 'eventHash,payload,profile,publicKey,signature') throw new Error('Invalid reference envelope.');
      seenWorkflow ??= payload.workflowId; seenOperation ??= payload.operationId;
      if (payload.workflowId !== seenWorkflow || payload.operationId !== seenOperation
        || payload.sequence !== index + 1 || payload.previousHash !== head) throw new Error('Reference sequence or workflow mismatch.');
      if (payload.type !== event.type || payload.timestamp !== event.at || canonicalJson(payload.details) !== canonicalJson(event.details)) throw new Error('Displayed event differs from signed content.');
      if ((payload.details.eventId !== undefined && payload.details.eventId !== event.id)
        || (payload.details.revision !== undefined && payload.details.revision !== event.revision)) throw new Error('Event metadata differs from signed content.');
      if (typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)
        || Buffer.from(proof.signature, 'base64url').toString('base64url') !== proof.signature) throw new Error('Invalid reference signature.');
      const envelope = { profile: proof.profile, payload, publicKey: proof.publicKey, signature: proof.signature };
      if (!HASH.test(proof.eventHash) || proof.eventHash !== referenceHash(envelope)
        || !verify(null, Buffer.from(canonicalJson({ profile: proof.profile, payload })), key, Buffer.from(proof.signature, 'base64url'))) throw new Error('Reference signature or hash mismatch.');
      if (payload.type === 'payment_committed') {
        if (!payload.details.payment || typeof payload.details.payment !== 'object') throw new Error('Committed payment is missing.');
        committed.push(payload.details.payment);
      }
      head = proof.eventHash;
    }
    if (expectedHead !== undefined && (!HASH.test(expectedHead) || expectedHead !== head)) throw new Error('Pinned journal head does not match.');
    if (ledger !== undefined) {
      if (!Array.isArray(ledger)) throw new Error('A ledger array is required.');
      const order = rows => rows.map(row => canonicalJson(row)).sort();
      if (canonicalJson(order(ledger)) !== canonicalJson(order(committed))) throw new Error('Exported ledger disagrees with signed commit events.');
      if (new Set(ledger.map(row => row.operationId)).size !== ledger.length) throw new Error('Duplicate operation in exported ledger.');
    }
  } catch (error) { errors.push(error.message || 'Reference check could not finish.'); }
  return { valid: errors.length === 0, errors, head, completeness: 'not_established' };
}
