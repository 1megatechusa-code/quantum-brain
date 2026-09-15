# Contradiction detection — flag-only mode (fix log)

Fixes open item 2 of `p1-p2-fix-log.md` (Airtable `recU4GOFQgs6nWNi0`, `Product Development` base):
capture-time contradiction detection auto-deprecated real memories on false-positive verdicts.

## What was wrong

`captureEntry` (`src/capture/entry.ts`) runs the contradiction check on every capture whose nearest
neighbour scores ≥ `CANDIDATE_SCORE_THRESHOLD` (0.45, compile-time). A "contradiction" verdict from the
model — from either prompt, the flagged-band smart-merge one or the plain one — called `deprecateEntry`
on the older memory unconditionally: `status:deprecated`, `vector_ids` cleared, vectors deleted from
Vectorize, gone from recall. The only escape was `status:canonical` on the older row (or a transcript
source), which turned the newcomer into a draft instead.

The check was silently inert until A0 made semantic search work (2026-09-14). The first live day it ran,
two of nine seeds auto-deprecated correct memories: `f984844f-…` ("Has a new pet alligator", verdict
"different pet type") and `6beb831c-…` ("DynamiteDTF will switch its shipping carrier to UPS starting in
October 2026", verdict "date differs"). Both were restored by hand.

## What changed

**Default is now flag-only; auto-deprecation is opt-in.**

| Piece | Change |
|---|---|
| `src/config.ts` | New tunable `CONTRADICTION_MODE`, default `"flag"`. Only the exact string `"resolve"` restores the old auto-deprecate behaviour; any other value (including a typo) reads as `"flag"`. Settable at runtime via `PATCH /config` like every other key. |
| `src/capture/entry.ts` | New outcome `contradiction_flagged`. When the verdict says contradiction and the older memory is **not** canonical/transcript-protected: the new memory is inserted normally (no status change), **both** rows get the tag `contradiction-candidate`, one undirected `contradicts` edge (system provenance, weight 1.0, workspace-stamped) joins them, and `deprecateEntry` is **not** called. `contradiction_wins` / `contradiction_losses` are **not** touched — nobody won, and those counters bias recall ranking and compression eligibility, which is exactly the residue a false positive leaves. The old path (`contradiction-resolved` tag, counters, `deprecateEntry`, `supersedes` edge) is intact behind `CONTRADICTION_MODE = "resolve"`. |
| `canonical` / transcript protection | Unchanged and evaluated **first**: a protected conflict still yields `contradiction_protected` (newcomer → draft) in both modes and is never even tagged or linked. Canonical is therefore still the stronger layer on top of the flag-only default. |
| `src/graph/types.ts` | New edge type `contradicts` (undirected, no kind constraint). `supersedes` was wrong for this: every reader treats a supersedes target as deprecated (`src/graph/traverse.ts`, `src/insight/candidates.ts`). |
| `src/tags/system.ts`, `public/utils.js`, `src/compression/eligibility.ts`, `src/insight/eligibility.ts` | `contradiction-candidate` registered as a Worker-owned bookkeeping tag everywhere `contradiction-resolved` / `duplicate-candidate` are: hidden from the editable tag list, excluded from digest/compression topic tags and from insight subject matching. |
| `src/routes/capture.ts` | `POST /capture` returns `{ ok, id, flagged_conflict, reason, tags, message }` for the new outcome. Audit event is `created` (nothing was rewritten). |
| `src/mcp/server.ts` | `remember` reports the flag and tells the caller both memories are kept, and how to deprecate one deliberately (`set_status`). `link` tool documents the `contradicts` type (the enum is derived from `EDGE_TYPES`, so it accepts it automatically). |
| Dashboard | `remember.js` shows a "may disagree with something older" receipt for `flagged_conflict`; EN + IT strings added. |

Resolving a flagged pair is the existing explicit action: `set_status deprecated` (MCP or dashboard) on
whichever side is actually wrong. Nothing in the pipeline resolves it on its own.

Not changed, deliberately: the 0.45 candidate threshold, the two prompts, `deprecateEntry` itself, and the
uncommitted `src/recall/search.ts` larger-of merge (Q7, `recqY2hGU6j7OMBGA`).

Known small window, same as the existing merge path: the older row's tags are read once (for the
canonical check) and written back with the tag appended, so a concurrent tag write on that row inside the
same few hundred ms could be overwritten. The write is wrapped non-fatal — a failure there still stores
and reports the capture.

