# v3 prompt sources and external composition

Status: 2.3.0 candidate, 2026-09-14. Not released; final user acceptance pending. [Complete Chinese contract](PROMPT_API_V3.md).

The new HTTP v3 contract is independent of the package version and DSH's V3 session format. Existing v1/v2 routes and builtin injection remain compatible. This API serves prompt inspectors, budget tools and backend composers that need complete source fields instead of reverse engineering the flattened profile.

## HTTP

Root: `/pmp-dsh-tavern/api/v3`. Existing peer/Host/Origin/JSON security applies. Responses are `no-store` and use `{ ok: true, ... }` or `{ ok: false, error, code? }`.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/capabilities` | apiVersion, service, modes, lifetime, composers and limits |
| GET | `/sessions/:id/prompt-sources` | `{ ok: true, sources }` |
| GET | `/sessions/:id/prompt-mode` | `{ ok: true, composition: { mode, owner, available, revision } }` |
| PUT | `/sessions/:id/prompt-mode` | Body `{ mode, owner?, expectedRevision }`; returns composition |

Use an explicit URL-encoded DSH session ID matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`. HTTP checks existence using public `session.inspect`; this is not necessarily constant-cost. Backend service methods are synchronous and require the trusted caller to supply a real session ID.

Modes: `builtin` (no owner) or `external` (registered owner required). Registering a composer does not enable sessions. Mode changes are rejected while the agent is running. Read the mode revision before writing; it is distinct from the source revision. Registry changes invalidate mode revisions, including changes to other owners. Treat 409 as a reason to reread and reconcile intent, not to retry blindly.

## Lossless sources

`sources` contains:

- `schemaVersion: 3`, `sessionId`, and the original session `selection` (preset/character/user/world-book IDs, character options and RP state).
- `worldBookSelection`: explicit/user/preset/character bindings, effective IDs, duplicates and order. Independent books are deduplicated while their binding provenance remains available.
- `documents: { preset, character, user, worldBooks }`. Unselected singular resources are null. Documents include normalized fields and retained `source.raw`, including unknown extensions. The embedded book stays inside the character card.
- `greeting: { requestedIndex, effectiveIndex, text, semantics: 'first-turn-reference' }`. Index 0 is the first greeting; alternatives start at 1. An out-of-range index clamps to the last greeting. No character means null effectiveIndex/text.
- `fieldLengths`: JSON Pointer relative to documents → `{ characters, utf16Units, utf8Bytes }`. Characters means Unicode code points, not grapheme clusters or model tokens. Array indices and escaped unknown extension keys are retained.
- `suggestedCallConfig`, `countUnit: 'unicode-code-points'` and a SHA-256 `revision` of all source fields excluding the revision itself.

Strings are not trimmed, macro-expanded or suppressed by user preferences. Returning creator notes or disabled fields does not make them model instructions. JSON formatting is not a byte-for-byte copy of the imported file. After resource editing, current normalized `data`/`prompts`/`book` is authoritative for current semantics; retained import `source.raw` must not override those edits.

Source reads do not invoke composers, match lore, consume greetings or expand random macros. They contain no full history, imported conversation bodies or credentials. Source revisions do not describe runtime activation or the final request.

The complete response is bounded at 16 MiB, including metadata. Traversal is bounded at 100000 nodes and 4096 characters per JSON Pointer. Oversized snapshots fail as a whole; no partial fields are returned.

## Backend service

The loader provides a frozen Cordis face named `pmpDshTavernPrompt`. Declare `inject: ['pmpDshTavernPrompt']` and read `ctx.get('pmpDshTavernPrompt')`.

Methods: `capabilities()`, `getSources(sessionId)`, `getMode(sessionId)`, `setMode(sessionId, body)`, `registerComposer({ id, compose })`, and `subscribe(listener)`.

Registration returns an idempotent disposer. Duplicate IDs fail. Bind registration to the consumer's lifecycle using `ctx.effect(() => prompt.registerComposer(...))`. Subscribe immediately delivers `{ type: 'invalidate' }` and repeats after resource API/mode/registry changes. Observer exceptions are isolated. Notifications contain no source text and are advisory invalidations, not a durable change stream; direct internal writes or file edits need a fresh read.

`compose({ sources, runtime })` is synchronous and receives:

- `kind: 'assembly'` for a real agent, otherwise `preview` for direct compilation.
- Resolved `macroContext: { user, character }`.
- `greetingReferenceApplies: boolean|null`, evaluated against durable user/assistant history; unknown previews use null.
- `loreEntries`, `worldBookAudit`, `activation` metadata and diagnostics from this same matching pass. These are matched candidates before the external composer's own output budget, not a final inclusion report.

