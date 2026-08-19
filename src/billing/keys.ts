import { createHash, randomUUID } from "node:crypto";
import type { ClipApiDb } from "../db.js";

export type KeyPrefix = "ck_live" | "ck_test";

export type Key = {
  id: string;
  prefix: KeyPrefix;
  plan: string;
  credits: number;
  rpm: number;
  createdAt: string;
};

export const DEFAULT_FREE_CREDITS = 100;
export const DEFAULT_FREE_RPM = 30;

type KeyRow = {
  id: string;
  prefix: KeyPrefix;
  plan: string;
  credits: number;
  rpm: number;
  created_at: string;
};

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function prefixFromSecret(secret: string): KeyPrefix | null {
  if (secret.startsWith("ck_test_")) {
    return "ck_test";
  }
  if (secret.startsWith("ck_live_")) {
    return "ck_live";
  }
  return null;
}

export function createKey(
  db: ClipApiDb,
  input: {
    secret: string;
    plan?: string;
    credits?: number;
    rpm?: number;
    id?: string;
  },
): Key {
  const prefix = prefixFromSecret(input.secret);
  if (!prefix) {
    throw new Error("API key must start with ck_live_ or ck_test_");
  }
  const key: Key = {
    id: input.id ?? `key_${randomUUID()}`,
    prefix,
    plan: input.plan ?? "free",
    credits: input.credits ?? DEFAULT_FREE_CREDITS,
    rpm: input.rpm ?? DEFAULT_FREE_RPM,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO keys (id, prefix, hash, plan, credits, rpm, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key.id,
    key.prefix,
    hashSecret(input.secret),
    key.plan,
    key.credits,
    key.rpm,
    key.createdAt,
  );
  return key;
}

export function lookupKey(db: ClipApiDb, secret: string): Key | null {
  if (prefixFromSecret(secret) === null) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, prefix, plan, credits, rpm, created_at
       FROM keys WHERE hash = ?`,
    )
    .get(hashSecret(secret)) as KeyRow | undefined;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    prefix: row.prefix,
    plan: row.plan,
    credits: row.credits,
    rpm: row.rpm,
    createdAt: row.created_at,
  };
}

export function bootstrapKeyIfEmpty(db: ClipApiDb, secret: string): Key | null {
  const count = db.prepare("SELECT COUNT(*) AS n FROM keys").get() as { n: number };
  if (count.n > 0) {
    return lookupKey(db, secret);
  }
  return createKey(db, { secret });
}
