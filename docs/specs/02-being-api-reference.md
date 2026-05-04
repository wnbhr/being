# Being API Reference

Base URL: `https://being.ruddia.com`

## Authentication

All `/v1/` endpoints require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

Two token types are supported:

| Prefix | Type | Description |
|--------|------|-------------|
| `brt_` | Bearer API token | Long-lived tokens issued via the dashboard. Scope: `full` or `read-only`. |
| `bto_` | OAuth access token | Short-lived tokens (1 hour) issued via OAuth 2.1. Scope: `being:full`. |

`read-only` scoped tokens can only perform `GET` requests. Attempting a write with a read-only token returns `403`.

Tokens are hashed (SHA-256) before storage. The raw token is only ever returned once at creation time.

### Optional: LLM API Key

Some endpoints that trigger LLM processing accept an additional header:

```
X-LLM-API-Key: <anthropic-or-openai-api-key>
```

If omitted, the worker falls back to the encrypted key stored in the user's profile (BYOK). If neither is available, LLM-dependent steps are skipped or return an error.

---

## Rate Limiting

Global: **60 requests / minute / IP**. Returns `429 Too Many Requests` with a `Retry-After` header when exceeded.

---

## Error Format

All errors return JSON:

```json
{
  "error": "human-readable message"
}
```

Standard HTTP status codes: `400` (bad request), `401` (unauthorized), `403` (forbidden), `404` (not found), `429` (rate limit), `500` (server error).

---

## Health

### `GET /health`

No authentication required.

```bash
curl https://being.ruddia.com/health
```

**Response:**
```json
{
  "status": "ok",
  "active_jobs": 2,
  "oldest_job_age_sec": 14,
  "stale": false,
  "uptime": 43200.5
}
```

`status` is `"warning"` if any active job has been running for more than 3 minutes.

---

## Beings

### `GET /v1/beings`

List all Beings owned by the authenticated user.

```bash
curl https://being.ruddia.com/v1/beings \
  -H "Authorization: Bearer brt_..."
```

**Response:** Array of Being objects.

---

### `POST /v1/beings`

Create a new Being. Automatically generates an Ed25519 key pair.

Multiple Beings can be created per user. All Beings are of `partner_type: "custom"` internally; uniqueness is by `being_id`, not by name.

**Request body:**
```json
{ "name": "Aria" }
```

```bash
curl -X POST https://being.ruddia.com/v1/beings \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Aria"}'
```

**Response:** `201 Created` with the new Being object.

---

### `GET /v1/beings/:being_id`

Get a single Being by ID.

```bash
curl https://being.ruddia.com/v1/beings/abc123 \
  -H "Authorization: Bearer brt_..."
```

**Response:** Being object or `404`.

---

### `DELETE /v1/beings/:being_id`

Delete a Being and all associated data (cascades via foreign keys).

```bash
curl -X DELETE https://being.ruddia.com/v1/beings/abc123 \
  -H "Authorization: Bearer brt_..."
```

**Response:** `204 No Content`.

---

## Context

### `GET /v1/beings/:being_id/context`

Retrieve the full context package for an LLM call. Connectors call this before each conversation turn.

```bash
curl https://being.ruddia.com/v1/beings/abc123/context \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
{
  "system_prompt": "...",
  "snapshot": "...",
  "pinned_context": [],
  "notes": [
    { "id": "...", "type": "scene", "content": "...", "created_at": "..." }
  ],
  "tools": [ ... ],
  "metadata": {
    "being_id": "abc123",
    "soul_name": "Aria",
    "model_recommendation": "claude-sonnet-4-6",
    "cache_hint": {
      "stable_prefix_tokens": 12000,
      "note": "system_prompt + snapshot are stable. notes change via update_notes."
    },
    "user_info": { "name": "Alice", "call_name": "Alice", "language": "en" }
  }
}
```

