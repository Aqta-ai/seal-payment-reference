// The walkthrough's words. Everything said about the agent is read from the recorded
// events and runs in the state it is given; nothing here can change a payment.
export const REASONS = { ACCOUNT_MISMATCH: 'account differs from the approval', OPERATION_ALREADY_COMMITTED: 'this invoice is already paid', APPROVAL_EXPIRED: 'the approval expired', APPROVAL_SUPERSEDED: 'the approval was replaced' };

export const TOUR_TEXT = Object.freeze({
  opening: 'This invoice was approved for the account ending 1280. A later message asks to pay 1289.',
  decide: 'Check the exact details, then approve this one payment.',
  paid: 'One payment. Nothing else moved.',
  breakIt: 'Now try to break it: change one cent in a copy, or try paying again.',
});
const FRESH_CASE = ['/?view=run&tour=1', 'Start a fresh case'];
export const OWN_DOCUMENTS = ['/?view=run&documents=1', 'Use your own test documents'];

const ending = account => String(account).slice(-4);
const accountsIn = text => (String(text).match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) || []).filter(token => /[0-9]/.test(token));

function approvedAccount(state) {
  return state.version === 2 ? state.originalAuthority?.beneficiaryAccount : state.invoiceText?.match(/Beneficiary account: (\S+)/)?.[1];
}

/** The opening sentence, for the case actually on screen. */
function opening(state) {
  if (!state) return TOUR_TEXT.opening;
  const approved = approvedAccount(state);
  const proposed = state.proposal?.candidate?.beneficiaryAccount?.value;
  const mentioned = accountsIn(state.version === 2 ? state.documents?.find(item => item.kind === 'instruction')?.text : state.supplierEmail);
  const requested = proposed ?? mentioned.find(account => account !== approved) ?? mentioned[0];
  const start = `This invoice was approved for the account ending ${ending(approved)}.`;
  if (!requested) return `${start} The model has not read the later message yet.`;
  return requested === approved ? `${start} The later message asks to pay the same account.` : `${start} A later message asks to pay ${ending(requested)}.`;
}

const refusals = state => (state.events || []).filter(event => event.type === 'payment_blocked');
const refusalReason = event => REASONS[event.details?.reasonCode] || 'not permitted by the approval';

/** What the run did, only from its record. Returns text for refusal, direct request, payment or none. */
export function describeAgentAction(state) {
  const refused = refusals(state);
  const requested = (state.events || []).findLast(event => event.type === 'approval_requested')?.details?.tuple;
  const parts = [];
  if (refused.length) {
    const last = refused.at(-1);
    const account = last.details?.attemptedIntent?.beneficiaryAccount ?? requested?.beneficiaryAccount;
    const attempts = refused.length === 1 ? 'tried to pay' : `tried ${refused.length} times to pay`;
    parts.push(`The agent ${attempts} ${account ? `the account ending ${ending(account)}` : 'with a changed detail'} using the existing approval. The check refused it: ${refusalReason(last)}.`);
  }
  if (requested) parts.push(refused.length ? `It then asked a person to review the account ending ${ending(requested.beneficiaryAccount)}.` : `The agent did not try to pay. It asked a person to review the account ending ${ending(requested.beneficiaryAccount)}.`);
  const payment = state.ledger?.[0];
  if (payment && !(state.events || []).some(event => event.type === 'operator_approved')) parts.push(`${refused.length ? 'It then' : 'The agent'} paid the account ending ${ending(payment.beneficiaryAccount)} with the existing approval, which matched exactly.`);
  return parts.join(' ');
}

function clarification(state) {
  const question = state.proposal?.questions?.[0];
  if (typeof question !== 'string' || !question.trim()) return 'This case needs one more detail before anything can be paid.';
  const shown = question.length > 160 ? `${question.slice(0, 160)}…` : question;
  return question.trim().endsWith('?') ? `The model asked a question instead of proposing a payment: “${shown}” Nothing was paid.` : `This case needs one more detail before anything can be paid: “${shown}”`;
}

