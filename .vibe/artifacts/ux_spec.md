# UX Specification

## Design Direction

**Style:** Editorial / archival — document-first, low chrome. Warm paper tones with deep green actions. Avoids startup-blue defaults.

**Palette:**
- Background: `#F7F5F0` · Surface: `#FFFFFF` · Border: `#E7E5E0`
- Primary: `#1B4332` (forest green) · Hover: `#2D6A4F`
- Text: `#1C1917` · Muted: `#78716C`
- Accent: `#D97706` (amber — labels, alerts) · Danger: `#DC2626`

**Typography:** Headings — `Lora` (serif, editorial weight); UI chrome — `Inter`; Code — `JetBrains Mono`

**Layout:** Fixed left sidebar (240px, collapsible) + fluid main area. Max content width 800px centred. Responsive: sidebar collapses to hamburger sheet at <768px.

---

## Screen Inventory

1. **AuthScreen** — Login / register (REQ-F-004)
2. **SpaceDirectory** — Card grid of all accessible spaces (REQ-F-001)
3. **SpaceView** — Space home with page-tree sidebar (REQ-F-001, REQ-F-002)
4. **PageView** — Read-mode page, comments, attachments (REQ-F-003, REQ-F-009, REQ-F-010, REQ-F-012)
5. **PageEditor** — TipTap block editor + slash commands (REQ-F-003, REQ-F-010, REQ-F-011)
6. **TemplatePicker** — Modal overlay; preset + custom templates (REQ-F-011)
7. **PageHistory** — Version list + preview pane (REQ-F-008)
8. **PagePermissions** — Mode toggle + user-role table (REQ-F-006)
9. **SearchResults** — Query bar, filters, ranked results (REQ-F-007)
10. **LabelsBrowser** — Cross-space pages-by-label view (REQ-F-012)
11. **SpaceSettings** — Member list, role management (REQ-F-005)
12. **UserSettings** — Profile, avatar (REQ-F-004)

---

## User Flows

### 1 · New User Onboarding
1. User lands on `/login`, selects Register tab
2. Submits email + username + password → JWT issued, redirect to SpaceDirectory
3. SpaceDirectory empty-state CTA → Create Space modal (name, slug, icon)
4. Space created → redirect to SpaceView with TemplatePicker open for first page
5. User picks "Project Brief" preset → PageEditor opens pre-filled

### 2 · Daily Navigation
1. User authenticates → SpaceDirectory shows spaces sorted by recent activity
2. Clicks space card → SpaceView; sidebar renders PageTree
3. Expands tree nodes; clicks page → PageView loads content
4. Breadcrumb always visible for orientation

### 3 · Edit & Save Page
1. In PageView, user clicks **Edit** → switches to PageEditor (same URL, mode param)
2. Editor renders TipTap with existing content; slash-command menu on `/`
3. Auto-save every 30 s (debounced); status indicator in `EditorStatusBar`
4. User clicks **Save** → PATCH `/pages/:id`; new version snapshot created silently
5. Redirect back to PageView

### 4 · Full-Text Search
1. User presses `⌘K` or clicks global `SearchBar` in `AppShell`
2. Types query → debounced live results (300 ms) from GET `/search`
3. `FilterBar` lets user narrow by space or label
4. Clicks result → PageView, query terms highlighted

### 5 · Comment & Resolve
1. In PageView, user selects text → inline toolbar shows **Comment** icon
2. Clicks → `CommentComposer` anchored to selection; user types + submits
3. Thread appears in `CommentPanel`; other users see amber dot on highlighted text
4. Thread author or space admin clicks **Resolve** → thread collapses to resolved list

### 6 · Restore Version
1. User opens `PageHistory` via page actions menu
2. `VersionList` shows numbered entries; clicking one renders `VersionPreview` in right pane
3. User clicks **Restore** → POST `/versions/:num/restore`; new version created preserving history

---

## Component Hierarchy

### AppShell (all screens)
- `TopNav` — logo, global `SearchBar` (⌘K), user avatar menu
- `SpaceSidebar` (collapsed on AuthScreen, SearchResults, LabelsBrowser)
  - `SpaceHeader` — icon, name, kebab menu (settings, archive)
  - `PageTree` — recursive
    - `PageTreeNode` — expand toggle, title, drag handle, context menu

### SpaceDirectory
- `SpaceGrid` — `SpaceCard` (icon, name, description, role badge, last-edited)
- `CreateSpaceModal` — slug preview auto-generated from name

### PageView
- `PageHeader` — `Breadcrumb`, title (h1 Lora), author chip, `LabelPill[]`, edit/actions buttons
- `ContentRenderer` — TipTap read-only; image lightbox on click
- `AttachmentList` — file name, size, download; `AttachmentUpload` (editor-mode only)
- `CommentPanel` (right drawer, toggled) — `CommentThread[]` → `CommentItem` (avatar, text, resolve btn)

### PageEditor
- `EditorToolbar` — bold/italic/code, block type picker, image upload
- `TipTapEditor` — slash-command palette, table controls, code-block language selector
- `EditorStatusBar` — save status, word count, `TemplatePicker` trigger

### SearchResults
- `SearchBar` — large, focused on mount
- `FilterBar` — `SpaceFilter` (multi-select), `LabelFilter`
- `ResultList` → `SearchResult` (space name chip, page title, `ts_headline` excerpt, updated date)

### PageHistory
- `VersionList` (left) → `VersionItem` (number, author avatar, date, summary, restore btn)
- `VersionPreview` (right) — read-only TipTap render of selected version content

---

## Key UX Decisions

- **Edit mode is a URL mode param, not a separate route** — avoids full page reloads; preserves scroll position and sidebar state across view↔edit transitions.
- **Auto-save + explicit Save** — auto-save prevents data loss; explicit save triggers version snapshot and change-summary prompt. Two-tier model matches user mental models from Notion/Confluence.
- **Comment panel as drawer, not inline column** — keeps content width consistent; inline highlight dots surface thread presence without disrupting layout.
- **Search via `⌘K` global shortcut** — keyboard-first; search isn't a top-nav field to preserve horizontal space for breadcrumbs.
- **PageTree drag-and-drop deferred** — PATCH `/move` endpoint exists; DnD is complex and REQ-F-002 only requires collapsible tree. Move via context-menu "Move to…" modal ships first.
- **TemplatePicker on new page only** — avoids confusion; templates are a creation-time choice, not a post-edit replacement.