## Before / after on the two real cases

| Case (verdict) | Before (deployed `14fa9026`) | After (this fix, default config) |
|---|---|---|
| "Has a new pet alligator" vs a new pet memory ("different pet type") | Alligator memory `status:deprecated`, vectors deleted, absent from recall; newcomer tagged `contradiction-resolved`, `contradiction_wins = 1`; alligator `contradiction_losses = 1`; `supersedes` edge | Both stored and searchable; both tagged `contradiction-candidate`; one `contradicts` edge; counters unchanged; no status change on either |
| "…switch its shipping carrier to UPS starting in October 2026" vs a carrier-date note ("date differs") | Same as above | Same as above |

Both reproduced as unit regressions (`test/unit/capture-entry.test.ts`, "contradiction flag-only mode
(default)"), asserting the older row's tags, status, `vector_ids`, counters and `updated_at` are byte-for-byte
untouched and no `deleteByIds` call is made. A genuine contradiction case ("I live in NYC" → "I moved to
LA") is also covered: still detected and reported as flagged, then resolved only by an explicit
`applyStatus(…, "deprecated")`.

## Tests

- Before: **3640 passed / 7 failed / 7 skipped** (3654 tests, 258 files).
  After: **3659 passed / 4 failed / 7 skipped** (3670 tests). The 4 are the path-separator subset of the
  baseline 7 (`mcp-tools-contract`, `confirm-sheet-callers`, `i18n` dynamic call sites, `scope-checker`
  CI wiring); the 3 miniflare timeouts did not recur this run.
- All 7 baseline failures are environmental on this Windows machine: four compare `relative()` paths against
  forward-slash literals (`confirm-sheet-callers`, `i18n` dynamic-call-site list, `mcp-tools-contract`
  registrar path, `scope-checker` CI-wiring via `cat`), three are miniflare spawn/dispose timeouts
  (`update-parity` afterAll, `claude-code-hooks-contract`, `tokenizer-runtime`). None touch recall or
  capture code.
- Existing auto-deprecate tests were kept and now opt into `CONTRADICTION_MODE: "resolve"` explicitly
  (`capture-entry`, `auto-link`, `smart-merge`, `cross-workspace-link`, `recall` win-boost ranking).
- New coverage: both regressions; genuine contradiction; canonical and transcript protection unchanged in
  flag mode; unknown mode value fails towards flagging; flagged-band (dup + contradiction) tags both;
  no double-tagging; non-fatal tag write; `contradicts` edge registered undirected; workspace stamping of
  the `contradicts` edge on real SQLite; `POST /capture` response shape; dashboard receipt; tag lists.
- `npx tsc --noEmit` clean; `node scripts/check-scope.mjs` clean (100 queries, 53 documented exceptions).

## Deploy

Code commit `f599556` (this branch, on top of `319c59d`) deployed with `npx wrangler deploy` at
**2026-09-15T09:24:37Z**, version **`f26b0448-f1e3-4b6a-a4db-08502f88f880`**. Pure application code;
bindings unchanged (`env.VECTORIZE` = `quantum-brain-vectors`, D1 `quantum-brain`). The uncommitted Q7
files (`src/recall/search.ts`, `test/integration/recall-fusion-quality.test.ts`) were stashed for the
duration of the deploy and restored afterwards (diff md5 `4ac6cc55…` before and after) — they are NOT
in this build, exactly as with `14fa9026`. No config override was written: production runs the shipped
default `CONTRADICTION_MODE = "flag"`.

## Live verification (2026-09-15, workspace `ws-1925db93…` = Quantum Brain2)

Identity of the connector used (`quantum-brain-product`) was verified two ways before writing: its URL
path names user `qb-52c9a6ff0a76f96d` and the SHA-256 of its bearer token equals that user's
`users.token_hash`; that user's only membership is `ws-1925db93…` (customer 1megatechusa@gmail.com,
monthly, active). Head7 (`ws-b928a083…`, Owner) was not touched — a different user and token.

Four captures tagged `flagtest_2026_09_15`, all through the product's own `remember`:

| # | Capture | Live outcome |
|---|---|---|
| 1 | "…also has a new pet parrot named Kiwi." | **The exact false positive from 2026-09-14 fired again** — verdict "Different pet type" against `f984844f…` ("Has a new pet alligator") — and was **flagged, not deprecated**: reply "may contradict entry f984844f… Both memories are kept and searchable…". D1 afterwards: alligator row `vector_ids` intact, no status tag, `contradiction_wins/losses` unchanged (0/1, the 09-14 residual), `updated_at` unchanged; tags gained only `contradiction-candidate`. One edge `contradicts` / system / weight 1 / `workspace_id = ws-1925db93…`. `recall("new pet alligator")` returned the alligator at rank 1 (100%) and the parrot at rank 2; `connections(f984844f…)` showed "Contradicts · system-linked". |
| 2 | "…UPS carrier switch is now planned for November 2026 instead of October." | Model answered keep_both (87% band) → stored as `duplicate-candidate`. No contradiction verdict, nothing deprecated. |
| 3 | "…shipping carrier changes to UPS on October 15, 2026." | keep_both (86%) → `duplicate-candidate`. |
| 4 | "…cancelled the UPS switch and will keep shipping with FedEx." (a genuine contradiction) | keep_both (85%, nearest was seed 2) → `duplicate-candidate`. |

The carrier-date false positive could not be re-provoked live today — the model returned keep_both on
three phrasings — so that scenario's flag-only behaviour rests on the unit regression (identical code
path to case 1, which did fire live). In none of the four captures was any existing memory deprecated,
un-indexed, or status-changed. `6beb831c…` (UPS) was not modified by anything.

