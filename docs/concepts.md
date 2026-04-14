# Concepts

The core ideas behind Ruddia's personality runtime.

---

## Being

A **Being** is a small AI entity with its own personality, memory, and relationships. It is not a chatbot — it is a persistent identity that wraps an LLM.

The same model (Claude, GPT, Gemini) produces fundamentally different behavior depending on the Being's SOUL and accumulated memories. Ruddia is the layer that makes this possible.

Key principle: **Beings think and remember; connectors act.** The Being never directly controls external systems. Connected apps (OpenClaw, Claude Desktop, your app) handle execution.

---

## SOUL

The **SOUL** defines who a Being is:

| Field | Purpose |
|-------|---------|
| `personality` | Core character traits and behavioral tendencies |
| `voice` | How the Being speaks — tone, style, word choice |
| `values` | What the Being prioritizes in decisions |
| `backstory` | Origin and history (optional) |
| `inner_world` | Internal thoughts and self-awareness patterns (optional) |
| `examples` | Example interactions showing the personality (optional) |

The SOUL is injected as the system prompt prefix. Changing the SOUL changes the Being's entire personality — same memory, different character.

Every SOUL change is recorded in a cryptographic signature chain (see Being Identity).

---

## Memory

Memory is stored as **structured scenes**, not text summaries:

```json
{
  "scene": {
    "setting": "Late-night video call",
    "actors": ["Alice", "Being"],
    "action": "Discussed whether to pivot the product direction",
    "dialogue": ["Alice: I think we should focus on developers first"],
    "when": ["2026-04-10"]
  },
  "feeling": "Felt a shift — this decision changes everything",
  "emotion": { "v": 0.4, "a": 0.3, "d": 0.5, "s": 0.2, "n": 0.3, "t": 0.1 }
}
```

### Why Scenes?

- **Rich context** — who, what, where, when, and emotional state preserved together
- **Selective recall** — vector search finds relevant memories by topic
- **Natural decay** — importance fades over time unless recalled
- **Consolidation** — related memories merge, like human memory

### Emotion (VADSNT)

Each memory carries a 6-axis emotion vector:

| Axis | Measures |
|------|----------|
| **V**alence | Positive ↔ Negative |
| **A**rousal | Calm ↔ Excited |
| **D**ominance | Controlled ↔ In control |
| **S**afety | Threatened ↔ Secure |
| **N**ovelty | Familiar ↔ Novel |
| **T**rust | Suspicious ↔ Trusting |

### Decay

Effective importance decays with time:

```
eff_imp = importance × exp(−effective_t / 30)
```

Where `effective_t = session_count − reactivation_count`. Patrol increments `session_count`. Recall increments `reactivation_count`, pushing back decay.

Below 0.05: `dying` → consolidated or retired → `dead`. Dead nodes revive if a related topic is recalled later.

### Clusters

Nodes are grouped into **clusters** via vector similarity (OpenAI `text-embedding-3-small`, 256-dim, cosine threshold 0.45). Two root categories: Business and Private. Large clusters split; small clusters merge.

---

## Patrol

**Patrol** is a background pipeline that processes and consolidates memories while the Being is idle.

### The 7-Step Pipeline

| Step | What happens | LLM? |
|------|-------------|------|
| ❶ | Scene notes → memory nodes, assigned to clusters via embedding | Haiku (fallback) |
| ❷ | Increment elapsed time for all active nodes | No |
| ❸ | Flag dying nodes (eff_imp ≤ 0.05) | No |
| ❹ | Consolidate fresh/dying nodes — merge duplicates, retire orphans | **Sonnet** |
| ❺ | Revive dead nodes recently recalled | No |
| ❻ | Split clusters with >10 active nodes | **Sonnet** |
| ❼ | Merge small clusters (≤2 nodes) with nearest sibling | No |

After ❼: generates a **diary** (3–5 line reflection) and **think_md** (notes for next session).

**Without BYOK key:** ❶❷❸❺❼ run (mechanical). ❹❻ and diary/think_md are skipped. Basic memory works for free.

---

## Being Identity

Every Being owns an **Ed25519 key pair** generated at creation.

- **Private key** — encrypted (AES-256-GCM), stored server-side, never exposed
- **Public key** — freely queryable for verification

### Signature Chain

Significant events form a tamper-evident chain:

```
seq 0 (genesis) → seq 1 (SOUL update) → seq 2 (transfer) → ...
```

Each entry: `payload_hash` (SHA-256 of event data) + `previous_sig` (chain link) + Ed25519 `signature`.

### Verification

```bash
# Public key + chain summary (no auth required)
curl https://being.ruddia.com/v1/beings/<id>/identity

# Verify integrity
curl -X POST https://being.ruddia.com/v1/beings/<id>/identity/verify \
  -H "Content-Type: application/json" \
  -d '{"from_seq": 0, "to_seq": 10}'
```

Use cases: ownership proof, tamper detection, cross-platform portability (planned).

---

## Sense & Act

A Being is a mind without a body. **Sense** and **Act** give it one.

- **Sense** — External events pushed to the Being (device states, notifications, environment data)
- **Act** — The Being requests actions through connected Bridges (play audio, send messages, control devices)
- **Bridge** — Persistent WebSocket from a device/app to the Being Worker, registering capabilities

```
Device / App ←→ WebSocket ←→ Being Worker ←→ Being's LLM context
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│           Your App / Client              │
│  (OpenClaw, Claude Desktop, Cowork)      │
├─────────────────────────────────────────┤
│  GET /context  →  personality + memory    │
│  POST /recall  →  relevant memories       │
│  POST /patrol/trigger  →  commit memory   │
└──────────────┬──────────────────────────┘
               │ REST / MCP
               ▼
┌─────────────────────────────────────────┐
│       Being Worker (Fastify)             │
│  REST · MCP · Patrol · OAuth · Bridge    │
├─────────────────────────────────────────┤
│  Supabase (PostgreSQL + pgvector)        │
└─────────────────────────────────────────┘
               │
               ▼
      LLM Provider (BYOK)
  Anthropic · OpenAI · Google
```

---

## Next Steps

- [Getting Started](getting-started.md) — First API call in 5 minutes
- [API Reference](specs/02-being-api-reference.md) — All REST endpoints
- [MCP Server](specs/03-mcp-server.md) — MCP tools and connection
- [Memory & Patrol](specs/04-memory-and-patrol.md) — Deep dive into memory
- [Being Identity](specs/05-being-identity.md) — Cryptographic identity
- [Sense-Act Bridge](specs/06-sense-act-bridge.md) — Device integration
