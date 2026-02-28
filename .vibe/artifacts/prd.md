# PRD: Confluence Clone (Basic)

## Goal
Build a self-hosted, modern wiki with Confluence's core space/page model, a clean block editor, and fast full-text search.

---

## MVP Scope — Required

- **REQ-F-001**: Spaces as top-level containers grouping pages by team or project — `required`
- **REQ-F-002**: Nested page tree with unlimited depth and collapsible sidebar navigation — `required`
- **REQ-F-003**: Block-based rich text editor (TipTap) supporting headings, tables, code blocks, image embeds, and slash commands — `required`
- **REQ-F-004**: User registration, login, and JWT + refresh-token session management — `required`
- **REQ-F-005**: RBAC at space level with admin / editor / viewer roles — `required`
- **REQ-F-006**: Page-level permission overrides (inherit or restrict from space defaults) — `required`
- **REQ-F-007**: Full-text search across all pages and spaces via PostgreSQL `tsvector` with result ranking — `required`
- **REQ-F-008**: Full page revision history with restore to any prior version — `required`
- **REQ-F-009**: Inline and page-level comment threads with resolve / reopen — `required`
- **REQ-F-010**: File and image attachment uploads stored in S3-compatible object storage — `required`
- **REQ-F-011**: Page templates with at least three presets (meeting notes, project brief, retrospective) — `required`
- **REQ-F-012**: Labels / tags on pages with cross-space filter view — `required`

---

## MVP Scope — Nice-to-Have

- **REQ-F-013**: Side-by-side or unified diff view between two arbitrary revisions — `nice-to-have`
- **REQ-F-014**: Stale content alerts surfacing pages unedited >90 days — `nice-to-have`
- **REQ-F-015**: Dark mode toggle — `nice-to-have`
- **REQ-F-016**: Space-level activity feed showing recent edits and comments — `nice-to-have`

---

## Non-Functional Requirements

- **REQ-NF-001**: Page render <2 s on pages with up to 50 embedded assets (P95)
- **REQ-NF-002**: Search response <500 ms for corpora up to 100 k pages (P95)
- **REQ-NF-003**: Full deployment via single `docker-compose up`; no external managed services required
- **REQ-NF-004**: HTTPS enforced; all secrets via env vars; no credentials or PII in application logs
- **REQ-NF-005**: PostgreSQL as sole primary data store — no Elasticsearch or separate search service at MVP

---

## Post-MVP

- Real-time collaborative editing (Yjs CRDT + WebSocket)
- Semantic / vector search (`pgvector` + embedding model)
- AI on-demand page summarisation
- PDF export with clean formatting
- SSO via SAML 2.0 / OIDC
- Confluence-compatible import / migration tool

---

## Out of Scope

- Native iOS / Android apps
- Plugin / marketplace system
- Whiteboards or embedded diagramming (Gliffy / draw.io equivalent)
- Billing, subscription management, or per-seat enforcement
- Confluence API compatibility layer