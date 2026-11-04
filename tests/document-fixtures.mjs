import { runDocumentAnalysis } from '../src/document-agent.mjs';
export const AUTHORITY = { supplierId: 'liffey-supplies', supplierName: 'Liffey Supplies', beneficiaryAccount: 'IE00-TEST-5600', amountMinor: 71899, currency: 'GBP' };
export function caseInput(changes = {}) {
  return { originalAuthority: { ...AUTHORITY, ...changes }, documents: [
    { kind: 'invoice', text: `Supplier: ${changes.supplierName ?? AUTHORITY.supplierName}\nAmount: ${changes.amountMinor ?? AUTHORITY.amountMinor}\nCurrency: ${changes.currency ?? AUTHORITY.currency}\nAccount: ${changes.beneficiaryAccount ?? AUTHORITY.beneficiaryAccount}` },
    { kind: 'instruction', text: `Pay ${changes.supplierName ?? AUTHORITY.supplierName}\nUse IE00-TEST-5601` },
  ] };
}
export function modelReport(state, { account, supplierName, status = 'ready', questions = [] } = {}) {
  const invoice = state.documents[0];
  return { status, candidate: {
    supplierName: { value: supplierName ?? state.originalAuthority.supplierName, citation: { documentId: 'invoice', line: 1, quote: invoice.lines[0].text } },
    amountMinor: { value: state.originalAuthority.amountMinor, citation: { documentId: 'invoice', line: 2, quote: invoice.lines[1].text } },
    currency: { value: state.originalAuthority.currency, citation: { documentId: 'invoice', line: 3, quote: invoice.lines[2].text } },
    beneficiaryAccount: { value: account ?? 'IE00-TEST-5601', citation: { documentId: account === state.originalAuthority.beneficiaryAccount ? 'invoice' : 'instruction', line: account === state.originalAuthority.beneficiaryAccount ? 4 : 2, quote: account ?? 'IE00-TEST-5601' } },
  }, questions };
}
export function providerResponse(report) { return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'extract', type: 'function', function: { name: 'report_payment', arguments: JSON.stringify(report) } }] } }] }) }; }
export async function analyse(store, state, changes = {}) {
  const result = await runDocumentAnalysis({ documents: state.documents, sourceDigest: state.sourceDigest, apiKey: 'fixture-key', fetchImpl: async () => providerResponse(modelReport(state, changes)) });
  return store.recordProposal(state.workflowId, result.proposal, state.sourceDigest);
}
export function decision(review, changes = {}) { return { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, ...changes }; }
