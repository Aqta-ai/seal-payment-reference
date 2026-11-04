// Offline integrity check for this reference profile. This is not ATTESTATION-v1.
const PROFILE = 'SEAL-REFERENCE-EVENT-v1';
const ZERO = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAYLOAD_KEYS = ['workflowId', 'operationId', 'sequence', 'previousHash', 'timestamp', 'type', 'details'];
const utf8 = new TextEncoder();

class ReferenceFailure extends Error {
  constructor(code, message) { super(message); this.referenceCode = code; }
}
function reject(code, message) { throw new ReferenceFailure(code, message); }

function canonical(value) {
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

function validPayload(p) {
  return p && typeof p === 'object' && !Array.isArray(p)
    && Object.keys(p).length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every(k => Object.hasOwn(p, k))
    && typeof p.workflowId === 'string' && ID.test(p.workflowId)
    && typeof p.operationId === 'string' && ID.test(p.operationId)
    && Number.isSafeInteger(p.sequence) && p.sequence > 0
    && typeof p.previousHash === 'string' && HASH.test(p.previousHash)
    && typeof p.timestamp === 'string' && Number.isFinite(Date.parse(p.timestamp))
    && new Date(p.timestamp).toISOString() === p.timestamp
    && typeof p.type === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(p.type)
    && p.details && typeof p.details === 'object' && !Array.isArray(p.details);
}

function decode64(text, url = false) {
  const normal = url ? text.replace(/-/g, '+').replace(/_/g, '/') : text;
  const bytes = Uint8Array.from(atob(normal), c => c.charCodeAt(0));
  const encoded = btoa(String.fromCharCode(...bytes));
  if ((url ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encoded) !== text) throw new Error('Non-canonical reference encoding.');
  return bytes;
}

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', utf8.encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

/** The caller must supply its pinned key. Embedded keys are never trusted automatically. */
export async function verifyReferenceJournalBrowser({ events, trustedPublicKey, expectedHead, ledger, workflowId, operationId } = {}) {
  const errors = [];
  let failure, where;
  let head = ZERO, seenWorkflow = workflowId, seenOperation = operationId;
  const committed = [];
  try {
    if (typeof trustedPublicKey !== 'string' || trustedPublicKey.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trustedPublicKey)) reject('PIN_REQUIRED', 'A pinned Ed25519 reference key is required.');
    if (!globalThis.crypto?.subtle) reject('VERIFIER_UNAVAILABLE', 'Browser cryptography is unavailable.');
    const key = await crypto.subtle.importKey('spki', decode64(trustedPublicKey), { name: 'Ed25519' }, false, ['verify']);
    if (!Array.isArray(events) || !events.length || events.length > 10000) reject('VERIFICATION_INCOMPLETE', 'A non-empty reference journal is required.');
    for (const [index, event] of events.entries()) {
      // The place is reported from where the check stopped, never inferred from what was edited.
      where = { event: index + 1, ...(typeof event?.type === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(event.type) ? { type: event.type } : {}) };
      const proof = event?.proof, p = proof?.payload;
      if (!proof || proof.profile !== PROFILE || proof.publicKey !== trustedPublicKey || !validPayload(p)
        || Object.keys(proof).sort().join(',') !== 'eventHash,payload,profile,publicKey,signature') reject('VERIFICATION_INCOMPLETE', 'Invalid reference envelope.');
      seenWorkflow ??= p.workflowId; seenOperation ??= p.operationId;
      if (p.workflowId !== seenWorkflow || p.operationId !== seenOperation || p.sequence !== index + 1 || p.previousHash !== head) reject('VERIFICATION_INCOMPLETE', 'Reference sequence or workflow mismatch.');
      if (p.type !== event.type || p.timestamp !== event.at || canonical(p.details) !== canonical(event.details)) reject('VERIFICATION_INCOMPLETE', 'Displayed event differs from signed content.');
      if ((p.details.eventId !== undefined && p.details.eventId !== event.id)
        || (p.details.revision !== undefined && p.details.revision !== event.revision)) reject('VERIFICATION_INCOMPLETE', 'Event metadata differs from signed content.');
      if (typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) reject('VERIFICATION_INCOMPLETE', 'Invalid reference signature.');
      const signature = decode64(proof.signature, true);
      const envelope = { profile: proof.profile, payload: p, publicKey: proof.publicKey, signature: proof.signature };
      if (typeof proof.eventHash !== 'string' || !HASH.test(proof.eventHash)) reject('ENVELOPE_INVALID', 'Invalid reference event hash.');
      if (proof.eventHash !== await hash(envelope)) reject('HASH_MISMATCH', 'Reference event hash does not match.');
      if (!await crypto.subtle.verify('Ed25519', key, signature, utf8.encode(canonical({ profile: proof.profile, payload: p })))) reject('SIGNATURE_MISMATCH', 'Reference signature does not match.');
      if (p.type === 'payment_committed') {
        if (!p.details.payment || typeof p.details.payment !== 'object') reject('VERIFICATION_INCOMPLETE', 'Committed payment is missing.');
        committed.push(p.details.payment);
      }
      head = proof.eventHash;
    }
    where = { head: true };
    if (expectedHead !== undefined && (typeof expectedHead !== 'string' || !HASH.test(expectedHead) || expectedHead !== head)) reject('VERIFICATION_INCOMPLETE', 'Pinned journal head does not match.');
    where = { ledger: true };
    if (ledger !== undefined) {
      if (!Array.isArray(ledger)) reject('VERIFICATION_INCOMPLETE', 'A ledger array is required.');
      const ordered = rows => rows.map(row => canonical(row)).sort();
      if (canonical(ordered(ledger)) !== canonical(ordered(committed))) reject('VERIFICATION_INCOMPLETE', 'Exported ledger disagrees with signed commit events.');
      if (new Set(ledger.map(row => row.operationId)).size !== ledger.length) reject('VERIFICATION_INCOMPLETE', 'Duplicate operation in exported ledger.');
    }
  } catch (error) {
    const verdict = error instanceof ReferenceFailure;
    failure = { code: verdict ? error.referenceCode : 'VERIFICATION_INCOMPLETE' };
    if (!verdict) where = undefined; // A runtime exception is not evidence about any event.
    errors.push('Reference integrity could not be verified. Check the pinned key, records and exported ledger.');
  }
  return { valid: errors.length === 0, errors, head, completeness: 'not_established', ...(failure ? { failure, ...(where ? { where } : {}) } : {}) };
}
