## Competitive Landscape

The wiki/knowledge management market is crowded and fragmenting away from Confluence (Atlassian), which dominates enterprise but is losing ground to modern, cleaner tools. Top competitors: **Notion** (flexible, consumer-friendly), **Outline** (open-source, clean UX), **GitBook** (developer-centric), **Nuclino** (lightweight, fast), and **Notion**-adjacent tools like **Slite** and **Tettra**. Confluence holds enterprise lock-in but has significant UX debt. The "basic clone" opportunity is in delivering Confluence's core page/space model with a modern editor and fast search.

## Must-Have Features

- [FEAT-001] Spaces — top-level containers grouping related pages (team, project, or department scope)
- [FEAT-002] Page tree / hierarchy — nested pages with parent-child relationships and sidebar navigation
- [FEAT-003] Rich text editor — block-based WYSIWYG with headings, tables, code blocks, images, and slash commands
- [FEAT-004] Page versioning / history — full revision history with diff view and restore
- [FEAT-005] Search — full-text search across all pages and spaces with result ranking
- [FEAT-006] In-page comments — inline and whole-page comment threads, resolvable
- [FEAT-007] User authentication — registration, login, session management, per-space access control
- [FEAT-008] Page permissions — view/edit permissions at space and page level
- [FEAT-009] Real-time collaborative editing — concurrent edit with conflict resolution (OT or CRDT)
- [FEAT-010] Attachments — file uploads embedded in pages (images, PDFs, docs)
- [FEAT-011] Labels / tags — page tagging for cross-space categorisation and filtering
- [FEAT-012] Page templates — predefined starting structures (meeting notes, project brief, etc.)

## Differentiating Opportunities

- [DIFF-001] Fast, relevant search — Confluence search is universally hated; vector + full-text hybrid search (e.g. pg_vector + tsvector) would be a meaningful differentiator
- [DIFF-002] Clean, Notion-style block editor — Confluence's editor feels heavy; a ProseMirror/TipTap block editor with smooth slash commands wins on UX
- [DIFF-003] Stale content alerts — surface pages unedited >90 days with a verification nudge; solves the "docs graveyard" complaint directly
- [DIFF-004] AI page summarisation — on-demand TL;DR for long pages; table stakes by 2026 but absent in many clones
- [DIFF-005] Dark mode + readable typography — trivial to implement, consistently cited in reviews as a missing feature in Confluence

## Common User Pain Points

- [PAIN-001] Search returns irrelevant results or misses pages entirely — the #1 complaint across Reddit, Capterra, and TrustRadius
- [PAIN-002] Navigation is overwhelming in large spaces — the page tree becomes unusable beyond ~200 pages with no smart folding or grouping
- [PAIN-003] Editor is slow on complex pages with many tables, macros, or embedded media
- [PAIN-004] "Docs graveyard" — no signal when content is outdated; stale pages proliferate silently
- [PAIN-005] PDF export produces broken formatting requiring manual cleanup before sharing
- [PAIN-006] Version diff UI is poor — hard to compare two arbitrary revisions or see who changed what on a specific line
- [PAIN-007] Steep learning curve for new users; space/page/template model is not discoverable
- [PAIN-008] Pricing scales aggressively per-seat; small teams hit the free tier ceiling quickly

## Tech Standards

- **Editor:** TipTap (ProseMirror-based) or Plate.js — industry standard for block editors in 2025–2026; used by Outline, Liveblocks demos, and most new wiki tools
- **Real-time sync:** Yjs (CRDT) + WebSocket (via `y-websocket` or Liveblocks) — standard for concurrent editing without OT complexity
- **Backend:** Node.js (NestJS or Hono) or Go for API; PostgreSQL as primary store with `tsvector` for full-text search
- **Auth:** JWT + refresh tokens; role-based access control (RBAC) at space and page level
- **Storage:** S3-compatible object storage for attachments (Cloudflare R2 or MinIO for self-hosted)
- **Frontend:** React + React Router or Next.js (App Router); Tailwind CSS for styling
- **Search augmentation:** `pg_trgm` + `tsvector` for basic; `pgvector` + embedding model for semantic search
- **Deployment:** Docker Compose for self-hosted; Railway/Render for managed; single-container target is preferred for "basic clone" scope

Sources:
- [Best Confluence Alternatives 2026 | Glitter AI](https://www.glitter.io/blog/knowledge-sharing/best-confluence-alternatives)
- [7 best Confluence alternatives to consider in 2026 | eesel AI](https://www.eesel.ai/blog/confluence-alternatives)
- [An honest Confluence review for 2025 | eesel AI](https://www.eesel.ai/blog/confluence-review)
- [Confluence Reviews 2026 | Capterra](https://www.capterra.com/p/136446/Confluence/reviews/)
- [Confluence Features | Atlassian](https://www.atlassian.com/software/confluence/features)
- [Top Confluence alternatives 2025 | GitBook Blog](https://www.gitbook.com/blog/confluence-alternatives)