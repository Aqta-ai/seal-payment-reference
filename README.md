# Seal payment reference

A standalone reference demonstration for synthetic invoice payments. A model proposes a payment from an invoice and a later supplier instruction. A separate executor checks the exact authority, records an explicit review when required and commits at most one simulated payment for that operation.

The main interface at `/` uses independently authored CSS and system fonts. Start with the unchanged invoice, then try a changed account. It includes the document workspace, exact-value review, simulated ledger and browser record checks. After verifying a signed record, compare its original payment with editable amount, account and currency fields. The editor changes a copy of the ledger, while the browser verifier checks it against the signed events and pinned demo key. Raw JSON remains available under Technical details. The private presentation view and its assets are excluded and return 404. The optional `/glasses` page is an experimental browser view, not a tested hardware product.

## Run without a model

Use Node.js 24 or later for built-in SQLite. There are no external runtime packages and no install step is required.

```sh
node --version
npm test
node examples/approved-payment.mjs .data/example
node scripts/verify-reference.mjs --key .data/example/pinned-key.json --record .data/example/record.json
```

The example uses synthetic fixtures and the real `WorkflowStore`, Node verifier and browser verifier. It records a changed-account proposal, checks the refusal under the old approval, makes an explicit fixture review decision, issues fresh authority and commits one simulated payment. It asserts that replay is refused without changing the ledger. It exports the actual signed record and public checking key. It also changes the payment amount by one minor unit and asserts rejection by both verifiers. No model, external service or real approver is involved. Each run generates fresh local identifiers and a fresh local signing key; the assertions are deterministic, the output bytes are not fixed.

Check the modified copy separately:

```sh
node scripts/verify-reference.mjs --key .data/example/pinned-key.json --record .data/example/edited-record.json
```

The original exits 0 with `valid: true`. The modified copy exits 1 with `valid: false`. An invalid CLI invocation exits 2. Obtain the checking key separately from the record and pin it before checking. Accepting a key supplied only inside the same untrusted record would not establish the intended issuer.

For a labelled scripted interface preview:

```sh
PREVIEW_MODE=refuse node scripts/preview-scripted.mjs
```

Open http://localhost:4182. This replaces the model with a scripted stand-in and labels it on screen. `direct` requests review without first attempting payment, `clarify` asks a question, and `text` answers without a payment action. The preview binds to IPv4 loopback and uses temporary local storage. Stop it with Ctrl+C.

## Run with your own model key

Copy the empty environment template and set your own `BASETEN_API_KEY` privately in `.env.local`:

```sh
cp .env.example .env.local
```

Start the signed document flow with a separate database and reference signing key:

```sh
PAYMENT_AGENT_PROVIDER=baseten SANDBOX_DOCUMENT_FLOW=1 SANDBOX_DATA_FILE=.data/documents.sqlite SANDBOX_REFERENCE_KEY_FILE=.data/reference-key.pem npm run serve
```

Open http://localhost:4174. The Baseten adapter fixes its endpoint to `https://inference.baseten.co/v1` and its model to `meta-models/muse-spark-open-1026`, labelled Muse Spark Open. The source also retains the Meta Muse Spark and Muse Wonder adapters, which use `META_MODEL_API_KEY`. Provider calls use your own account and key. The commands for the deterministic example, preview and native tests make no external inference requests.

Provider request compatibility was checked against the Meta documentation on 4 November 2026. Mocked tests cover direct Spark and Wonder using automatic tool choice, with returned reports still validated locally. Direct Meta API acceptance has not been checked live. The separately recorded real Muse runs use Baseten.

The server defaults to `127.0.0.1`, serves only named frontend assets and requires a matching local Origin for POST requests. Environment files, source modules and database files are not served. Keep the reference key and database as separate files. `.env.local` and `.data/` are ignored. The key is created with mode 0600; retain it separately from exported public records if you need to reopen the same signed database. A different or missing reference key cannot reopen its document workflows as valid state.

