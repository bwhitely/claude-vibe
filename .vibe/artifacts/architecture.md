# Architecture

## Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Fastify 4 — lower overhead than Express, native async/await, schema-driven request validation via JSON Schema; performance matters for REQ-NF-001 and REQ-NF-002
- **ORM:** Prisma 5 with PostgreSQL adapter — type-safe queries, migration tooling, generated client
- **Database:** PostgreSQL 16 — sole primary store (REQ-NF-005); `tsvector` GIN index for full-text search (REQ-F-007); recursive CTEs for the page tree (REQ-F-002)
- **Cache:** Redis 7 — refresh token revocation store (REQ-F-004) and search result cache keyed by normalised query+filters (REQ-NF-002); not a primary store so compatible with REQ-NF-005
- **Object Storage:** MinIO — S3-compatible, runs in docker-compose (REQ-NF-003); SDK-level abstraction means a real S3 bucket is a one-line env var swap in production (REQ-F-010)
- **Frontend:** React 18 + Vite + TipTap 2 + Tailwind CSS — TipTap is explicitly named in REQ-F-003; Vite for fast dev iteration
- **Reverse Proxy:** Nginx — TLS termination, static asset serving, gzip (REQ-NF-004)
- **Container:** Docker Compose v2 — all services in a single `docker compose up` (REQ-NF-003)
- **Auth:** Short-lived JWT access tokens (15 min, RS256) + long-lived refresh tokens (7 d, stored as SHA-256 hash in PostgreSQL, invalidation list in Redis) — REQ-F-004

---

## Service Boundaries

Single monolith. REQ-NF-003 mandates a single `docker-compose up`; the team size and feature count do not justify distributed services.

Internal module boundaries within the Fastify process:

| Module | Responsibility |
|---|---|
| `auth` | Registration, login, token issuance, refresh, logout, `currentUser` middleware |
| `spaces` | Space CRUD, slug routing, membership management |
| `permissions` | RBAC evaluation (space role resolution + page-level override); used by all other modules as a service |
| `pages` | Page CRUD, adjacency-list tree queries (recursive CTE), position/move operations |
| `versions` | Version snapshots on every save, list, restore |
| `editor` | TipTap JSON ↔ plain-text extraction (feeds `content_text` for FTS) |
| `search` | `tsvector` query construction, result ranking, cache read-through |
| `comments` | Thread creation, inline anchor storage, resolve/reopen |
| `attachments` | Multipart upload pipeline, MinIO/S3 key management, pre-signed URL generation |
| `templates` | System preset definitions, custom template CRUD, apply-to-page |
| `labels` | Label CRUD, page-label associations, cross-space filter queries |

---

## Data Model

