# Being Identity

Every Being owns an Ed25519 key pair that is generated at creation time. The private key never leaves the server; the public key is stored in plaintext and is freely queryable. Together with a tamper-evident signature chain, this lets anyone verify the authenticity and integrity of a Being's personality history.

## Key Pair

When a Being is created via `POST /v1/beings`, the worker immediately generates an Ed25519 key pair:

- **Public key** — 32 bytes (256-bit). Stored in `beings.public_key` as `"ed25519:<hex>"`.
- **Private key** — 32 bytes. Encrypted with AES-256-GCM and stored in `beings.encrypted_private_key`. Never exposed through any API.

Key generation uses `@noble/ed25519`, a pure JavaScript Ed25519 implementation.

### Private Key Encryption

The private key is encrypted before storage using a server-side secret (`ENCRYPTION_KEY`):

- Algorithm: **AES-256-GCM**
- Key: `ENCRYPTION_KEY` environment variable — a 64-character hex string (32 bytes). **Must never be exposed to clients.**
- IV: 12 random bytes, generated per encryption.
- Auth tag: 16 bytes (GCM integrity tag).
- Storage format: `base64(iv + tag + ciphertext)`.

The encryption key is server-side only. No client ever receives or can derive it.

## Genesis Signature

When a Being's SOUL is first initialized, the worker creates the genesis entry (sequence 0) in the signature chain:

1. Compute `payload_hash = SHA-256(soul_personality_json)` — a hex string.
2. Sign: `signature = Ed25519.sign(private_key, hex_to_bytes(payload_hash))`.
3. Insert into `signature_chain`: `{ being_id, seq: 0, event_type: "genesis", payload_hash, previous_sig: null, signature, signed_at }`.

The genesis entry's `previous_sig` is always `null` — it anchors the chain.

## Signature Chain

Every significant change to a Being (personality update, key transfer, etc.) appends a new entry to `signature_chain`:

| Field | Description |
|---|---|
| `seq` | Monotonically increasing integer. Starts at 0 (genesis). |
| `event_type` | `"genesis"`, `"update"`, `"transfer"`, or other event names. |
| `payload_hash` | SHA-256 hex of the event payload (see below). |
| `previous_sig` | The `signature` field from `seq - 1`. Forms the chain linkage. |
| `signature` | Ed25519 signature over `hex_to_bytes(payload_hash)`. |
| `signed_at` | ISO 8601 timestamp of when the entry was created. |

### Payload Hash Construction

| Event | Payload |
|---|---|
| `genesis` (seq=0) | `SHA-256(soul_initial_json)` |
| seq > 0 (update) | `SHA-256(diff_json + previous_signature_hex)` |

The payload hash is always expressed as a 64-character lowercase hex string. The signature is computed over the **raw 32 bytes** of that hash:

```
message_bytes = hex_to_bytes(payload_hash)   // 32 bytes
signature     = Ed25519.sign(private_key, message_bytes)
```

## Signature Verification

Verification uses only the public key — the private key is never involved.

```
valid = Ed25519.verify(public_key_bytes, signature_bytes, message_bytes)
where message_bytes = hex_to_bytes(payload_hash)
```

The worker uses the Web Crypto API (`crypto.subtle`) for verification:

```typescript
const cryptoKey = await crypto.subtle.importKey(
  'raw',
  publicKeyBytes.buffer,
  { name: 'Ed25519' },
  false,
  ['verify']
)
const valid = await crypto.subtle.verify(
  { name: 'Ed25519' },
  cryptoKey,
  signatureBytes.buffer,
  messageBytes.buffer   // hex_to_bytes(payload_hash) — 32 bytes
)
```

### Public Key Format

Public keys are stored and returned as `"ed25519:<64-char-hex>"`. The `ed25519:` prefix is stripped before hex-decoding to bytes.

### Key Sizes

| Item | Size |
|---|---|
| Private key | 32 bytes (256 bits) |
| Public key | 32 bytes (256 bits) |
| Signature | 64 bytes (512 bits) — Ed25519 produces 512-bit signatures |
| SHA-256 hash | 32 bytes (256 bits) |

Ed25519 uses SHA-512 internally as part of the signing algorithm (this is the standard RFC 8032 construction), but the **message input** is the raw 32-byte SHA-256 hash computed externally.

