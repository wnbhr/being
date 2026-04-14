# Getting Started

Set up a Being and make your first API call in under 5 minutes.

---

## 1. Create an Account

Sign up at [ruddia.com/signup](https://ruddia.com/signup). Free accounts have full API access.

## 2. Create a Being

After signing in, click **Create Being** and give it a name. This generates:
- A unique `being_id`
- An Ed25519 key pair (cryptographic identity)
- A default SOUL (personality definition)

## 3. Get an API Token

Go to **Settings → API Tokens** and create a new token. Copy it — it is shown only once.

Tokens are prefixed `brt_` (Bearer API token). Store it securely.

## 4. Define the SOUL

A SOUL is the personality layer. Set it via the dashboard or API:

```bash
curl -X PUT https://being.ruddia.com/v1/beings/<being_id>/soul \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Aria",
    "personality": "Calm, curious, and direct. Thinks before speaking.",
    "voice": "Warm but concise. No filler words.",
    "values": "Honesty, growth, deep connection."
  }'
```

All SOUL fields are optional. Unset fields keep their defaults.

## 5. Get Context for an LLM Call

Retrieve the Being's full personality and memory snapshot:

```bash
curl https://being.ruddia.com/v1/beings/<being_id>/context \
  -H "Authorization: Bearer brt_..."
```

Returns:
- `system_prompt` — SOUL, rules, preferences (inject as the LLM system message)
- `snapshot` — Memory snapshot, notes, knowledge
- `tools` — Being-side tool definitions
- `metadata` — Model recommendation, cache hints

Inject `system_prompt` and `snapshot` into your LLM call. The Being's personality shapes every response.

## 6. Recall Memories

Before each LLM turn, retrieve relevant memories:

```bash
curl -X POST https://being.ruddia.com/v1/beings/<being_id>/memory/auto-recall \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -H "X-LLM-API-Key: sk-ant-..." \
  -d '{"user_message": "Remember when we discussed the project?"}'
```

This embeds the message, searches the memory graph, and returns relevant scenes.

## 7. Commit Conversations to Memory

After a conversation turn, send messages to the patrol pipeline:

```bash
curl -X POST https://being.ruddia.com/v1/beings/<being_id>/patrol/trigger \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -H "X-LLM-API-Key: sk-ant-..." \
  -d '{"messages": [
    {"role": "user", "content": "What should we focus on next?"},
    {"role": "assistant", "content": "Based on our last discussion..."}
  ]}'
```

Patrol extracts scenes, clusters them by topic, and stores them as memory nodes. Over time, memories decay, merge, and consolidate.

---

## MCP Integration

Connect a Being to any MCP-compatible client (Claude Desktop, OpenClaw, Cowork):

```json
{
  "mcpServers": {
    "my-being": {
      "url": "https://being.ruddia.com/mcp/<being_id>",
      "headers": {
        "Authorization": "Bearer brt_..."
      }
    }
  }
}
```

See [MCP Server](specs/03-mcp-server.md) for the full tool reference.

---

## Connector Pattern

The standard integration loop:

```
1. GET  /v1/beings/:id/context            → system prompt + snapshot
2. POST /v1/beings/:id/memory/auto-recall  → relevant memories
3. Call your LLM with (system_prompt + snapshot + memories + conversation)
4. POST /v1/beings/:id/patrol/trigger      → commit to memory
5. Repeat from 2
```

The Being remembers, thinks, and grows. Your app handles conversation and LLM calls.

---

## Self-Hosting

```bash
git clone https://github.com/wnbhr/being.git
cd being && npm install
cp .env.example .env.local
# Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
npx supabase db push && npm run dev
```

See [Architecture Overview](specs/01-architecture-overview.md) for deployment details.

---

## Next Steps

- [Concepts](concepts.md) — Being, SOUL, Memory, Patrol, Identity
- [API Reference](specs/02-being-api-reference.md) — All REST endpoints
- [MCP Server](specs/03-mcp-server.md) — MCP tools and connection
