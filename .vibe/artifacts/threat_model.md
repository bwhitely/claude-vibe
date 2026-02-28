# Threat Model

## Attack Surface
- [THREAT-001] `POST /auth/login`, `/auth/register` — no rate limit defined; credential stuffing and brute force vector
- [THREAT-002] `POST .../attachments` — arbitrary file upload; MIME sniffing bypass can deliver stored malicious payloads
- [THREAT-003] `GET /attachments/:attachmentId/url` — IDOR; any authenticated user may request pre-signed URLs for attachments on pages they cannot access
- [THREAT-004] `GET /search?q=` — pathological tsquery expressions trigger query planner stress; unbounded `q` length
- [THREAT-005] Page `content` JSONB — TipTap JSON may embed raw HTML nodes; stored XSS if client renders without sanitisation
- [THREAT-006] Comment `inline_anchor` JSONB — unvalidated schema; malformed structure may cause downstream parse errors or client crashes
- [THREAT-007] Page tree recursive CTE — unbounded depth; a deeply nested hierarchy causes O(n) recursion per tree-fetch request
- [THREAT-008] Refresh token cookie — replay window if not scoped to `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh`

## Authentication Strategy
RS256 JWT (15 min) + rotating refresh tokens (7 d, HttpOnly cookie) is correct. Implementation contract:
- Access token claims: `sub` (user UUID), `exp`, `iat`, `jti` (UUID)
- Raw refresh token: `crypto.randomBytes(32).toString('hex')`; persist only `SHA-256(raw)` in PostgreSQL and Redis; emit raw only in `Set-Cookie`
- Cookie attributes: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh`
- On Redis unavailability: **fail closed** — reject refresh if revocation check cannot complete
- Token rotation: revoke old hash atomically before issuing new (Redis `MULTI`/`EXEC` or Lua script; prevents TOCTOU race)

## Authorisation Model
Space RBAC (admin > editor > viewer) with page-level `inherit`/`restrict` overrides as defined in the architecture.

Enforcement gaps to close:
- `DELETE /spaces/:slug` — verify caller is space `admin`, not just any member
- `PATCH /comments/:commentId`, `DELETE /comments/:commentId` — verify `author_id = current_user` OR space `admin`
- `POST .../attachments` and `GET /attachments/:attachmentId/url` — run full page permission check before accepting upload or issuing pre-signed URL

## Sensitive Data Flows
- [DATA-001] Passwords — bcrypt cost=12; never log, never return in any response; zero from memory post-hash
- [DATA-002] Raw refresh token — `Set-Cookie` only; SHA-256 hash is the sole persisted form
- [DATA-003] `JWT_PRIVATE_KEY` — load at startup; fail fast if absent; never log
- [DATA-004] `storage_key` — never derived from user-supplied filename; generate as `{pageId}/{uuid}/{sanitised-name}`; never expose in API responses
- [DATA-005] Search queries — do not log raw `q`; log only query hash and result count (PII risk)

## Security Requirements
- [SEC-001] Rate-limit `POST /auth/login` and `/auth/register`: 10 req/min per IP via `@fastify/rate-limit`; return `429` with `Retry-After`
- [SEC-002] Validate attachment MIME type server-side using `file-type` (magic bytes); reject if not in allowlist (`image/*`, `application/pdf`, `text/*`, common office types); enforce 25 MB limit via Fastify `bodyLimit`
- [SEC-003] At `content_text` extraction time, strip all HTML from TipTap JSON; server must never render `content` JSONB as HTML — rendering is client-only via TipTap React
- [SEC-004] Validate `inline_anchor` against fixed schema: `{ from: int ≥ 0, to: int > from, text: string ≤ 500 chars }`; reject unknown keys with `400`
- [SEC-005] Cap recursive CTE depth at 10: add `WHERE depth < 10` guard in `WITH RECURSIVE` page tree query
- [SEC-006] Reject `q` > 500 chars with `400`; wrap `websearch_to_tsquery` in try/catch; return `400` on parse failure
- [SEC-007] Fastify CORS: explicit `origin` allowlist; never `*` on authenticated routes
- [SEC-008] Nginx: TLS 1.2+ only; emit `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin`
- [SEC-009] No raw SQL string interpolation; all queries via Prisma parameterised API or `$N` placeholders as shown in the search query
- [SEC-010] Background job: `DELETE FROM refresh_tokens WHERE expires_at < NOW()` — run every 24 h to prevent table bloat

## Input Validation Rules
- `/auth/register`: `email` RFC 5322, ≤ 254 chars; `password` 12–72 chars (bcrypt 72-byte truncation boundary — enforce max or document the limit); `username` `/^[a-z0-9_-]{3,30}$/`
- `/spaces` POST: `slug` `/^[a-z0-9-]{3,50}$/`; reject `slug` changes in `PATCH` (architecture marks immutable — enforce in handler)
- `/search`: `q` 1–500 chars required; `limit` 1–50; `page` 1–1000
- Attachment `filename`: strip `/`, `\`, `..` before storage; display original, store sanitised
- `content` JSONB at write: validate as valid TipTap document; reject if serialised size > 5 MB