## API Endpoints

Identity endpoints are public — no authentication required.

### `GET /v1/beings/:being_id/identity`

Returns the Being's public key and a summary of its signature chain.

```bash
curl https://being.ruddia.com/v1/beings/<being_id>/identity
```

```json
{
  "being_id": "abc123",
  "public_key": "ed25519:a1b2c3d4...",
  "chain_length": 3,
  "latest_sig": "e5f6a7b8...",
  "latest_event": "update",
  "latest_seq": 2,
  "latest_at": "2026-04-14T10:00:00Z",
  "created_at": "2026-03-01T00:00:00Z"
}
```

### `GET /v1/beings/:being_id/identity/chain`

Returns paginated signature chain entries.

**Query params:** `limit` (max 200, default 50), `offset` (default 0).

```bash
curl "https://being.ruddia.com/v1/beings/<being_id>/identity/chain?limit=10"
```

```json
{
  "being_id": "abc123",
  "chain": [
    {
      "id": "...",
      "seq": 0,
      "event_type": "genesis",
      "payload_hash": "3d4e5f...",
      "previous_sig": null,
      "signature": "a1b2c3...",
      "created_at": "2026-03-01T00:00:00Z"
    }
  ],
  "total": 3,
  "limit": 10,
  "offset": 0
}
```

### `POST /v1/beings/:being_id/identity/verify`

Verifies the chain integrity over a given range: checks `previous_sig` continuity and re-verifies each Ed25519 signature.

```bash
curl -X POST https://being.ruddia.com/v1/beings/<being_id>/identity/verify \
  -H "Content-Type: application/json" \
  -d '{"from_seq": 0, "to_seq": 2}'
```

**Valid chain:**
```json
{
  "valid": true,
  "chain_length": 3,
  "from_seq": 0,
  "to_seq": 2
}
```

**Invalid chain:**
```json
{
  "valid": false,
  "chain_length": 3,
  "from_seq": 0,
  "to_seq": 2,
  "issues": [
    "seq 1: previous_sig mismatch (expected a1b2c3...)",
    "seq 2: Ed25519 signature verification failed"
  ]
}
```

The verification endpoint also catches:
- Sequence gaps (`seq` is not strictly sequential).
- Genesis entries with a non-null `previous_sig`.
- Unsigned entries (missing `signature`).
- Missing public key (verification is skipped and reported).

## Verification Example (from tests)

```typescript
// Genesis: sign sha256(soulText)
const soulText = JSON.stringify({ name: "Aria", personality: "calm and curious" })
const payloadHash = await sha256Hex(soulText)    // "3d4e5f..."
const signature = await sign(payloadHash)         // 64-byte Ed25519 sig (hex)

const valid = await verifyChainEntry(publicKeyStr, payloadHash, signature)
// => true

// Update (seq=1): sign sha256(diffJson + genesisSig)
const diffJson = JSON.stringify({ souls: [{ name: "Aria v2", updated_at: "2026-04-14" }] })
const seq1PayloadHash = await sha256Hex(diffJson + genesisSig)
const seq1Signature = await sign(seq1PayloadHash)

const valid2 = await verifyChainEntry(publicKeyStr, seq1PayloadHash, seq1Signature)
// => true

// Tampered signature — always fails
const tampered = await sha256Hex("other data")
const wrongSig = await sign(tampered)
const valid3 = await verifyChainEntry(publicKeyStr, payloadHash, wrongSig)
// => false
```

## Use Cases

- **Ownership proof** — A third party can call `GET /v1/beings/:id/identity` and verify that the public key matches a claimed identity without needing the private key.
- **Tamper detection** — Any modification to a historical signature chain entry (e.g., altering the SOUL retroactively) will cause signature verification to fail at that sequence number.
- **Being transfer** (planned) — The signature chain enables provable transfer of a Being from one owner to another, with the full history intact.

## Security Notes

- `ENCRYPTION_KEY` must be kept secret and rotated carefully — loss of this key makes the private key irrecoverable.
- The private key is decrypted in-memory only when signing is required. It is never written to logs or returned through any API endpoint.
- The public key endpoint (`/identity`) is intentionally unauthenticated — public keys are meant to be publicly verifiable.
