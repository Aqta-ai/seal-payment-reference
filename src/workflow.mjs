import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CURRENCIES, PAYMENT_FIELDS, exactKeys as documentExactKeys, normaliseDocuments, numberedSources, sha256, sourceDigestOf, validateOriginalAuthority, validateReport, validateStoredDocuments } from './documents.mjs';
import { verifyReferenceJournal } from './reference-journal.mjs';
import { supplierNamesMatch } from '../supplier-name.js';

const SUPPLIER_ID = "harbour-print";
const ORIGINAL_ACCOUNT = "DE00-TEST-0000-1280";
const CHANGED_ACCOUNT = "DE00-TEST-0000-1289";
const APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const TUPLE_KEYS = ["operationId", "supplierId", "beneficiaryAccount", "amountMinor", "currency"];
const INTENT_KEYS = ["approvalId", ...TUPLE_KEYS];
const REVIEW_KEYS = ["reviewId", "digest", "expectedRevision"];
const PROVIDER_MODELS = Object.freeze({ meta: "muse-spark-1.3", wonder: "muse-wonder-1.0", baseten: "meta-models/muse-spark-open-1026" });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflows (
    workflow_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    CHECK (json_extract(record_json, '$.workflowId') = workflow_id),
    CHECK (json_extract(record_json, '$.operationId') = operation_id)
  );
  CREATE TABLE IF NOT EXISTS ledger (
    payment_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    operation_id TEXT NOT NULL UNIQUE,
    approval_id TEXT NOT NULL UNIQUE,
    supplier_id TEXT NOT NULL,
    beneficiary_account TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
    currency TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  );
