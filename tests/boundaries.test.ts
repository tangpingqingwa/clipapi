import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

test("HTTP and MCP call core only and never import adapters/tiktok", () => {
  const httpDir = join(ROOT, "src/http");
  const mcpDir = join(ROOT, "src/mcp");
  const files = [
    ...walkTs(httpDir),
    ...walkTs(join(ROOT, "src")).filter((path) => path.includes("/mcp/")),
  ];
  // mcp/ is optional until PR 5; still scan if present.
  try {
    files.push(...walkTs(mcpDir));
  } catch {
    // no MCP yet
  }
  const unique = [...new Set(files)];
  assert.ok(unique.length > 0);
  for (const file of unique) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /adapters\/tiktok/,
      `${file} must not import adapters/tiktok`,
    );
  }
});

test("no live TikTok hosts are fetched from src or tests", () => {
  const files = [
    ...walkTs(join(ROOT, "src")),
    ...walkTs(join(ROOT, "tests")),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(\s*['"`]https?:\/\/[^'"`]*tiktok/i, file);
    assert.doesNotMatch(src, /https?:\/\/www\.tiktok\.com\/api\//, file);
  }
});