Cleanup: all four test entries deleted via `forget` (each reported 1 vector deleted; edge cascade removed
the `contradicts` edge), then `contradiction-candidate` removed from `f984844f…` by a guarded D1 UPDATE
(matched on the exact tag JSON, 1 row changed). Verified: 0 entries tagged `flagtest_2026_09_15`, 0
`contradicts` edges, and both `f984844f…` and `6beb831c…` byte-identical to their pre-test rows (tags,
`vector_ids`, counters, `updated_at`).

## Protection status of previously-affected entries

Checked on live D1 before and after the deploy. **Neither restored entry carries `status:canonical`, and
neither ever did** — the brief's "temporary canonical protection on the two restored entries" does not
match the data:

| Entry | Tags now | `status:canonical`? | Counters | Notes |
|---|---|---|---|---|
| `f984844f…` "Has a new pet alligator." | `kind:episodic, volatility:durable` | **no** | wins 0 / losses 1 | losses=1 and `updated_at` 2026-09-14T15:30Z are the 09-14 residuals; protected from now on by the flag-only default (proven live above) |
| `6beb831c…` "DynamiteDTF will switch its shipping carrier to UPS…" | `dynamitedtf, shipping, ups, carrier, kind:semantic, volatility:state` | **no** | wins 0 / losses 1 | same residuals; protected by the flag-only default |

The only `status:canonical` rows in that workspace are `d359285e…` (coffee black), `3ece924e…` (dog
Joker) and `f4c01e6c…` (a `conflict_test` entry), all marked **2026-09-13**, i.e. before the incident —
they are user/classifier choices, not the mitigation. **Decision: leave all canonical marks as they are.**
There was nothing temporary to remove, and removing a pre-incident canonical would be a real change to
someone's data for no benefit; canonical remains the stronger, opt-in layer on top of the new default.

## Residual / follow-ups

- Airtable `recU4GOFQgs6nWNi0`: can be moved to fixed/deployed with version `f26b0448…`.
- The 09-14 residuals (`contradiction_losses = 1`, `updated_at` reset) on the two entries remain; the
  loss counter shifts their recall multiplier slightly downward (`src/recall/math.ts`). A one-off
  `UPDATE … SET contradiction_losses = 0` on the two ids would remove it; not done here because it was
  not asked for and it is a judgment call on data, not code.
- `contradiction-candidate` pairs have no review UI yet: they are findable by tag (`list_recent`,
  `recall` with `tag`) and by `connections`, and resolved with `set_status deprecated`.
- The nearest-neighbour candidate threshold (0.45) and the two prompts are unchanged; the model still
  produces the "different pet type" verdict. It is now advisory, which is the point of this fix.