```sql
-- ─────────────────────────────────────────────────────────
--  USERS & AUTH
-- ─────────────────────────────────────────────────────────

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  username      TEXT        NOT NULL UNIQUE,
  display_name  TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,          -- bcrypt cost=12
  avatar_url    TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refresh token table (access tokens are stateless JWT)
-- Revocation also mirrored to Redis SET with TTL for O(1) hot-path check
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE, -- SHA-256 of raw token, never store raw
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at); -- for GC job


-- ─────────────────────────────────────────────────────────
--  SPACES & MEMBERSHIP
-- ─────────────────────────────────────────────────────────

CREATE TABLE spaces (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT        NOT NULL UNIQUE,  -- URL-safe, immutable after creation
  name        TEXT        NOT NULL,
  description TEXT,
  icon        TEXT,                         -- emoji or URL
  is_public   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by  UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE TYPE space_role AS ENUM ('admin', 'editor', 'viewer');

CREATE TABLE space_members (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    UUID        NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        space_role  NOT NULL,
  granted_by  UUID        REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (space_id, user_id)
);
CREATE INDEX idx_space_members_user_id ON space_members(user_id);


-- ─────────────────────────────────────────────────────────
--  PAGES
-- ─────────────────────────────────────────────────────────

CREATE TABLE pages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id       UUID        NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id      UUID        REFERENCES pages(id) ON DELETE CASCADE,  -- NULL = space root
  title          TEXT        NOT NULL DEFAULT 'Untitled',
  slug           TEXT        NOT NULL,
  content        JSONB       NOT NULL DEFAULT '{}',   -- TipTap document JSON
  content_text   TEXT        NOT NULL DEFAULT '',     -- extracted plain text; written by editor module
  search_vector  TSVECTOR    GENERATED ALWAYS AS (
                   to_tsvector('english',
                     coalesce(title, '') || ' ' || coalesce(content_text, ''))
                 ) STORED,
  position       INTEGER     NOT NULL DEFAULT 0,      -- ordering within parent
  template_id    UUID        REFERENCES templates(id) ON DELETE SET NULL,
  created_by     UUID        NOT NULL REFERENCES users(id),
  updated_by     UUID        NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at    TIMESTAMPTZ,
  UNIQUE (space_id, parent_id, slug)
);
CREATE INDEX idx_pages_space_id        ON pages(space_id);
CREATE INDEX idx_pages_parent_id       ON pages(parent_id);
CREATE INDEX idx_pages_search_vector   ON pages USING GIN(search_vector);  -- REQ-F-007
CREATE INDEX idx_pages_updated_at      ON pages(updated_at);               -- stale content REQ-F-014


-- ─────────────────────────────────────────────────────────
--  PAGE VERSIONS  (REQ-F-008)
-- ─────────────────────────────────────────────────────────

CREATE TABLE page_versions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL,
  title          TEXT        NOT NULL,
  content        JSONB       NOT NULL,
  content_text   TEXT        NOT NULL,
  authored_by    UUID        NOT NULL REFERENCES users(id),
  change_summary TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, version_number)
);
CREATE INDEX idx_page_versions_page_id ON page_versions(page_id);
-- version_number is assigned by application: SELECT COALESCE(MAX(version_number),0)+1


-- ─────────────────────────────────────────────────────────
--  PAGE-LEVEL PERMISSIONS  (REQ-F-006)
-- ─────────────────────────────────────────────────────────

CREATE TYPE page_permission_mode AS ENUM ('inherit', 'restrict');
CREATE TYPE page_role AS ENUM ('editor', 'viewer');

-- One row per page that has an explicit mode set; absent = inherit
CREATE TABLE page_permission_settings (
  page_id  UUID               PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  mode     page_permission_mode NOT NULL DEFAULT 'inherit'
);

-- Per-user overrides when mode = 'restrict'
CREATE TABLE page_permission_entries (
  id       UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id  UUID      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id  UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     page_role NOT NULL,
  UNIQUE (page_id, user_id)
);
CREATE INDEX idx_page_perm_entries_page_id ON page_permission_entries(page_id);


-- ─────────────────────────────────────────────────────────
--  COMMENTS  (REQ-F-009)
-- ─────────────────────────────────────────────────────────

CREATE TABLE comments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id      UUID        REFERENCES comments(id) ON DELETE CASCADE,  -- NULL = thread root
  author_id      UUID        NOT NULL REFERENCES users(id),
  content        TEXT        NOT NULL,
  inline_anchor  JSONB,      -- { from: int, to: int, text: string } for inline highlights
  is_resolved    BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by    UUID        REFERENCES users(id),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ             -- soft delete
);
CREATE INDEX idx_comments_page_id   ON comments(page_id);
CREATE INDEX idx_comments_parent_id ON comments(parent_id);


-- ─────────────────────────────────────────────────────────
--  ATTACHMENTS  (REQ-F-010)
-- ─────────────────────────────────────────────────────────

CREATE TABLE attachments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  uploaded_by  UUID        NOT NULL REFERENCES users(id),
  filename     TEXT        NOT NULL,
  mime_type    TEXT        NOT NULL,
  size_bytes   BIGINT      NOT NULL,
  storage_key  TEXT        NOT NULL UNIQUE,  -- S3/MinIO object key; never expose directly
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_attachments_page_id ON attachments(page_id);


-- ─────────────────────────────────────────────────────────
--  TEMPLATES  (REQ-F-011)
-- ─────────────────────────────────────────────────────────

CREATE TYPE template_preset AS ENUM ('meeting_notes', 'project_brief', 'retrospective', 'custom');

CREATE TABLE templates (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT            NOT NULL,
  description TEXT,
  preset      template_preset NOT NULL DEFAULT 'custom',
  content     JSONB           NOT NULL,   -- TipTap document JSON
  created_by  UUID            REFERENCES users(id),   -- NULL = system preset
  space_id    UUID            REFERENCES spaces(id) ON DELETE CASCADE,  -- NULL = global
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────
--  LABELS  (REQ-F-012)
-- ─────────────────────────────────────────────────────────

CREATE TABLE labels (
  id       UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  name     TEXT  NOT NULL,
  color    TEXT  NOT NULL DEFAULT '#6366f1',
  space_id UUID  REFERENCES spaces(id) ON DELETE CASCADE,  -- NULL = global label
  UNIQUE (name, space_id)
);

CREATE TABLE page_labels (
  page_id   UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label_id  UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, label_id)
);
CREATE INDEX idx_page_labels_label_id ON page_labels(label_id);  -- cross-space filter REQ-F-012
```