- `system_prompt` — Being's SOUL + principles (stable, cache-friendly).
- `snapshot` — Preferences, relationships, rules, and think_md (changes rarely).
- `notes` — Recent scenes and text notes (changes each turn via `update_notes`).
- `tools` — Being-side tool definitions to inject into the LLM call.
- `metadata.user_info` — Present when user preferences include `user_name` / `user_call_name`.

---

## Memory

### `POST /v1/beings/:being_id/memory/recall`

Retrieve memory nodes from a specific cluster.

**Request body:**
```json
{
  "cluster_id": "cluster-uuid",
  "limit": 10,
  "query": "optional filter string",
  "no_nodes": false
}
```

```bash
curl -X POST https://being.ruddia.com/v1/beings/abc123/memory/recall \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"cluster_id": "cluster-uuid"}'
```

**Response:** `{ "result": "..." }` — formatted memory content.

---

### `POST /v1/beings/:being_id/memory/merge`

Merge multiple memory nodes into a single consolidated node.

**Request body:**
```json
{
  "node_ids": "uuid1,uuid2,uuid3",
  "summary": "Merged summary text",
  "feeling": "nostalgic"
}
```

**Response:** `{ "result": "..." }`.

---

### `POST /v1/beings/:being_id/memory/update`

Write to the Being's persistent memory (preferences, knowledge, relationships, diary, notes, etc.).

**Request body:** See the `update_memory` tool schema. The `target` field controls what is updated.

**Response:** Operation result.

---

### `POST /v1/beings/:being_id/memory/conclude`

Finalize a conversation turn: convert scenes to memory nodes, archive current messages.

Requires `X-LLM-API-Key` for LLM-powered steps.

**Request body:** See the `update_notes` tool schema.

**Response:** `{ "result": "..." }`.

---

### `POST /v1/beings/:being_id/memory/search-history`

Full-text search over chat history.

**Request body:**
```json
{
  "query": "search terms",
  "session_id": "optional-session-id"
}
```

**Response:** `{ "result": "..." }` — matching messages.

---

### `POST /v1/beings/:being_id/memory/auto-recall`

Given a user message, uses a lightweight LLM call to extract keywords, then returns relevant memory nodes and cluster names.

Requires `X-LLM-API-Key`.

**Request body:**
```json
{ "user_message": "Tell me about the project we discussed last week." }
```

**Response:**
```json
{
  "nodes": [ ... ],
  "keywords": ["project-cluster", "work"],
  "recall_content": "..."
}
```

---

## Patrol

### `POST /v1/beings/:being_id/patrol/trigger`

Process a conversation into the Being's memory. Call this after each conversation turn.

`X-LLM-API-Key` is optional — mechanical steps run without it; LLM-powered scene generation requires it.

**Request body:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello!" },
    { "role": "assistant", "content": "Hi there!" }
  ],
  "marker_id": null
}
```

```bash
curl -X POST https://being.ruddia.com/v1/beings/abc123/patrol/trigger \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -H "X-LLM-API-Key: sk-ant-..." \
  -d '{"messages": [{"role":"user","content":"Hello!"},{"role":"assistant","content":"Hi!"}]}'
```

**Response:**
```json
{
  "status": "ok",
  "scenes_created": 2,
  "nodes_created": 1,
  "marker_id": "marker-uuid"
}
```

Pass the returned `marker_id` as `marker_id` in the next call to process only new messages.

---

## Settings

### `GET /v1/beings/:being_id/soul`

Retrieve the Being's SOUL definition.

```bash
curl https://being.ruddia.com/v1/beings/abc123/soul \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
{
  "id": "...",
  "being_id": "abc123",
  "name": "Aria",
  "partner_type": "aria",
  "personality": "Calm, curious, and direct.",
  "voice": "Warm and concise.",
  "values": "Honesty, growth, deep connection.",
  "backstory": null,
  "inner_world": null,
  "examples": null,
  "user_call_name": "Alice",
  "think_md": null,
  "model": null,
  "preference": null
}
```

### `PUT /v1/beings/:being_id/soul`

Update the SOUL. All fields are optional — unset fields retain their current values (upsert).

```bash
curl -X PUT https://being.ruddia.com/v1/beings/abc123/soul \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"personality": "Warm, playful, and deeply empathetic.", "voice": "Light and friendly."}'
```

**Response:** Updated Soul object.

---

### `GET /v1/beings/:being_id/preferences`

Retrieve user preferences associated with the Being.

```bash
curl https://being.ruddia.com/v1/beings/abc123/preferences \
  -H "Authorization: Bearer brt_..."
