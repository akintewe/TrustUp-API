/**
 * Fixtures for job processor unit tests
 * (transaction-status-checker, loan-payment-reminder).
 */

export const CONTRACT_ID_FIXTURE = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
export const USER_WALLET_FIXTURE = 'GB4SHJ6PKMICEIOI3KQCQYFTZEPDOQ7HEYDKWYO7VZZJQGROL2H2KJ5G';

// ---------------------------------------------------------------------------
// XDR fixtures
//
// Generated once via StellarSdk.Contract('...').call(...) + TransactionBuilder
// and committed as base64 so tests never depend on the SDK's XDR encoder at
// runtime — only on the decoder path exercised by parseTransactionMetadata.
// ---------------------------------------------------------------------------

/** invokeHostFunction: create_loan('LOAN-FIXTURE-001', 'MERCHANT-FIXTURE-001', 1000.00, 1000.00, 200.00, 15%, 90d) */
export const CREATE_LOAN_XDR_FIXTURE =
  'AAAAAgAAAADccaaJSZTGUyB17AkOLKDnrC7exI9WUZ20P3nX+UuulAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqXkiVAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcAAAALY3JlYXRlX2xvYW4AAAAABwAAAA4AAAAQTE9BTi1GSVhUVVJFLTAwMQAAAA4AAAAUTUVSQ0hBTlQtRklYVFVSRS0wMDEAAAAKAAAAAAAAAAAAAAAAAAGGoAAAAAoAAAAAAAAAAAAAAAAAAYagAAAACgAAAAAAAAAAAAAAAAAATiAAAAADAAAF3AAAAAMAAABaAAAAAAAAAAAAAAAA';

/** invokeHostFunction: repay_loan(user, 'LOAN-FIXTURE-001', 50 XLM in stroops) */
export const REPAY_LOAN_XDR_FIXTURE =
  'AAAAAgAAAAASoCPh7zeGHiCY8vPKQpQzzn8cN9L0bbUeb9RTedN/uAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqXkiVAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcAAAAKcmVwYXlfbG9hbgAAAAAAAwAAABIAAAAAAAAAAHkjp89TECIhyNqgKGCzyR43Q+cmBqth365ymBouXo+lAAAADgAAABBMT0FOLUZJWFRVUkUtMDAxAAAACgAAAAAAAAAAAAAAAB3NZQAAAAAAAAAAAAAAAAA=';

/** invokeHostFunction calling an unrecognised contract function */
export const UNKNOWN_FUNCTION_XDR_FIXTURE =
  'AAAAAgAAAAAsqZHRYHIkApFzee2eeczXMn43W8a0jpKMYX/JfQgZmQAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqXkiVAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcAAAATc29tZV9vdGhlcl9mdW5jdGlvbgAAAAABAAAADgAAAAFYAAAAAAAAAAAAAAAAAAAA';

/** Plain payment operation — no invokeHostFunction at all */
export const PAYMENT_ONLY_XDR_FIXTURE =
  'AAAAAgAAAADMUtdRXWX5pURDwLLBezdnW2pEFTFWKizq0UHIwzSudwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqXkiVAAAAAAAAAAEAAAAAAAAAAQAAAAADDFqaqC/doLdJhPiGAHA/4f7iT7LDBmxdj3YoCv0UBwAAAAAAAAAABfXhAAAAAAAAAAAA';

/** Not valid XDR — exercises the parse-failure path */
export const INVALID_XDR_FIXTURE = 'not-a-real-xdr';

// ---------------------------------------------------------------------------
// Pending transaction fixtures
// ---------------------------------------------------------------------------

export interface PendingTransactionFixture {
  id: string;
  user_wallet: string;
  transaction_hash: string;
  type: 'loan_create' | 'loan_repay' | 'deposit' | 'withdraw';
  status: 'pending' | 'success' | 'failed';
  xdr?: string | null;
  submitted_at: string;
  updated_at: string;
}

export function createPendingTransactionFixture(
  overrides: Partial<PendingTransactionFixture> = {},
): PendingTransactionFixture {
  return {
    id: 'tx-fixture-1',
    user_wallet: USER_WALLET_FIXTURE,
    transaction_hash: 'fixture-tx-hash-1',
    type: 'loan_create',
    status: 'pending',
    xdr: CREATE_LOAN_XDR_FIXTURE,
    submitted_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Active loan fixtures
// ---------------------------------------------------------------------------

export interface ActiveLoanFixture {
  id: string;
  loan_id: string;
  user_wallet: string;
  merchant_id: string | null;
  amount: string;
  loan_amount: string;
  next_payment_due: string | null;
  remaining_balance: string;
  term: number;
}

export function createActiveLoanFixture(
  overrides: Partial<ActiveLoanFixture> = {},
): ActiveLoanFixture {
  return {
    id: 'loan-db-1',
    loan_id: 'LOAN-1',
    user_wallet: USER_WALLET_FIXTURE,
    merchant_id: 'merchant-1',
    amount: '1000',
    loan_amount: '1000',
    next_payment_due: '2026-07-23T00:00:00.000Z',
    remaining_balance: '500',
    term: 90,
    ...overrides,
  };
}

/** Builds an ISO due-date string N UTC days offset from a fixed reference date. */
export function dueDateOffsetDays(referenceDateIso: string, offsetDays: number): string {
  const reference = new Date(referenceDateIso);
  const due = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate() + offsetDays,
    ),
  );
  return due.toISOString();
}
