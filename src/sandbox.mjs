/**
 * A synthetic-only reference sandbox. This is not production payment code.
 *
 * The single commit method validates an approval, consumes its one allowed use
 * and appends the derived payment together. Nothing after validation can change
 * the beneficiary, amount or currency.
 */

export class Sandbox {
  #approvals;
  #ledger = [];
  #now;

  constructor({ approvals, now }) {
    this.#approvals = new Map(
      approvals.map((approval) => [approval.id, { ...approval, used: false }]),
    );
    this.#now = now;
  }

  get ledger() {
    return this.#ledger.map((payment) => ({ ...payment }));
  }

  getApproval(id) {
    const approval = this.#approvals.get(id);
    return approval ? { ...approval } : null;
  }

  /**
   * Atomic for this in-memory process: validation, consumption and ledger
   * append happen in one synchronous critical section. A production version
   * would require a database transaction with the same invariant.
   */
  commit(intent) {
    const approval = this.#approvals.get(intent.approvalId);
    const reason = validateIntent({ intent, approval, now: this.#now });

    if (reason) {
      return {
        status: "BLOCKED",
        reason,
        payment: null,
      };
    }

    approval.used = true;
    const payment = Object.freeze({
      id: `pay_${this.#ledger.length + 1}`,
      approvalId: approval.id,
      supplierId: approval.supplierId,
      beneficiaryAccount: approval.beneficiaryAccount,
      amountMinor: approval.amountMinor,
      currency: approval.currency,
      committedAt: this.#now,
    });
    this.#ledger.push(payment);

    return {
      status: "APPROVED",
      reason: "Exact approval is valid and unused.",
      payment: { ...payment },
    };
  }
}

export function validateIntent({ intent, approval, now }) {
  if (!approval) return "Approval does not exist.";
  if (approval.used) return "Approval has already been consumed.";
  if (Date.parse(approval.expiresAt) <= Date.parse(now)) return "Approval has expired.";
  if (intent.supplierId !== approval.supplierId) return "Supplier does not match approval.";
  if (intent.beneficiaryAccount !== approval.beneficiaryAccount) {
    return "Beneficiary account does not match approval.";
  }
  if (intent.amountMinor !== approval.amountMinor) return "Amount does not match approval.";
  if (intent.currency !== approval.currency) return "Currency does not match approval.";
  return null;
}

export const DEMO_NOW = "2026-10-26T12:00:00.000Z";

export const DEMO_APPROVAL = Object.freeze({
  id: "apr_demo_250k",
  supplierId: "harbour-print",
  beneficiaryAccount: "DE00-TEST-0000-1280",
  amountMinor: 25000000,
  currency: "EUR",
  expiresAt: "2026-10-26T12:15:00.000Z",
});

export function createDemoSandbox() {
  return new Sandbox({ approvals: [DEMO_APPROVAL], now: DEMO_NOW });
}

export function createIntent(overrides = {}) {
  return {
    approvalId: DEMO_APPROVAL.id,
    supplierId: DEMO_APPROVAL.supplierId,
    beneficiaryAccount: DEMO_APPROVAL.beneficiaryAccount,
    amountMinor: DEMO_APPROVAL.amountMinor,
    currency: DEMO_APPROVAL.currency,
    ...overrides,
  };
}