---

## API Surface

All routes prefixed `/api/v1`. Authentication via `Authorization: Bearer <access_token>` except `/auth/register`, `/auth/login`, `/auth/refresh`.

### Auth — REQ-F-004

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| POST | `/auth/register` | Create account | `{ email, username, display_name, password }` | `{ user, access_token }` + Set-Cookie refresh |
| POST | `/auth/login` | Authenticate | `{ email, password }` | `{ user, access_token }` + Set-Cookie refresh |
| POST | `/auth/refresh` | Rotate tokens | Cookie: refresh_token | `{ access_token }` + Set-Cookie new refresh |
| POST | `/auth/logout` | Revoke session | Cookie: refresh_token | `204` |
| GET | `/auth/me` | Current user | — | `{ id, email, username, display_name, avatar_url }` |
| PATCH | `/auth/me` | Update profile | `{ display_name?, avatar_url? }` | `{ user }` |

### Spaces — REQ-F-001, REQ-F-005

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/spaces` | List accessible spaces | `?archived=false` | `{ spaces: Space[] }` |
| POST | `/spaces` | Create space | `{ name, slug, description?, icon?, is_public? }` | `{ space }` |
| GET | `/spaces/:slug` | Get space | — | `{ space, current_user_role }` |
| PATCH | `/spaces/:slug` | Update space | `{ name?, description?, icon?, is_public? }` | `{ space }` |
| DELETE | `/spaces/:slug` | Archive space | — | `204` |
| GET | `/spaces/:slug/members` | List members | — | `{ members: Member[] }` |
| POST | `/spaces/:slug/members` | Add member | `{ user_id, role }` | `{ member }` |
| PATCH | `/spaces/:slug/members/:userId` | Change role | `{ role }` | `{ member }` |
| DELETE | `/spaces/:slug/members/:userId` | Remove member | — | `204` |

### Pages — REQ-F-002, REQ-F-003

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/spaces/:slug/pages/tree` | Full page tree | — | `{ tree: PageNode[] }` (recursive, title+id+slug only) |
| POST | `/spaces/:slug/pages` | Create page | `{ title, parent_id?, template_id?, content? }` | `{ page }` |
| GET | `/spaces/:slug/pages/:pageId` | Get page + content | — | `{ page, permissions, labels, attachment_count }` |
| PATCH | `/spaces/:slug/pages/:pageId` | Save page | `{ title?, content?, content_text?, change_summary? }` | `{ page, version_number }` |
| DELETE | `/spaces/:slug/pages/:pageId` | Archive page | — | `204` |
| PATCH | `/spaces/:slug/pages/:pageId/move` | Move in tree | `{ parent_id, position }` | `{ page }` |

### Versions — REQ-F-008

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/spaces/:slug/pages/:pageId/versions` | List versions | `?page=1&limit=20` | `{ versions: VersionMeta[] }` |
| GET | `/spaces/:slug/pages/:pageId/versions/:num` | Get version | — | `{ version }` (full content) |
| POST | `/spaces/:slug/pages/:pageId/versions/:num/restore` | Restore version | `{ change_summary? }` | `{ page, new_version_number }` |

### Permissions — REQ-F-006

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/spaces/:slug/pages/:pageId/permissions` | Get page perms | — | `{ mode, entries: PermEntry[] }` |
| PUT | `/spaces/:slug/pages/:pageId/permissions` | Set page perms | `{ mode, entries: [{user_id, role}] }` | `{ mode, entries }` |

### Comments — REQ-F-009

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/spaces/:slug/pages/:pageId/comments` | List comments | `?resolved=false` | `{ threads: Thread[] }` |
| POST | `/spaces/:slug/pages/:pageId/comments` | Create comment | `{ content, parent_id?, inline_anchor? }` | `{ comment }` |
| PATCH | `/comments/:commentId` | Edit comment | `{ content }` | `{ comment }` |
| DELETE | `/comments/:commentId` | Soft delete | — | `204` |
| POST | `/comments/:commentId/resolve` | Resolve thread | — | `{ comment }` |
| POST | `/comments/:commentId/reopen` | Reopen thread | — | `{ comment }` |

### Attachments — REQ-F-010

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| POST | `/spaces/:slug/pages/:pageId/attachments` | Upload file | `multipart/form-data; file` | `{ attachment }` |
| GET | `/spaces/:slug/pages/:pageId/attachments` | List attachments | — | `{ attachments: Attachment[] }` |
| GET | `/attachments/:attachmentId/url` | Get download URL | — | `{ url, expires_at }` (pre-signed, 15 min TTL) |
| DELETE | `/attachments/:attachmentId` | Delete attachment | — | `204` |

### Search — REQ-F-007

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/search` | Full-text search | `?q=...&space_id=...&label_id=...&page=1&limit=20` | `{ results: Result[], total, page }` |

