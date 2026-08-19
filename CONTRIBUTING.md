# Contributing

This repo is developed on GitHub. **`main` must always be buildable and testable.** Nothing lands on `main` except through a green pull request.

The product contract is [SPEC.md](./SPEC.md). If SPEC and code disagree, fix one of them in the same PR.

---

## Default branch

| Rule | Detail |
|---|---|
| Default branch | `main` |
| Direct commits | Forbidden (including admins once protection is on) |
| Force-push / delete `main` | Forbidden |
| Merge gate | CI job `ci` is green on the PR head |
| History | Squash merge preferred; one logical change per PR |

If you have admin and protection is not yet on, still behave as if it is. Do not push to `main`.

---

## Branch names

Create from current `main`:

```text
feat/<short-slug>      new user-visible capability
fix/<short-slug>       bug that broke build, test, or behavior
docs/<short-slug>      SPEC / README / CONTRIBUTING only
chore/<short-slug>     CI, tooling, deps, repo hygiene
test/<short-slug>      tests only
```

Examples: `feat/transcript-cache`, `fix/zero-credit-on-404`, `docs/git-workflow`.

Do not open long-lived `develop` or `release` branches in v1. Trunk-based: short branches, frequent merges.

---

## Local loop

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/my-change
# ... edit ...
bash scripts/test.sh
git add -A
git status
git commit -m "feat: short present-tense summary"
git push -u origin HEAD
gh pr create --fill --base main
```

Wait for `ci` to pass. Then:

```bash
gh pr merge --squash --delete-branch
```

Do not merge with failing or skipped required checks.

---

## What “always buildable and testable” means

On **every** commit that reaches `main`:

1. Required files exist: `README.md`, `SPEC.md`, `BUILD.md`, `CONTRIBUTING.md`, `scripts/test.sh`.
2. `bash scripts/test.sh` exits 0 on a clean checkout with no secrets and no live upstream.
3. Tests are deterministic. No network to TikTok / Reddit / X / Amazon / Maps / G2 / stores unless the test is explicitly marked integration and skipped by default.
4. A stranger can clone `main`, run `scripts/test.sh`, and get a green result.

Until application code exists, `scripts/test.sh` still runs: it validates the contract files and any fixtures. When you add an app, **extend** that script (or call `npm test` / `go test` / `cargo test` from it). Do not replace the script with a no-op.

Broken `main` is an incident. Fix with `fix/` on a PR, not a commit on `main`.

---

## Pull requests

**Title:** conventional, matches the commit, e.g. `feat: cache transcripts by video id`.

**Body must include:**

- What changed and why (user-visible or not)
- SPEC impact: none / updated in this PR
- How you tested (`scripts/test.sh`, plus anything extra)
- Risk: can `main` still build if this is the only change?

**Size:** one concern. Do not mix a schema change with a drive-by rewrite.

**Reviews:** if someone else is working, wait for one approval. Solo is allowed to self-merge **after** `ci` is green.

**Draft PRs:** use for unfinished work. Do not squash-merge drafts.

---

## Commit messages

```
feat: add GET /v1/transcript
fix: do not charge credits on upstream_blocked
docs: freeze review field list
chore: require ci on pull_request
test: fixture for no-caption videos
```

- Imperative, present tense
- Optional `BREAKING CHANGE:` footer if you change a public contract
- No generated secrets, tokens, or customer data

---

## SPEC and public contracts

- New endpoint, error code, credit rule, or user flow → update `SPEC.md` in the **same** PR.
- Breaking API change → `/v2` or a documented deprecation; never silently change v1 on `main`.
- Do not merge “code now, SPEC later.”

---

## Secrets and CI

- Never commit `.env`, API keys, or cookies.
- GitHub Actions on this repo run **without** production secrets by default.
- Integration tests that need live credentials stay `if: false` or `if: secrets.X != ''` and must not be required to keep `main` green.

---

## Releases

`main` is the release candidate. Tag when you actually ship:

```bash
git checkout main
git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Do not tag a commit that is not on `main`.

---

## What not to do

- Push to `main`
- `--force` on `main` or on a shared feature branch after someone else pulled it
- Merge with red or pending `ci`
- Skip `scripts/test.sh` because “it’s only docs” (docs PRs still run CI)
- Land a scraper, live-network test, or secret so `main` cannot be tested offline