Return only `{ sections, callConfig? }`. Up to 64 ordered sections contain `{ id, text }`; IDs match `[A-Za-z0-9][A-Za-z0-9._-]{0,79}` and must be unique. Names become `pmp-dsh-tavern:external:<owner>:<id>`. Total text plus separators must fit `maxProfileBytes` (default 512 KiB, hard maximum 2 MiB). An empty array explicitly injects no Tavern resource text.

`callConfig` allows only finite temperature, positive safe-integer maxTokens, reasoningEffort (`low|medium|high|xhigh`) and stop (up to 64 strings, each at most 4096 UTF-8 bytes). Omitting it applies no Tavern sampler override. Return `sources.suggestedCallConfig` to preserve the preset's mapped parameters. Model/provider/tools/messages overrides are rejected.

Promises, callback failures, invalid output and oversized content fail the assembly without builtin fallback. Callback error text is not copied into public errors. Callbacks must be fast and pure: no network, writes to selection, or recursive compilation. The composer owns macro/marker/override policy; unresolved `{{...}}` references reach DSH's strict interpolation. The package's `/format` export provides `renderSillyTavernMacros` for the supported Tavern subset.

The [runnable example](examples/prompt-composer.mjs) implements a fixed-slot policy with character switches, user persona, candidate lore and first-turn greeting checks. It intentionally does not emulate ST marker ordering, `{{original}}` overrides or real role/depth semantics. Loading it only registers availability; enable `example-manager` explicitly through PUT for each desired session.

## Browser integration

```js
const base = '/pmp-dsh-tavern/api/v3'
async function request(path, init = {}) {
  const response = await fetch(base + path, {
    credentials: 'same-origin', cache: 'no-store', ...init,
    headers: { Accept: 'application/json', ...init.headers },
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error), {
    code: result.code, status: response.status,
  })
  return result
}
async function setMode(sessionId, mode, owner = null) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/prompt-mode`
  const { composition } = await request(path)
  return request(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, owner, expectedRevision: composition.revision }),
  })
}
// Read sources without enabling external mode:
// await request(`/sessions/${encodeURIComponent(sessionId)}/prompt-sources`)
// After backend registration and explicit user choice:
// await setMode(sessionId, 'external', 'example-manager')
// Restore: await setMode(sessionId, 'builtin')
```

For inspectors, poll sources only while visible (about once per second), compare revisions, reread on focus/session changes, stop on disposal and discard late responses for a previously selected session. There is no v3 SSE/WebSocket endpoint. HTTP polling is not a per-request composition handoff.

## Ownership, persistence and limitations

The loader calls the composer once per AssembleContext and keeps that exact snapshot for `agent/request` sampling. The next assembly rereads bindings/resources. Named external sections are inserted at Tavern's existing profile position. Preset replace mode is disabled in external mode; native persona, tools, runtime contexts, variables, RP policy and durable history retain their owners.

Imported conversation context remains Tavern-managed and may still occupy `pmp-dsh-tavern:profile`. External composition does not take over imported history claims, emit fake messages or suppress security policy. Other DSH complete-section/assembly overrides can still supersede these sections; verify the actual request, not just returned composer text.

`prompt-composition.json` in loader storage atomically persists session→owner preferences, without resource bodies. Registry callbacks are in memory and must register again after restart. A missing owner blocks generation until restored or explicitly switched to builtin; source/mode reads remain available. Corrupted preference storage fails loading rather than silently restoring builtin injection.

New sessions, forks, swipe children and configuration templates do not inherit composition ownership automatically. Explicitly enable each target session even when its resource selection was copied. Removing Tavern leaves native DSH sessions/history usable.

v1 active remains a builtin-policy preview, not proof of external injection. Trace's assembly metadata additionally records external owner, source revision and section names; raw source snapshots are not persisted. Final system authority remains DSH's effective request/system-message surface.

## Errors and acceptance

Key errors: 400 `PROMPT_SESSION_INVALID|MODE_INVALID|COMPOSER_INVALID`; 404 `PROMPT_NOT_FOUND`; 405 `PROMPT_METHOD_NOT_ALLOWED`; 409 `PROMPT_REVISION_CONFLICT|AGENT_RUNNING|COMPOSER_CONFLICT|COMPOSER_UNAVAILABLE|RESOURCE_MISSING|COMPOSER_LIMIT|SESSION_LIMIT`; 413 `PROMPT_SOURCES_TOO_LARGE|OUTPUT_TOO_LARGE`; 422 `PROMPT_OUTPUT_INVALID`; 502 `PROMPT_COMPOSER_FAILED`. Request JSON parsing/size and Host/security errors retain their existing PLAY/TAVERN codes. Request bodies are limited to 2048 bytes.

See the [delivery and acceptance record](PROMPT_API_V3_REVIEW.md) for automated evidence and the remaining real UI/provider/third-party acceptance checks. This candidate does not claim complete SillyTavern message topology support or final manual acceptance.
