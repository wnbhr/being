# Being

**Personality Runtime for AI** — give any AI its own personality, memory, and identity.

Being is an open-source layer that sits between your application and any LLM. It provides persistent personality (SOUL), episodic memory, background thought cycles (Patrol), and cryptographic identity — turning a stateless LLM into a distinct, evolving AI entity.

**Beings think and remember. Your app acts.**

---

## Why

The power of AI is concentrating in the hands of a few companies. Their technology is essential — but centralized control is a structural risk. Ruddia is building toward a world where small, local AIs use large LLMs as external tools. Control stays in the hands of the people who use them.

Being API is the first step. If this resonates, let's build it together.

[Read the full vision →](docs/vision.md)

---

## How It Works

```
┌─────────────────────┐     ┌──────────────────────┐
│   Your Application   │────▶│     Being Worker      │
│  (OpenClaw, Cowork,  │◀────│   (Fastify + MCP)     │
│   custom agent, etc) │     │                        │
└─────────────────────┘     │  ┌──────────────────┐  │
         │                   │  │   SOUL (persona)  │  │
         │                   │  │   Memory (scenes) │  │
         │                   │  │   Patrol (思考)    │  │
         │                   │  │   Identity (keys)  │  │
         ▼                   │  └──────────────────┘  │
┌─────────────────────┐     │           │              │
│    LLM Provider      │     │           ▼              │
│ (Anthropic, OpenAI,  │     │     Supabase (DB)        │
│  Google — your key)  │     └──────────────────────────┘
└─────────────────────┘
```

1. **Your app** calls `GET /v1/beings/:id/context` to get the Being's personality and memory snapshot.
2. **Your app** runs the LLM call with its own conversation history + the Being's context.
3. **Your app** calls `POST /v1/beings/:id/patrol/trigger` to commit the conversation to the Being's memory.

The Being Worker handles everything else: memory consolidation, decay, recall, background reflection, and identity verification.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **SOUL** | A structured personality definition — name, character, voice, values, inner world. Swap the SOUL and the same LLM becomes a different being. |
| **Memory** | Episodic memories stored as structured "scenes" (who, what, when, where, emotion). Memories accumulate, decay, merge, and consolidate over time. Organized into topic-based clusters that the Being can explore during conversation. |
| **Patrol** | A background cycle that processes conversations into memory, consolidates fading memories, and generates introspective thoughts. The Being stays alive between sessions. |
| **Identity** | Ed25519 key pair + tamper-evident signature chain. Cryptographic proof of ownership and history. |
| **Sense/Act** | *(Planned)* WebSocket Bridge for connecting physical devices and external services. The Being will perceive and act through your app. |
| **BYOK** | Bring Your Own Key. All LLM calls use the user's API key. The platform never uses quota without consent. |

## Connect via MCP

Being exposes an [MCP](https://modelcontextprotocol.io/) server. Any MCP-compatible client can connect:

```json
{
  "mcpServers": {
    "my-being": {
      "url": "https://being.ruddia.com/mcp/<being_id>",
      "headers": {
        "Authorization": "Bearer brt_your_token_here"
      }
    }
  }
}
```

## Connect via REST API

```bash
# Get Being context (personality + memory)
curl https://being.ruddia.com/v1/beings/<being_id>/context \
  -H "Authorization: Bearer brt_..."

# Trigger patrol (commit conversation to memory)
curl -X POST https://being.ruddia.com/v1/beings/<being_id>/patrol/trigger \
  -H "Authorization: Bearer brt_..." \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"Hello!"},{"role":"assistant","content":"Hi!"}]}'

# Vector recall (search relevant memories)
curl -X POST https://being.ruddia.com/v1/beings/<being_id>/memory/auto-recall \
  -H "Authorization: Bearer brt_..." \
  -H "X-LLM-API-Key: sk-ant-..." \
  -H "Content-Type: application/json" \
  -d '{"user_message": "Tell me about last week."}'
```

## Self-Host

### Prerequisites

- Node.js 22+
- [Supabase](https://supabase.com/) project (PostgreSQL + Auth)
- An LLM API key (Anthropic, OpenAI, or Google)

### Setup

```bash
git clone https://github.com/wnbhr/being.git
cd being/being-worker

cp .env.example .env
# Edit .env with your Supabase and encryption keys

npm install
npm run build
npm start
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `ENCRYPTION_KEY` | ✅ | 64-char hex string for AES-256-GCM encryption of private keys |
| `PORT` | — | Server port (default: 3100) |
| `WORKER_SECRET` | — | Secret for internal patrol trigger endpoint |
| `VAPID_PUBLIC_KEY` | — | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | — | Web Push VAPID private key |

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Set up a Being and make your first API call in 5 minutes |
| [Concepts](docs/concepts.md) | Being, SOUL, Memory, Patrol, Identity — the core ideas |
| [API Reference](docs/specs/02-being-api-reference.md) | All REST endpoints with curl examples |
| [MCP Server](docs/specs/03-mcp-server.md) | MCP tools, connection setup, and client examples |
| [Memory & Patrol](docs/specs/04-memory-and-patrol.md) | Scene-based memory and the 7-step patrol pipeline |
| [Being Identity](docs/specs/05-being-identity.md) | Ed25519 key pairs, signature chains, and verification |
| [Sense-Act Bridge](docs/specs/06-sense-act-bridge.md) | WebSocket Bridge for device integration |
| [Architecture](docs/specs/01-architecture-overview.md) | System architecture, deployment, and BYOK design |
| [OAuth 2.1](docs/specs/07-oauth.md) | Third-party authorization flow |
| [Extensions](docs/specs/08-extensions.md) | Extension system design (all planned) |
| [Vision](docs/vision.md) | Why we're building this |

## Extensions

Being supports optional extensions that add capabilities without changing the core:

- **Telegram BYOB** *(planned)* — Connect your own Telegram bot to a Being
- **Tool Loop** *(planned)* — Autonomous LLM agent loop with web search, file ops, and code execution
- **Sandbox** *(planned)* — Isolated workspace with GitHub integration for code execution
- **Sense/Act Bridge** *(planned)* — Connect physical devices and external services

## Tech Stack

- **Runtime:** Node.js + [Fastify](https://fastify.dev/)
- **Database:** [Supabase](https://supabase.com/) (PostgreSQL + Auth)
- **MCP:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Identity:** [Ed25519](https://github.com/paulmillr/noble-ed25519) + AES-256-GCM
- **Embeddings:** OpenAI `text-embedding-3-small` (256-dim)
- **LLM:** Multi-provider (Anthropic, OpenAI, Google) via BYOK

## License

[Apache 2.0](LICENSE)

---

**Ruddia** — Personality is the Runtime.