The hosted admission client, exact approved-email admission contract and persistent ownership checks remain in the source and native tests. Confirmed returning users continue directly to their requested demo page; confirmed first intake continues without an extra success-page action. This package does not contain or deploy the external access broker or production dashboard. The local commands above use loopback without a broker. No hosted deployment is configured by this source package.

When hosted mode is explicitly configured, the global model-request budget reserves capacity before each provider dispatch, including agent turns, document extraction and sample-photo reading. `SANDBOX_GLOBAL_MODEL_CALLS_DAY` sets that per-process daily request ceiling. Workspace and address operation limits remain separate from actual provider-request counting. These counters reset at UTC midnight or process restart and do not provide a durable or multi-instance spending cap. The loopback commands above do not enable hosted daily limits.

## How authority and effects connect

The existing seam is model proposal, authority decision, then effect:

1. `src/document-agent.mjs` extracts a proposal with literal source citations. Source consistency is not semantic truth and cannot grant authority.
2. `src/workflow.mjs` compares the proposal with current exact authority. A changed supplier account requires a pending review of the supplier, account, amount, currency, operation and digest. The model has no approval-granting tool.
3. A separate operator action approves or declines that exact pending review. A separate Continue action resumes the agent with fresh authority.
4. One SQLite transaction validates authority, consumes its one use and appends only the approved values to the simulated ledger. A unique operation constraint prevents a second commit, including after another review. Expired and superseded approvals cannot execute. An insertion failure rolls back consumption.

The example uses the same interfaces directly so another application can inspect the boundary. A future commercial Aqta or Seal integration is separate work and is not implemented here. There is no production Seal adapter, banking connector or distributed payment delivery. The idempotency domain is one generated operation in one SQLite database; a new case creates a new synthetic operation. A strong plain exact-value check can enforce the same payment boundary. Signatures do not establish superior payment prevention.

## Signed reference records

Document workflows use version 2 and sign their authority and ledger events with a local Ed25519 reference key. `src/reference-journal.mjs` declares `SEAL-REFERENCE-EVENT-v1`, with canonical JSON, SHA-256 hashes and a linked sequence. This is not production `ATTESTATION-v1`, a production Seal receipt or a production signing identity. The older fixed-case workflow remains in the source and tests; its events are unsigned.

The document record binds its source documents, recorded proposal, authority changes and committed ledger values. The browser checks the selected case, source digest, saved state and pinned reference key before presenting a result. The offline CLI checks the event signatures, sequence, workflow and operation identifiers, and agreement between signed commits and the exported ledger using the separately supplied public key. Download the record and public checking key from the interface to use the same CLI commands with their actual filenames.

A valid check establishes integrity under the pinned reference key for the supplied sequence. It does not establish complete evidence: a valid prefix can pass unless the expected full head is independently pinned. It does not establish a real approver's identity, document truth, unrecorded decisions or a bank payment. Local operator annotations do not reproduce production passkey approval.

Authority and ledger events persist in SQLite. Model traces and local operator-session annotations are held in server memory, so export before restarting if those observations matter. Provider reasoning fields and error bodies are omitted; request counts, returned token use and latency are observations, not a cost estimate. `SANDBOX_RUN_ARCHIVE` can restore trusted exported observations for existing matching workflows, but it is not automatic trace persistence or an upload endpoint. No credentials or production customer data are included.

## Verification scope

`npm test` runs all included native test suites, including exact approval, atomic SQLite writes, competing worker connections, persistence, rollback, replay, source binding, reference signatures, malformed records, HTTP operator separation, hosted admission, ownership and mocked model adapters. These deterministic and mocked checks do not establish live model behaviour, an independent audit, production readiness or a product ranking.

The existing browser walkthrough check requires Python Playwright and Chrome, which are optional development tools and are not runtime dependencies:

```sh
python3 scripts/walkthrough-check.py .data/browser-checks
```

It runs the neutral interface through labelled scripted refusal, direct review, clarification and text-only paths at phone and desktop widths. No model is called.

## Licence

The reference source code and documentation use the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. The unmodified Seal mascot has separate [artwork terms](ASSETS.md); names and marks do not transfer with the code licence. Private Seal fonts, logos, doodles, theme and presentation files are excluded.
