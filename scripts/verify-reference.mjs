import { readFileSync } from 'node:fs';
import { verifyReferenceJournal } from '../src/reference-journal.mjs';

// Pin a separately obtained SPKI base64 key, or a key metadata JSON file.
const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args[0] !== '--key' || args[2] !== '--record') throw new Error();
  const raw = readFileSync(args[1], 'utf8').trim();
  const trustedPublicKey = raw.startsWith('{') ? JSON.parse(raw).publicKey : raw;
  const record = JSON.parse(readFileSync(args[3], 'utf8'));
  const result = verifyReferenceJournal({ events: record.events, trustedPublicKey,
    ledger: record.ledger, workflowId: record.workflowId, operationId: record.operationId });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.valid ? 0 : 1;
} catch {
  process.stderr.write('Use: node scripts/verify-reference.mjs --key pinned-key.json --record exported-record.json\n');
  process.exitCode = 2;
}