`;

function copy(value) {
  return structuredClone(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validTuple(value, keys = TUPLE_KEYS) {
  return exactKeys(value, keys)
    && identifier(value.operationId)
    && identifier(value.supplierId)
    && typeof value.beneficiaryAccount === "string"
    && /^[A-Z0-9][A-Z0-9-]{4,63}$/.test(value.beneficiaryAccount)
    && Number.isSafeInteger(value.amountMinor)
    && value.amountMinor > 0
    && typeof value.currency === "string"
    && /^[A-Z]{3}$/.test(value.currency)
    && (keys !== INTENT_KEYS || identifier(value.approvalId));
}

function tupleOf(value) {
  return {
    operationId: value.operationId,
    supplierId: value.supplierId,
    beneficiaryAccount: value.beneficiaryAccount,
    amountMinor: value.amountMinor,
    currency: value.currency,
  };
}

function digestOf(tuple) {
  return createHash("sha256").update(JSON.stringify(tupleOf(tuple))).digest("hex");
}

function blocked(reasonCode, reason) {
  return { status: "blocked", reasonCode, reason, payment: null };
}

function unavailable() {
  return {
    status: "unavailable",
    reasonCode: "STORE_UNAVAILABLE",
    reason: "The local authority store is unavailable. Check the simulated ledger before retrying.",
    payment: null,
  };
}

function publicApproval(approval) {
  if (!approval) return null;
  const { expiresAtMs, createdAtMs, usedAtMs, ...values } = approval;
  return {
    ...values,
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAt: new Date(createdAtMs).toISOString(),
    usedAt: usedAtMs === null ? null : new Date(usedAtMs).toISOString(),
  };
}

/**
 * A local synthetic payment authority store, with no payment-provider effects.
 * Its transaction protects one SQLite ledger only. It makes no claim about
 * exactly-once execution across a production payment provider or service.
 */
export class WorkflowStore {
  #db = null;
  #now;
  #beforeInsert;
  #inTransaction = false;
  #referenceSigner;

  constructor({ filename = ":memory:", now = () => Date.now(), beforeInsert, referenceSigner } = {}) {
    this.#now = now;
    this.#beforeInsert = beforeInsert;
    this.#referenceSigner = referenceSigner;
    try {
      if (typeof now !== "function" || (beforeInsert !== undefined && typeof beforeInsert !== "function")) {
        throw new TypeError("Invalid store options.");
      }
      this.#db = new DatabaseSync(filename, { timeout: 5000 });
      this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.#db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    } catch {
      this.close();
    }
  }

  get referenceKey() {
    const signer = this.#referenceSigner;
    return signer ? { profile: 'SEAL-REFERENCE-EVENT-v1', publicKey: signer.publicKey, fingerprint: signer.fingerprint } : null;
  }

  close() {
    if (this.#inTransaction) return unavailable();
    try {
      this.#db?.close();
    } catch {
      // A closed or unavailable store remains closed to further authority use.
    }
    this.#db = null;
  }

  #transaction(action, write = true) {
    if (!this.#db || this.#inTransaction) return unavailable();
    let began = false;
    try {
      this.#db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      began = true;
      this.#inTransaction = true;
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch {
      if (began) {
        try { this.#db.exec("ROLLBACK"); } catch { /* Keep the error private. */ }
      }
      return unavailable();
    } finally {
      this.#inTransaction = false;
    }
  }

  #time() {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())
      || !Number.isFinite(new Date(value + APPROVAL_LIFETIME_MS).getTime())) {
      throw new TypeError("The authority clock is unavailable.");
    }
    return value;
  }

  #load(id) {
    const row = this.#db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(id);
    if (!row) return null;
    const record = JSON.parse(row.record_json);
    if (record.workflowId !== row.workflow_id || record.operationId !== row.operation_id
      || !identifier(record.workflowId) || !identifier(record.operationId)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || (record.version !== undefined && ![1, 2].includes(record.version))
      || (record.version === 2 ? record.scenario !== 'documents' : !["legitimate", "conflict"].includes(record.scenario))
      || (record.version !== 2 && (typeof record.invoiceText !== "string" || typeof record.supplierEmail !== "string"))
      || !Array.isArray(record.approvals) || !Array.isArray(record.events)) {
      throw new TypeError("Invalid stored workflow.");
    }
    const supplierId = record.version === 2 ? record.originalAuthority?.supplierId : SUPPLIER_ID;
    if (record.version === 2) this.#validateDocumentRecord(record);
    for (const approval of record.approvals) {
      if (!identifier(approval.id) || !validTuple(tupleOf(approval))
        || approval.operationId !== record.operationId || approval.supplierId !== supplierId
        || approval.workflowId !== record.workflowId || typeof approval.used !== "boolean"
        || typeof approval.superseded !== "boolean" || !Number.isSafeInteger(approval.expiresAtMs)
        || !Number.isSafeInteger(approval.createdAtMs)
        || !["seeded_fixture", "operator_review"].includes(approval.source)) {
        throw new TypeError("Invalid stored approval.");
      }
    }
    if (record.currentApprovalId !== null && !record.approvals.some((item) => item.id === record.currentApprovalId)) {
      throw new TypeError("Invalid current approval.");
    }
    const review = record.pendingReview;
    if (review !== null && (!identifier(review.reviewId) || !validTuple(review.tuple)
      || review.tuple.operationId !== record.operationId || review.tuple.supplierId !== supplierId
      || review.digest !== digestOf(review.tuple) || review.status !== "awaiting_human"
      || review.expectedRevision !== record.revision || review.revision !== record.revision)) {
      throw new TypeError("Invalid stored review.");
    }
    if (record.version === 2) {
      for (const approval of record.approvals) {
        const event = record.events.find(item => item.type === (approval.source === 'seeded_fixture' ? 'fixture_approval_seeded' : 'operator_approved') && item.details.approvalId === approval.id);
        if (!event || JSON.stringify(event.details.tuple) !== JSON.stringify(tupleOf(approval))) throw new TypeError('Stored approval differs from its signed event.');
        const { used, usedAtMs, superseded, ...immutable } = approval;
        const { used: initialUsed, usedAtMs: initialUsedAtMs, superseded: initialSuperseded, ...signed } = event.details.approval ?? {};
        const committed = record.events.find(item => item.type === 'payment_committed' && item.details.approvalId === approval.id);
        if (JSON.stringify(immutable) !== JSON.stringify(signed) || initialUsed !== false || initialUsedAtMs !== null || initialSuperseded !== false
          || used !== Boolean(committed) || usedAtMs !== (committed ? Date.parse(committed.at) : null)
          || superseded !== record.events.some(item => item.type === 'approval_requested' && item.details.supersededApprovalId === approval.id)) throw new TypeError('Stored approval lifecycle differs from signed events.');
      }
      if (review && (record.proposal?.status !== 'ready' || digestOf(review.tuple) !== digestOf(record.proposal.tuple))) throw new TypeError('Review differs from source-bound proposal.');
      let currentApprovalId = null, signedReview = null;
      for (const event of record.events) {
        if (['fixture_approval_seeded', 'operator_approved'].includes(event.type)) currentApprovalId = event.details.approvalId;
        if (event.type === 'approval_requested') { currentApprovalId = null; const { reviewId, digest, expectedRevision, revision, tuple, status } = event.details; signedReview = { reviewId, digest, expectedRevision, revision, tuple, status }; }
        if (['operator_approved', 'operator_declined'].includes(event.type)) signedReview = null;
        if (event.type === 'operator_declined') currentApprovalId = null;
      }
      if (currentApprovalId !== record.currentApprovalId || JSON.stringify(signedReview) !== JSON.stringify(record.pendingReview)
        || record.events.at(-1).details.revision !== record.revision) throw new TypeError('Stored authority state differs from signed events.');
      const ledger = this.#ledger(record);
      const verification = verifyReferenceJournal({ events: record.events, trustedPublicKey: this.#referenceSigner.publicKey, workflowId: record.workflowId, operationId: record.operationId, ledger });
      if (!verification.valid) throw new TypeError('The reference journal is invalid.');
    }
    return record;
  }

  #validateDocumentRecord(record) {
    if (!this.#referenceSigner || typeof this.#referenceSigner.signEvent !== 'function') throw new TypeError('A reference signer is required.');
    const authority = validateOriginalAuthority(record.originalAuthority);
    validateStoredDocuments(record.documents);
    if (record.sourceDigest !== sourceDigestOf(record.documents) || record.originalAuthorityDigest !== sha256(JSON.stringify(authority))) throw new TypeError('Invalid source or authority digest.');
    if (!record.events.length || record.events.some(event => event.details?.sourceDigest !== record.sourceDigest || event.details?.originalAuthorityDigest !== record.originalAuthorityDigest)) throw new TypeError('Journal source binding differs.');
    const created = record.events[0];
    if (created.type !== 'workflow_created' || JSON.stringify(created.details.originalAuthority) !== JSON.stringify(authority)
      || JSON.stringify(created.details.documents) !== JSON.stringify(record.documents)) throw new TypeError('Journal creation differs.');
    if (record.proposal !== null) {
      if (!record.proposal || record.proposal.sourceDigest !== record.sourceDigest || !['ready', 'needs_clarification'].includes(record.proposal.status)
        || record.proposalDigest !== sha256(JSON.stringify(record.proposal))) throw new TypeError('Invalid proposal binding.');
      const event = record.events.find(item => item.type === 'proposal_recorded');
      if (!event || event.details.proposalDigest !== record.proposalDigest || JSON.stringify(event.details.proposal) !== JSON.stringify(record.proposal)) throw new TypeError('Proposal differs from its event.');
      if (record.proposal.status === 'ready') {
        const checked = validateReport({ status: 'ready', candidate: record.proposal.candidate, questions: record.proposal.questions }, record.documents);
        const expected = this.#proposalTuple(record, checked);
        if (checked.status !== 'ready' || !supplierNamesMatch(checked.candidate.supplierName.value, authority.supplierName) || !validTuple(record.proposal.tuple)
          || JSON.stringify(expected) !== JSON.stringify(record.proposal.tuple)) throw new TypeError('Invalid stored ready proposal.');
      }
    } else if (record.proposalDigest !== null || record.events.some(event => event.type === 'proposal_recorded')) throw new TypeError('Invalid empty proposal digest.');
  }

  #proposalTuple(record, proposal) {
    return { operationId: record.operationId, supplierId: record.originalAuthority.supplierId,
      beneficiaryAccount: proposal.candidate.beneficiaryAccount.value, amountMinor: proposal.candidate.amountMinor.value, currency: proposal.candidate.currency.value };
  }

  #proposalRefusal(record, tuple) {
    if (record.version !== 2) return null;
    if (record.proposal?.status !== 'ready' || record.proposal.sourceDigest !== record.sourceDigest) return blocked('PROPOSAL_NOT_READY', 'Analyse complete source documents before proposing a payment. Clarification requires a new case.');
    if (!CURRENCIES.includes(tuple.currency) || digestOf(tuple) !== digestOf(record.proposal.tuple)) return blocked('PROPOSAL_MISMATCH', 'The attempted payment must match the current source-bound model proposal.');
    return null;
  }

  #save(record) {
    const result = this.#db.prepare("UPDATE workflows SET record_json = ? WHERE workflow_id = ?")
      .run(JSON.stringify(record), record.workflowId);
    if (result.changes !== 1) throw new Error("Workflow write failed.");
  }

  #event(record, type, at, details) {
    const event = { id: `evt_${randomUUID()}`, type, revision: record.revision, at: new Date(at).toISOString(), details: copy(details) };
    if (record.version === 2) {
      event.details = { ...event.details, eventId: event.id, revision: event.revision, sourceDigest: record.sourceDigest, originalAuthorityDigest: record.originalAuthorityDigest, proposalDigest: record.proposalDigest };
      const proof = this.#referenceSigner.signEvent({ workflowId: record.workflowId, operationId: record.operationId,
        sequence: record.events.length + 1, previousHash: record.events.at(-1)?.proof?.eventHash ?? '0'.repeat(64), timestamp: event.at, type, details: event.details });
      if (!proof || typeof proof.then === 'function' || typeof proof.eventHash !== 'string') throw new TypeError('The reference signer must complete synchronously.');
      event.proof = proof;
    }
    record.events.push(event);
  }

  #current(record) {
    return record.approvals.find((item) => item.id === record.currentApprovalId) ?? null;
  }

  #hasPayment(record) {
    return Boolean(this.#db.prepare("SELECT 1 FROM ledger WHERE operation_id = ?").get(record.operationId));
  }

  #ledger(record) {
    return this.#db.prepare("SELECT * FROM ledger WHERE workflow_id = ? ORDER BY committed_at, payment_id")
      .all(record.workflowId).map((row) => ({
        id: row.payment_id,
        workflowId: row.workflow_id,
        approvalId: row.approval_id,
        operationId: row.operation_id,
        supplierId: row.supplier_id,
        beneficiaryAccount: row.beneficiary_account,
        amountMinor: row.amount_minor,
        currency: row.currency,
        committedAt: new Date(row.committed_at).toISOString(),
      }));
  }

  #state(record) {
    const currentApproval = publicApproval(this.#current(record));
    const ledger = this.#ledger(record);
    if (record.version === 2) return copy({ workflowId: record.workflowId, operationId: record.operationId, revision: record.revision, version: 2,
      scenario: record.scenario, originalAuthority: record.originalAuthority, originalAuthoritySource: 'synthetic_case_input', originalAuthorityDigest: record.originalAuthorityDigest,
      documents: record.documents, sourceDigest: record.sourceDigest, proposal: record.proposal, proposalDigest: record.proposalDigest,
      approval: currentApproval, currentApproval, pendingReview: record.pendingReview, ledger, events: record.events,
      referenceJournal: { ...this.referenceKey, issuer: 'local_reference_signer', productionIssuer: false, attestationProfile: false,
        head: record.events.at(-1)?.proof?.eventHash ?? null, eventCount: record.events.length, completeness: 'not_established', approverIdentityEstablished: false } });
    return copy({
      workflowId: record.workflowId,
      operationId: record.operationId,
      revision: record.revision,
      scenario: record.scenario,
      invoiceText: record.invoiceText,
      supplierEmail: record.supplierEmail,
      approval: currentApproval,
      currentApproval,
      pendingReview: record.pendingReview,
      ledger,
      events: record.events,
    });
  }

  createWorkflow(options = {}) {
    return this.#transaction(() => {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return blocked("INVALID_SCENARIO", "Choose a supported synthetic scenario.");
      }
      if (options.version !== undefined && options.version !== 1) return blocked('UNSUPPORTED_VERSION', 'Choose a supported workflow version.');
      const { scenario = "legitimate" } = options;
      if (!["legitimate", "conflict"].includes(scenario)) return blocked("INVALID_SCENARIO", "Choose a supported synthetic scenario.");
      const at = this.#time();
      const workflowId = `wf_${randomUUID()}`;
      const operationId = `op_${randomUUID()}`;
      const tuple = { operationId, supplierId: SUPPLIER_ID, beneficiaryAccount: ORIGINAL_ACCOUNT, amountMinor: 25000000, currency: "EUR" };
      const requestedAccount = scenario === "conflict" ? CHANGED_ACCOUNT : ORIGINAL_ACCOUNT;
      const approval = {
        id: `apr_${randomUUID()}`,
        workflowId,
        ...tuple,
        source: "seeded_fixture",
        used: false,
        superseded: false,
        createdAtMs: at,
        expiresAtMs: at + APPROVAL_LIFETIME_MS,
        usedAtMs: null,
      };
      const record = {
        workflowId, operationId, revision: 1, scenario,
        invoiceText: `Synthetic invoice\nSupplier: Harbour Print\nSupplier ID: ${SUPPLIER_ID}\nOperation ID: ${operationId}\nAmount (minor units): 25000000\nCurrency: EUR\nBeneficiary account: ${ORIGINAL_ACCOUNT}`,
        supplierEmail: `Synthetic supplier message\nSupplier: Harbour Print\nSupplier ID: ${SUPPLIER_ID}\nOperation ID: ${operationId}\nPlease pay 25000000 minor units in EUR to ${requestedAccount}.`,
        currentApprovalId: approval.id,
        approvals: [approval],
        pendingReview: null,
        events: [],
      };
      this.#event(record, "workflow_created", at, { scenario, synthetic: true });
      this.#event(record, "fixture_approval_seeded", at, { approvalId: approval.id, source: "seeded_fixture" });
      this.#db.prepare("INSERT INTO workflows (workflow_id, operation_id, record_json) VALUES (?, ?, ?)")
        .run(workflowId, operationId, JSON.stringify(record));
      return this.#state(record);
    });
  }

  createDocumentWorkflow(options) {
    return this.#transaction(() => {
      if (!this.#referenceSigner || typeof this.#referenceSigner.signEvent !== 'function') return unavailable();
      if (!options || (options.version !== undefined && options.version !== 2)) return blocked('UNSUPPORTED_VERSION', 'Choose document workflow version 2.');
      const keys = Object.hasOwn(options, 'version') ? ['version', 'originalAuthority', 'documents'] : ['originalAuthority', 'documents'];
      if (!documentExactKeys(options, keys)) return blocked('INVALID_DOCUMENT_CASE', 'Provide only synthetic original authority and two text documents.');
      let originalAuthority, documents;
      try { originalAuthority = validateOriginalAuthority(options.originalAuthority); documents = normaliseDocuments(options.documents); }
      catch { return blocked('INVALID_DOCUMENT_CASE', 'Provide a valid synthetic supplier authority, invoice and instruction within the text limits.'); }
      const at = this.#time();
      const workflowId = `wf_${randomUUID()}`, operationId = `op_${randomUUID()}`;
      const { supplierName, ...values } = originalAuthority;
      const approval = { id: `apr_${randomUUID()}`, workflowId, operationId, ...values, source: 'seeded_fixture', used: false, superseded: false,
        createdAtMs: at, expiresAtMs: at + APPROVAL_LIFETIME_MS, usedAtMs: null };
      const record = { workflowId, operationId, version: 2, revision: 1, scenario: 'documents', originalAuthority, originalAuthorityDigest: sha256(JSON.stringify(originalAuthority)),
        documents, sourceDigest: sourceDigestOf(documents), proposal: null, proposalDigest: null, currentApprovalId: approval.id, approvals: [approval], pendingReview: null, events: [] };
      this.#event(record, 'workflow_created', at, { scenario: 'documents', synthetic: true, originalAuthoritySource: 'synthetic_case_input', originalAuthority, documents });
      this.#event(record, 'fixture_approval_seeded', at, { approvalId: approval.id, source: 'seeded_fixture', tuple: tupleOf(approval), approval: copy(approval) });
      this.#db.prepare('INSERT INTO workflows (workflow_id, operation_id, record_json) VALUES (?, ?, ?)').run(workflowId, operationId, JSON.stringify(record));
      return this.#state(record);
    });
  }

  recordProposal(id, proposal, expectedSourceDigest) {
    return this.#transaction(() => {
      if (!identifier(id)) return blocked('INVALID_WORKFLOW_ID', 'The workflow identifier is invalid.');
      const record = this.#load(id);
      if (!record) return blocked('WORKFLOW_NOT_FOUND', 'The workflow does not exist.');
      if (record.version !== 2) return blocked('UNSUPPORTED_VERSION', 'Document analysis requires workflow version 2.');
      if (expectedSourceDigest !== record.sourceDigest) return blocked('SOURCE_DIGEST_MISMATCH', 'The extraction belongs to different source documents. Create a fresh case.');
      if (record.proposal || record.pendingReview || this.#hasPayment(record) || record.approvals.some(approval => approval.source === 'operator_review')) return blocked('ANALYSIS_LOCKED', 'This case already has a recorded analysis or authority decision. Create a fresh case.');
      const rawReport = exactKeys(proposal, ['status', 'candidate', 'questions']);
      const extractedReport = (exactKeys(proposal, ['status', 'candidate', 'questions', 'referenceConsistency', 'analysis'])
        || exactKeys(proposal, ['status', 'candidate', 'questions', 'referenceConsistency']))
        && typeof proposal.referenceConsistency === 'boolean' && ['ready', 'needs_clarification'].includes(proposal.status);
      const report = rawReport || extractedReport ? proposal : null;
      const checked = validateReport(report ? { status: extractedReport && proposal.status === 'needs_clarification' ? 'ambiguous' : proposal.status,
        candidate: proposal.candidate, questions: proposal.questions } : null, record.documents);
      if (checked.status === 'ready' && !supplierNamesMatch(checked.candidate.supplierName.value, record.originalAuthority.supplierName)) {
        checked.status = 'needs_clarification';
        checked.questions = ['The proposed supplier differs from the trusted supplier binding. Confirm the supplier in a new case.'];
      }
      const analysis = this.#analysisProvenance(report?.analysis, record.sourceDigest);
      record.proposal = { ...checked, sourceDigest: record.sourceDigest, tuple: checked.status === 'ready' ? this.#proposalTuple(record, checked) : null, analysis };
      record.proposalDigest = sha256(JSON.stringify(record.proposal));
      record.revision += 1;
      this.#event(record, 'proposal_recorded', this.#time(), { proposal: record.proposal });
      this.#save(record);
      return this.#state(record);
    });
  }

  #analysisProvenance(value, sourceDigest) {
    if (!value || value.stage !== 'document_extraction' || !Object.hasOwn(PROVIDER_MODELS, value.provider)
      || value.model !== PROVIDER_MODELS[value.provider] || value.sourceDigest !== sourceDigest || value.requestCount !== 1) return null;
    const usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isSafeInteger(value.usage?.[key]) && value.usage[key] >= 0) usage[key] = value.usage[key];
    return { stage: 'document_extraction', provider: value.provider, model: value.model, sourceDigest, requestCount: 1,
      referenceValidation: 'literal_source_consistency_only', traceScope: 'limited_extraction_provenance', usage,
      latencyMs: Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : null };
  }

  /** Summaries for the workspace views. Read-only; authority stays in each record. */
  listWorkflows(limit = 100, workflowIds = null) {
    return this.#transaction(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return blocked("INVALID_LIMIT", "Choose a limit from 1 to 500.");
      if (workflowIds !== null && (!Array.isArray(workflowIds) || workflowIds.length > 100 || !workflowIds.every(identifier))) return blocked("INVALID_WORKFLOW_LIST", "Choose valid saved workflows.");
      const rows = workflowIds === null
        ? this.#db.prepare("SELECT workflow_id FROM workflows ORDER BY rowid DESC LIMIT ?").all(limit)
        : workflowIds.slice(0, limit).map(workflow_id => ({ workflow_id }));
      const workflows = [];
      for (const { workflow_id: id } of rows) {
        const record = this.#load(id);
        if (!record) continue;
        const ledger = this.#ledger(record);
        const has = type => record.events.some(event => event.type === type);
        const review = record.pendingReview?.status === "awaiting_human" ? record.pendingReview : null;
        const tuple = review?.tuple ?? this.#current(record) ?? null;
        const status = ledger.length ? "paid" : review ? "needs_review" : has("operator_declined") ? "declined"
          : has("operator_approved") ? "approved" : has("payment_blocked") ? "refused" : "new";
        workflows.push(copy({
          workflowId: record.workflowId, version: record.version === 2 ? 2 : 1, scenario: record.scenario ?? null, status,
          supplierName: record.originalAuthority?.supplierName ?? "Harbour Print",
          beneficiaryAccount: tuple?.beneficiaryAccount ?? null, amountMinor: tuple?.amountMinor ?? null, currency: tuple?.currency ?? null,
          refusedAttempts: record.events.filter(event => event.type === "payment_blocked").length,
          createdAt: record.events[0]?.at ?? null, updatedAt: record.events.at(-1)?.at ?? null, ledger,
        }));
      }
      return { workflows };
    }, false);
  }

  state(id) {
    return this.#transaction(() => {
      if (!identifier(id)) return blocked("INVALID_WORKFLOW_ID", "The workflow identifier is invalid.");
      const record = this.#load(id);
      return record ? this.#state(record) : blocked("WORKFLOW_NOT_FOUND", "The workflow does not exist.");
    }, false);
  }

  readDocuments(id) {
    const state = this.state(id);
    if (!state.workflowId) return state;
    if (state.version === 2) return { version: 2, workflowId: state.workflowId, operationId: state.operationId, revision: state.revision,
      sourceDigest: state.sourceDigest, sources: numberedSources(state.documents), documents: state.documents, proposal: state.proposal,
      currentApproval: state.currentApproval, pendingReview: state.pendingReview, referenceValidation: 'literal_source_consistency_only' };
    return {
      workflowId: state.workflowId,
      operationId: state.operationId,
      revision: state.revision,
      invoiceText: state.invoiceText,
      supplierEmail: state.supplierEmail,
      currentApproval: state.currentApproval,
      pendingReview: state.pendingReview,
      invoice: { operationId: state.operationId, supplierId: SUPPLIER_ID, beneficiaryAccount: ORIGINAL_ACCOUNT, amountMinor: 25000000, currency: "EUR" },
      supplierRequest: { operationId: state.operationId, supplierId: SUPPLIER_ID, beneficiaryAccount: state.scenario === "conflict" ? CHANGED_ACCOUNT : ORIGINAL_ACCOUNT, amountMinor: 25000000, currency: "EUR" },
    };
  }

  executePayment(id, intent) {
    return this.#transaction(() => {
      if (!identifier(id)) return blocked("INVALID_WORKFLOW_ID", "The workflow identifier is invalid.");
      if (!validTuple(intent, INTENT_KEYS)) return blocked("INVALID_INTENT", "Provide the exact payment intent schema with positive safe-integer minor units.");
      const record = this.#load(id);
      if (!record) return blocked("WORKFLOW_NOT_FOUND", "The workflow does not exist.");
      const at = this.#time();
      const refuse = (reasonCode, reason) => {
        this.#event(record, "payment_blocked", at, record.version === 2 ? { reasonCode, attemptedIntent: intent } : { reasonCode });
        this.#save(record);
        return blocked(reasonCode, reason);
      };
      const proposalRefusal = this.#proposalRefusal(record, intent);
      if (proposalRefusal) return refuse(proposalRefusal.reasonCode, proposalRefusal.reason);
      if (intent.operationId !== record.operationId) return refuse("OPERATION_MISMATCH", "The operation does not belong to this workflow.");
      if (intent.supplierId !== (record.version === 2 ? record.originalAuthority.supplierId : SUPPLIER_ID)) return refuse("SUPPLIER_MISMATCH", "The supplier does not belong to this invoice workflow.");
      if (this.#hasPayment(record)) return refuse("OPERATION_ALREADY_COMMITTED", "This operation already has a simulated payment.");
      const approval = record.approvals.find((item) => item.id === intent.approvalId);
      if (!approval) return refuse("APPROVAL_NOT_FOUND", "The approval does not exist in this workflow.");
      if (approval.superseded || record.currentApprovalId !== approval.id) return refuse("APPROVAL_SUPERSEDED", "The approval is no longer current. An operator decision is required.");
      if (approval.used) return refuse("APPROVAL_ALREADY_USED", "The approval has already been consumed.");
      if (approval.expiresAtMs <= at) return refuse("APPROVAL_EXPIRED", "The approval has expired.");
      for (const [key, reasonCode, label] of [
        ["operationId", "OPERATION_MISMATCH", "Operation"],
        ["supplierId", "SUPPLIER_MISMATCH", "Supplier"],
        ["beneficiaryAccount", "ACCOUNT_MISMATCH", "Beneficiary account"],
        ["amountMinor", "AMOUNT_MISMATCH", "Amount"],
        ["currency", "CURRENCY_MISMATCH", "Currency"],
      ]) {
        if (intent[key] !== approval[key]) return refuse(reasonCode, `${label} does not match the current approval.`);
      }
      const payment = Object.freeze({
        id: `pay_${randomUUID()}`,
        workflowId: record.workflowId,
        approvalId: approval.id,
        ...tupleOf(approval),
        committedAt: new Date(at).toISOString(),
      });
      approval.used = true;
      approval.usedAtMs = at;
      this.#save(record);
      // The optional synchronous hook exists only to test transaction rollback.
      const hookResult = this.#beforeInsert?.(payment);
      if (hookResult && typeof hookResult.then === "function") throw new TypeError("The test hook must be synchronous.");
      this.#db.prepare(`INSERT INTO ledger
        (payment_id, workflow_id, operation_id, approval_id, supplier_id, beneficiary_account, amount_minor, currency, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(payment.id, record.workflowId, approval.operationId, approval.id, approval.supplierId,
          approval.beneficiaryAccount, approval.amountMinor, approval.currency, at);
      record.revision += 1;
      this.#event(record, "payment_committed", at, record.version === 2 ? { paymentId: payment.id, approvalId: approval.id, operationId: record.operationId, attemptedIntent: intent, tuple: tupleOf(approval), payment: { ...payment } } : { paymentId: payment.id, approvalId: approval.id, operationId: record.operationId });
      this.#save(record);
      return { status: "committed", reasonCode: "PAYMENT_COMMITTED", reason: "The exact approved values were added to the simulated ledger.", payment: { ...payment } };
    });
  }

  requestApproval(id, tuple) {
    return this.#transaction(() => {
      if (!identifier(id)) return blocked("INVALID_WORKFLOW_ID", "The workflow identifier is invalid.");
      if (!validTuple(tuple)) return blocked("INVALID_TUPLE", "Provide the exact reviewed tuple with positive safe-integer minor units.");
      const record = this.#load(id);
      if (!record) return blocked("WORKFLOW_NOT_FOUND", "The workflow does not exist.");
      if (record.version === 2) {
        const refusal = this.#proposalRefusal(record, tuple);
        if (refusal) { this.#event(record, 'approval_request_blocked', this.#time(), { reasonCode: refusal.reasonCode, attemptedTuple: tuple }); this.#save(record); return refusal; }
      }
      if (tuple.operationId !== record.operationId) return blocked("OPERATION_MISMATCH", "The operation does not belong to this workflow.");
      if (tuple.supplierId !== (record.version === 2 ? record.originalAuthority.supplierId : SUPPLIER_ID)) return blocked("SUPPLIER_MISMATCH", "The supplier does not belong to this invoice workflow.");
      if (this.#hasPayment(record)) return blocked("OPERATION_ALREADY_COMMITTED", "This operation already has a simulated payment.");
      const at = this.#time();
      const previous = this.#current(record);
      if (previous) previous.superseded = true;
      record.currentApprovalId = null;
      record.revision += 1;
      record.pendingReview = {
        reviewId: `rev_${randomUUID()}`,
        digest: digestOf(tuple),
        expectedRevision: record.revision,
        revision: record.revision,
        tuple: tupleOf(tuple),
        status: "awaiting_human",
      };
      this.#event(record, "approval_requested", at, { ...record.pendingReview, supersededApprovalId: previous?.id ?? null });
      this.#save(record);
      return { status: "awaiting_human", reasonCode: "HUMAN_REVIEW_REQUIRED", reason: "The exact tuple is waiting for a local operator decision.", revision: record.revision, currentApproval: null, pendingReview: copy(record.pendingReview), payment: null };
    });
  }

  /** Local operator action. This method must never be exposed as a model tool. */
  approve(id, decision) {
    return this.#decide(id, decision, true);
  }

  /** Local operator action. This method must never be exposed as a model tool. */
  decline(id, decision) {
    return this.#decide(id, decision, false);
  }

  #decide(id, decision, accepted) {
    return this.#transaction(() => {
      if (!identifier(id)) return blocked("INVALID_WORKFLOW_ID", "The workflow identifier is invalid.");
      const record = this.#load(id);
      if (!record) return blocked("WORKFLOW_NOT_FOUND", "The workflow does not exist.");
      const review = record.pendingReview;
      if (!exactKeys(decision, REVIEW_KEYS) || !review || decision.reviewId !== review.reviewId
        || decision.digest !== review.digest || decision.expectedRevision !== review.expectedRevision
        || decision.expectedRevision !== record.revision) {
        return blocked("STALE_REVIEW", "The reviewed values have changed or this review is no longer pending.");
      }
      if (this.#hasPayment(record)) return blocked("OPERATION_ALREADY_COMMITTED", "This operation already has a simulated payment.");
      const refusal = this.#proposalRefusal(record, review.tuple);
      if (refusal) return refusal;
      const at = this.#time();
      record.revision += 1;
      record.pendingReview = null;
      if (accepted) {
        const approval = {
          id: `apr_${randomUUID()}`,
          workflowId: record.workflowId,
          ...tupleOf(review.tuple),
          source: "operator_review",
          reviewId: review.reviewId,
          digest: review.digest,
          used: false,
          superseded: false,
          createdAtMs: at,
          expiresAtMs: at + APPROVAL_LIFETIME_MS,
          usedAtMs: null,
        };
        record.approvals.push(approval);
        record.currentApprovalId = approval.id;
        this.#event(record, "operator_approved", at, { reviewId: review.reviewId, digest: review.digest, approvalId: approval.id, tuple: review.tuple, ...(record.version === 2 ? { approval: copy(approval) } : {}) });
      } else {
        record.currentApprovalId = null;
        this.#event(record, "operator_declined", at, record.version === 2 ? { reviewId: review.reviewId, digest: review.digest, tuple: review.tuple } : { reviewId: review.reviewId, digest: review.digest });
      }
      this.#save(record);
      return {
        status: accepted ? "approved" : "declined",
        reasonCode: accepted ? "OPERATOR_APPROVED" : "OPERATOR_DECLINED",
        reason: accepted ? "A fresh approval covers only the exact reviewed tuple." : "The operator declined this tuple. No payment was committed.",
        revision: record.revision,
        currentApproval: publicApproval(this.#current(record)),
        pendingReview: null,
        payment: null,
      };
    });
  }
}
