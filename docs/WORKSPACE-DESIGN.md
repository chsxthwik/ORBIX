# ORBIX workspace design

## Intent

A coding workspace should make the current project, agent state, pending decisions, and evidence of work easy to inspect. Decoration must fit the workspace and yield to reading and input.

References: OpenCode's [desktop product](https://opencode.ai/desktop), its official desktop screenshots, and [agent documentation](https://opencode.ai/docs/agents). Relevant patterns: persistent session tabs, adjacent diff review, flat input surfaces, compact navigation, and explicit agent modes. ORBIX retains its own typography, palette, and integrated ASCII identity.

## Implemented

- Flat work surfaces and compact, consistent controls across Home, sessions, and panels.
- Shared keyboard and pointer hints for icon controls, with Escape, scroll, and blur dismissal. Existing accessible descriptions are preserved.
- Stable Home content without staggered visibility delays; consistent focus rings, touch targets, menus, dialogs and toast surfaces.
- Explicit clear-search controls preserve input focus. Empty drafts disable the clear action. Closed dialogs cannot steal focus through a delayed callback.
- Session library with word-based search across titles, projects and preview text; Open and Pinned filters; recency and alphabetical sorting. Search state survives Home redraws.
- Explicit Build and Plan task modes, preserving the draft while switching.
- Project, search, and model actions beside the task box. Existing projects can be drafted against before a provider is connected.
- Run inspector search combines command, path, and tool queries with the selected activity filter.
- A Run inspector backed by restored transcript results and live tool events. No fabricated progress or inferred verification.
- All, running, and failure filters; measured duration when available; usage and task counts from recorded state.
- Recorded edit paths link to file previews. Review diffs opens the existing git Changes panel.
- Tool rows reveal the originating transcript card, loading older messages when necessary.
- Inspect toolbar action, command palette entry, and Ctrl+Shift+R shortcut.
- Keyboard navigation for side-panel tabs, accessible names when compact labels are hidden.
- Header ASCII artwork sizes automatically, supports reduced motion, and stops rendering while hidden.
- Tab-scoped draft recovery, reversible clearing, and restored drafts after failed submission.

## Boundaries

The inspector reports session history, not the current filesystem. Files may have been moved or deleted since an edit. A completed shell tool is not proof that a build or test passed. Current git changes remain in the Changes panel. No provider call is made by opening or filtering the inspector.

## Validation

The run-summary tests cover restored data, duplicate reconciliation, failed commands, undone edits, durations, task totals, approvals, and ended processes. Browser checks cover real session data, activity filtering, transcript navigation, panel keyboard controls, responsive layout, and console errors.

## Rendering and maintenance

Inspector events use a bounded update queue rather than a trailing debounce, so continuous streams still refresh. Unchanged activity rows retain their DOM nodes; changed rows restore focused tool identity. Hidden documents defer inspector work until visible. The ASCII header releases its observers on remount. Pointer lighting is limited to hovered controls, coalesced per animation frame, and disabled for touch and reduced motion. Base styles and the consolidated workspace stylesheet load in a defined order. The replaced recent-list renderer and obsolete preview exports have been removed from the project.
