import { randomUUID } from "node:crypto";
import type { ClipApiDb } from "../db.js";

export const TRANSCRIPT_CREDIT_COST = 1;

export type ChargeInput = {
  keyId: string;
  route: string;
  credits: number;
  cached: boolean;
};

export type ChargeResult =
  | { ok: true; charged: number; remaining: number }
  | { ok: false; code: "payment_required" };

type CreditsRow = { credits: number };

class PaymentRequiredError extends Error {
  readonly code = "payment_required" as const;
}

export function getCredits(db: ClipApiDb, keyId: string): number | null {
  const row = db
    .prepare<[string], CreditsRow>("SELECT credits FROM keys WHERE id = ?")
    .get(keyId);
  return row === undefined ? null : row.credits;
}

export function chargeCredits(db: ClipApiDb, input: ChargeInput): ChargeResult {
  if (input.credits <= 0) {
    throw new Error("chargeCredits requires a positive credit amount");
  }
  try {
    return db.transaction((): ChargeResult => {
      const row = db
        .prepare<[string], CreditsRow>("SELECT credits FROM keys WHERE id = ?")
        .get(input.keyId);
      if (row === undefined || row.credits < input.credits) {
        throw new PaymentRequiredError();
      }
      db.prepare(
        `INSERT INTO usage_events
           (id, key_id, route, credits, cached, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        `evt_${randomUUID()}`,
        input.keyId,
        input.route,
        input.credits,
        input.cached ? 1 : 0,
        new Date().toISOString(),
      );
      const updated = db
        .prepare(
          `UPDATE keys SET credits = credits - ?
           WHERE id = ? AND credits >= ?`,
        )
        .run(input.credits, input.keyId, input.credits);
      if (updated.changes === 0) {
        throw new PaymentRequiredError();
      }
      return {
        ok: true,
        charged: input.credits,
        remaining: row.credits - input.credits,
      };
    })();
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      return { ok: false, code: "payment_required" };
    }
    throw err;
  }
}