Search query execution:
```sql
SELECT p.id, p.title, p.space_id, s.name AS space_name,
       ts_rank(p.search_vector, query) AS rank,
       ts_headline('english', p.content_text, query,
                   'MaxWords=20, MinWords=10') AS excerpt
FROM pages p
JOIN spaces s ON s.id = p.space_id,
     websearch_to_tsquery('english', $1) query
WHERE p.search_vector @@ query
  AND ($2::uuid IS NULL OR p.space_id = $2)
  AND p.archived_at IS NULL
ORDER BY rank DESC
LIMIT $3 OFFSET $4;
```

Results cached in Redis at key `search:{sha256(q+space_id+label_id)}` with 60 s TTL (invalidated on any page save in affected space).

### Templates — REQ-F-011

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/templates` | List templates | `?space_id=&preset=` | `{ templates: Template[] }` |
| POST | `/templates` | Create custom | `{ name, content, space_id? }` | `{ template }` |
| GET | `/templates/:templateId` | Get template | — | `{ template }` |

### Labels — REQ-F-012

| Method | Path | Description | Request | Response |
|---|---|---|---|---|
| GET | `/labels` | List labels | `?space_id=` | `{ labels: Label[] }` |
| POST | `/labels` | Create label | `{ name, color?, space_id? }` | `{ label }` |
| DELETE | `/labels/:labelId` | Delete label | — | `204` |
| GET | `/pages` | Pages by label | `?label_id=...&page=1&limit=20` | `{ pages: PageSummary[] }` |
| POST | `/spaces/:slug/pages/:pageId/labels` | Attach label | `{ label_id }` | `204` |
| DELETE | `/spaces/:slug/pages/:pageId/labels/:labelId` | Remove label | — | `204` |

---

## Infrastructure

### `docker-compose.yml` services

| Service | Image | Role |
|---|---|---|
| `db` | `postgres:16-alpine` | Primary data store; persistent volume |
| `redis` | `redis:7-alpine` | Token revocation + search cache; AOF persistence |
| `minio` | `minio/minio:latest` | S3-compatible object storage; persistent volume |
| `app` | `node:20-alpine` (built) | Fastify API + static file serving (production build) |
| `nginx` | `nginx:1.25-alpine` | Reverse proxy; TLS termination; gzip; serves Vite build from `dist/` |

### Environment Variables (all secrets — REQ-NF-004)

```
DATABASE_URL          postgresql://user:pass@db:5432/wiki
REDIS_URL             redis://redis:6379
JWT_PRIVATE_KEY       <RS256 PEM, base64>
JWT_PUBLIC_KEY        <RS256 PEM, base64>
REFRESH_TOKEN_SECRET  <32-byte hex>
S3_ENDPOINT           http://minio:9000
S3_BUCKET             attachments
S3_ACCESS_KEY         ...
S3_SECRET_KEY         ...
```

### Indexes (performance rationale)

| Index | Table | Purpose |
|---|---|---|
| `GIN(search_vector)` | `pages` | Full-text search; required for `@@` operator performance at 100 k pages (REQ-NF-002) |
| `(space_id)` | `pages` | Space-scoped page tree queries |
| `(parent_id)` | `pages` | Recursive CTE child lookup |
| `(updated_at)` | `pages` | Stale content query (REQ-F-014) |
| `(label_id)` | `page_labels` | Cross-space label filter (REQ-F-012) |
| `(page_id)` | `page_versions` | Version list by page |
| `(user_id)` | `space_members` | "What spaces can this user see?" access check |
| `(expires_at)` | `refresh_tokens` | Periodic GC of expired tokens |

### Permission Evaluation Algorithm

Permission check order for a user accessing a page (called on every request via middleware):

1. Load user's `space_members` row for the page's space. If absent and `is_public = false` → `403`.
2. Look up `page_permission_settings.mode` for the page. If absent or `inherit` → use space role.
3. If `restrict`: look up `page_permission_entries` for the user. If present → use page role. If absent → `403` (restriction excludes users not listed).
4. Minimum required role is checked against the resolved role (`viewer` ≤ `editor` ≤ `admin`).

This is a pure DB read path (two indexed point lookups); no middleware chain recursion.