function endedWithoutDecision(state) {
  const action = describeAgentAction(state);
  if (action) return `${action} It stopped without asking for review. Nothing was paid.`;
  const status = state.agentRuns?.at(-1)?.status;
  return status === 'completed' ? 'The model answered in words instead of acting, so nothing was paid.' : 'The run stopped before the agent acted. Nothing was paid.';
}

/**
 * The current walkthrough step. ui: busy, ready (the proposal passed the page's check),
 * seen (Set of stages already acknowledged with Next), proof (edited, repeat).
 */
export function tourStage(state, { busy = false, ready = false, seen = new Set(), proof = {} } = {}) {
  const documents = state?.version === 2;
  const total = !state || documents ? 5 : 4;
  const stage = (step, text, hint, target, extra = {}) => ({ step, total, text, hint, target, next: null, links: [], ...extra });
  if (!state) return stage(1, opening(null), 'Press Run invoice task.', 'start-conflict');
  const events = state.events || [];
  const review = state.pendingReview?.status === 'awaiting_human' ? state.pendingReview : null;
  const approvedOnce = events.some(event => event.type === 'operator_approved');
  const paid = state.ledger?.length > 0;
  if (documents && !state.proposal) return state.analysing || busy
    ? stage(1, opening(state), 'The model is reading the documents. It has no payment tools in this step.', 'document-controls')
    : stage(1, opening(state), 'Press Analyse documents.', 'analyse-documents');
  if (documents && !ready) return stage(2, clarification(state), null, null, { links: [FRESH_CASE, OWN_DOCUMENTS] });
  if (events.some(event => event.type === 'operator_declined')) return stage(3, 'You declined this payment. Nothing was paid.', null, null, { links: [FRESH_CASE, OWN_DOCUMENTS] });
  if (approvedOnce && (state.running || busy || !paid)) return stage(3, 'Approved for this one payment.', state.running || busy ? 'The agent is using the approval.' : 'Press Continue with this approval.', state.running || busy ? 'steps' : 'resume');
  if (state.running || (busy && !review && !paid)) return stage(2, 'The agent is working. Its steps will appear when this run finishes.', null, 'steps');
  const acknowledged = seen.has('agent') || approvedOnce;
  if ((review || paid) && !acknowledged) return stage(2, describeAgentAction(state), null, 'steps', { next: 'agent' });
  if (review) return stage(3, TOUR_TEXT.decide, `The original approval was for the account ending ${ending(approvedAccount(state))}. Tick the box if you accept these exact details, or decline.`, 'review');
  if (paid && !documents) return stage(4, TOUR_TEXT.paid, null, 'ledger', { links: [['/?view=payments', 'Open Payments']] });
  if (paid && !seen.has('paid')) return stage(4, TOUR_TEXT.paid, null, 'ledger', { next: 'paid' });
  if (paid) {
    const hint = proof.edited && proof.repeat ? 'The edited copy was rejected and the repeat was refused. There is still one payment.'
      : proof.edited ? 'The edited copy was rejected. Now try paying again.' : proof.repeat ? 'The repeat was refused. Now change one cent in a copy.' : null;
    return stage(5, TOUR_TEXT.breakIt, hint, proof.edited ? proof.repeat ? 'proof-checks' : 'check-repeat-run' : 'check-edited-copy', { links: [OWN_DOCUMENTS] });
  }
  if (!state.agentRuns?.length) return documents
    ? stage(1, opening(state), 'Compare the proposal with the original permission, then press Continue with this proposal.', 'continue-proposal')
    : stage(1, opening(state), 'Press Run invoice task.', 'start-conflict');
  return stage(2, endedWithoutDecision(state), null, null, { links: [FRESH_CASE, OWN_DOCUMENTS] });
}