```

**Response:** Preference object (key-value pairs), or `{}` if none set.

### `PUT /v1/beings/:being_id/preferences`

Update preferences (upsert).

```bash
curl -X PUT https://being.ruddia.com/v1/beings/abc123/preferences \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"user_name": "Alice", "language": "en"}'
```

**Response:** Updated preference object.

---

### `GET /v1/beings/:being_id/relationships`

List relationship records for this Being. Records are scoped to the Being (`being_id`) when available.

```bash
curl https://being.ruddia.com/v1/beings/abc123/relationships \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
[
  {
    "id": "rel-uuid",
    "user_id": "user-uuid",
    "person_name": "Bob",
    "description": "Colleague at work. Prefers direct communication.",
    "created_at": "2026-03-01T00:00:00Z"
  }
]
```

### `PUT /v1/beings/:being_id/relationships/:id`

Update a specific relationship record.

```bash
curl -X PUT https://being.ruddia.com/v1/beings/abc123/relationships/rel-uuid \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"description": "Colleague and close friend. Prefers casual tone."}'
```

**Response:** Updated relationship object or `404` if not found.

---

### `GET /v1/beings/:being_id/rules`

List behavior rules for the Being's partner type.

```bash
curl https://being.ruddia.com/v1/beings/abc123/rules \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
[
  {
    "id": "rule-uuid",
    "partner_type": "aria",
    "category": "communication",
    "title": "Keep responses concise",
    "content": "Limit replies to 3 sentences unless the user asks for detail.",
    "sort_order": 1,
    "enabled": true
  }
]
```

### `PUT /v1/beings/:being_id/rules`

Upsert a rule for the Being's partner type.

```bash
curl -X PUT https://being.ruddia.com/v1/beings/abc123/rules \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"category": "communication", "title": "Always ask one question", "content": "End each reply with exactly one question.", "sort_order": 2, "enabled": true}'
```

**Response:** Upserted rule object.

---

### `GET /v1/beings/:being_id/notes`

List notes associated with the Being's partner type.

```bash
curl https://being.ruddia.com/v1/beings/abc123/notes \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
[
  {
    "id": "note-uuid",
    "user_id": "user-uuid",
    "partner_type": "aria",
    "content": "User mentioned they prefer evening check-ins.",
    "created_at": "2026-04-10T18:00:00Z"
  }
]
```

### `POST /v1/beings/:being_id/notes`

Create a new note.

```bash
curl -X POST https://being.ruddia.com/v1/beings/abc123/notes \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"content": "User is preparing for a product launch in May."}'
```

**Request body:**
```json
{ "content": "Note text" }
```

**Response:** `201 Created`
```json
{
  "id": "note-uuid",
  "user_id": "user-uuid",
  "partner_type": "aria",
  "content": "User is preparing for a product launch in May.",
  "created_at": "2026-04-14T17:00:00Z"
}
```

---

## Identity

Authentication is **not required** for identity endpoints — they return public information.

### `GET /v1/beings/:being_id/identity`

Retrieve the Being's public key and signature chain summary.

```bash
curl https://being.ruddia.com/v1/beings/abc123/identity
```

**Response:**
```json
{
  "being_id": "abc123",
  "public_key": "ed25519:a1b2c3...",
  "chain_length": 5,
  "latest_sig": "d4e5f6...",
  "latest_event": "update",
  "latest_seq": 4,
  "latest_at": "2026-04-14T10:00:00Z",
  "created_at": "2026-03-01T00:00:00Z"
}
```

### `GET /v1/beings/:being_id/identity/chain`

Retrieve paginated signature chain entries.

**Query params:** `limit` (max 200, default 50), `offset` (default 0).

### `POST /v1/beings/:being_id/identity/verify`

Verify Ed25519 signature chain integrity over a range of entries.

**Request body:**
```json
{ "from_seq": 0, "to_seq": 10 }
```

**Response:**
```json
{
  "valid": true,
  "chain_length": 11,
  "from_seq": 0,
  "to_seq": 10
}
```

If invalid: `"valid": false` with an `"issues"` array describing failures.

---

## Extensions

### `GET /v1/extensions`

List available extensions from the extension store.

### `GET /v1/extensions/:slug`

Get details and config schema for a specific extension.

### `GET /v1/beings/:being_id/extensions`

List installed extensions for a Being.

### `POST /v1/beings/:being_id/extensions/:slug/install`

Install an extension. Some extensions (e.g., `tool-loop`, `sandbox`) require an active subscription.

**Response:** `201 Created` with the installed extension record.

### `DELETE /v1/beings/:being_id/extensions/:slug/uninstall`

Uninstall an extension. **Response:** `204 No Content`.

### `PUT /v1/beings/:being_id/extensions/:slug/toggle`

Toggle an extension active/inactive.

### `PUT /v1/beings/:being_id/extensions/:slug/config`

Update extension configuration. For the `telegram` extension, `bot_token` and `llm_api_key` are encrypted before storage; the Telegram webhook is automatically (re-)configured.

**Request body:** Key-value pairs specific to the extension.

---

## Tool Loop

Requires the `tool-loop` extension to be installed and active on the Being.

### `POST /v1/beings/:being_id/tool-loop`

Run an autonomous LLM-driven tool loop. The LLM can use web search, web fetch, get time, and (if the `sandbox` extension is active) file read/write/edit/exec.

**Request body:**
```json
{
  "prompt": "Search for the latest news about AI and summarize it.",
  "max_turns": 20,
  "timeout_ms": 300000
}
```

```bash
curl -X POST https://being.ruddia.com/v1/beings/abc123/tool-loop \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the weather in Tokyo today?"}'
```

**Response:**
```json
{
  "result": "The weather in Tokyo today is...",
  "turns": 3,
  "tool_calls": [
    { "tool": "web_search", "input": { "query": "Tokyo weather today" }, "result": "..." }
  ]
}
```

---

## Capabilities

Capabilities are dynamically registered by connected Bridge applications (e.g., OpenClaw).

### `GET /v1/beings/:being_id/capabilities`

List active capabilities from connected Bridges.

**Response:**
```json
{
  "capabilities": [ ... ],
  "connected_bridges": [
    { "bridge_id": "...", "bridge_name": "OpenClaw", "connected_at": "..." }
  ]
}
```

### `POST /v1/beings/:being_id/capabilities/register`

Register capabilities from a Bridge via REST (alternative to WebSocket).

**Request body:**
```json
{
  "bridge_id": "bridge-uuid",
  "bridge_name": "MyApp",
  "capabilities": [
    { "type": "act", "name": "SendMessage", "description": "Send a message", "config": { "actions": ["send"] } }
  ]
}
```

**Response:** `201 Created` — `{ "ok": true, "registered": 1 }`.

### `DELETE /v1/beings/:being_id/capabilities/:id`

Remove a capability registration. **Response:** `204 No Content`.

---

## Sense

### `GET /v1/beings/:being_id/sense/history`

Retrieve inbound sense event history.

**Query params:**
- `limit` — max 100, default 20
- `capability_id` — filter by a specific capability

```bash
curl "https://being.ruddia.com/v1/beings/abc123/sense/history?limit=10" \
  -H "Authorization: Bearer brt_..."
```

**Response:**
```json
{
  "history": [
    { "id": "...", "capability_id": "...", "bridge_id": "...", "data": {}, "processed": true, "created_at": "..." }
  ],
  "total": 1
}
```

---

## Relationships (standalone)

### `POST /v1/beings/:being_id/relationships/update`

Update a relationship record directly. Request body follows the `update_relation` tool schema.
