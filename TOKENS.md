# Conclave Design Tokens (tokens.md)

> Semantic annotation and usage boundary specification for the Conclave Agent Workbench.  
> Adheres to the [Owl-Listener Perceptual Protocols (tokens-protocol)](https://github.com/Owl-Listener/ai-design-skills) specification.

## Source

| Format | Location |
|---|---|
| CSS Custom Properties (`light-dark()`) | [`packages/web/src/styles.css`](packages/web/src/styles.css) |
| TypeScript Token Definitions | [`packages/web/src/tokens/index.ts`](packages/web/src/tokens/index.ts) |
| Visual Principles & Rationale | [`DESIGN.md`](DESIGN.md) |

Theming and dark mode resolve automatically through CSS `light-dark()` driven by `color-scheme` (following the system preference, or pinned in user settings via `[data-theme='light'|'dark']`). Two curated minimal palettes (`studio`, `ember`) apply via `[data-palette]` attributes.

---

## Palettes

| Palette | Key | Rationale / Character | Canvas / Container (Light) | Canvas / Container (Dark) | Accent (Light / Dark) |
|---|---|---|---|---|---|
| **Studio** | `studio` | Default. Pure neutral cold grays; deep OLED true black in dark mode. Single cyan/sky hue. | `#f8f9fa` / `#ffffff` | `#000000` / `#0c0d0e` | `#0284c7` / `#38bdf8` |
| **Ember** | `ember` | Warm stone and titanium ivory by day, volcanic charcoal by night. Glowing amber accent. | `#f6f4f0` / `#fcfbf9` | `#0c0a09` / `#1c1917` | `#d97706` / `#fbbf24` |

---

## Color

### Canvas & Surface

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `surface.canvas` | `--bg` | `#f8f9fa` | `#000000` | Application window root, background canvas behind panes | Content cards, buttons, or input boxes |
| `surface.card` | `--surface` | `#ffffff` | `#0c0d0e` | Main message stream, card panels, inspectors, modal containers | Canvas background; outer window border |
| `surface.fill.subtle` | `--fill` | `rgb(0 0 0 / 3%)` | `rgb(255 255 255 / 6%)` | Quiet containers, tag backgrounds, quiet hover wash | Solid primary action buttons; active state tabs |
| `surface.fill.active` | `--fill-2` | `rgb(0 0 0 / 6%)` | `rgb(255 255 255 / 10%)` | Pressed button states, selected row highlights, pill chips | Large area container backgrounds |
| `surface.muted` | `--surface-muted` | `rgb(0 0 0 / 4%)` | `rgb(255 255 255 / 6%)` | Backward-compatible alias for subtle surface wash | New component backgrounds (prefer `--fill`) |

### Structural Borders

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `border.subtle` | `--border` | `#ebecee` | `#18191b` | Hairline section dividers, card outer frames, table cell borders | Form input outlines; active selection borders |
| `border.strong` | `--border-2` | `#e2e4e7` | `#232528` | Input controls, blockquote vertical rules, dashed splitters | Subtle nested card lines; full view partitions |

### Typography & Contrast

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `text.primary` | `--text` | `#09090b` | `#fafafa` | Primary headings, body copy, active button labels, icons | Low-priority metadata or timestamp labels |
| `text.muted` | `--text-muted` | `#64748b` | `#a1a1aa` | Secondary labels, agent descriptions, tab inactive titles | Main message text; critical error explanations |
| `text.tertiary` | `--text-3` | `#94a3b8` | `#71717a` | Timestamps, token usage counts, keyboard shortcuts (`kbd`) | Interactive button labels; readable content text |

### Action & Interactive Focus (Single Action Hue)

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `action.accent` | `--accent` | `#0284c7` | `#38bdf8` | The single primary action button per view, active checkmarks, links | Card background decoration; general status badges |
| `action.text` | `--accent-text` | `#ffffff` | `#09090b` | Foreground text displayed directly on `--accent` solid fills | Text on standard neutral surfaces |
| `action.bg.subtle` | `--accent-bg` | `rgb(2 132 199 / 9%)` | `rgb(56 189 248 / 14%)` | Active tab background tint, current agent icon container wash | Solid action buttons; border outlines |
| `action.focus` | `--focus` | `#0284c755` | `#38bdf855` | 2px keyboard focus outline (`:focus-visible`) | Mouse-click focus ring; decorative card borders |

### Agent & System State (Mixed-Initiative & Observability)

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `state.running` | `--status-running` | `#0284c7` | `#38bdf8` | Active agent execution, tool execution spinner, streaming text | Static queued states; completed tasks |
| `state.done` | `--status-done` | `#16a34a` | `#34d399` | Successfully completed rounds, verified tasks, added git diff lines | Idle or waiting states; decorative highlights |
| `state.review` | `--status-review` / `--warning` | `#d97706` | `#fbbf24` | Human-in-the-loop: Agent waiting for user reply, quota caution | Terminal errors; standard progress indicators |
| `state.pending` | `--status-pending` | `#64748b` | `#71717a` | Tasks queued in backlog, inactive sub-agent in delegation graph | Blocked or failed execution states |
| `state.abandoned`| `--status-abandoned` | `#cbd5e1` | `#3f3f46` | Cancelled runs, archived tasks, dismissed delegations | Normal completion; active warning states |
| `state.danger` | `--danger` | `#dc2626` | `#f87171` | Unrecoverable errors, tool failures, deleted git diff lines | Non-fatal warnings; user confirmation prompts |
| `state.info` | `--info` | `#0284c7` | `#38bdf8` | Step progress rings, modified files, informational notes | Interactive primary buttons; error banners |

### Observability Syntax & Multi-Agent Topology

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `code.keyword` | `--code-keyword` | `#9333ea` | `#c084fc` | Language keywords in diffs and code blocks | General UI text headings |
| `code.string` | `--code-string` | `#16a34a` | `#4ade80` | String literals in code syntax | Status completion labels |
| `code.number` | `--code-number` | `#d97706` | `#fbbf24` | Numbers, constants, unit values | System warning badges |
| `code.comment` | `--code-comment` | `#94a3b8` | `#71717a` | Code comments, secondary syntax | Primary diff text |
| `code.title` | `--code-title` | `#0284c7` | `#38bdf8` | Function and class names in code | Interactive web links |
| `code.type` | `--code-type` | `#d97706` | `#f59e0b` | Type annotations, interfaces, structs | Alert indicators |
| `code.variable`| `--code-variable` | `#e11d48` | `#fb7185` | Variable identifiers, parameter names | Destructive action triggers |
| `graph.1`–`6` | `--graph-1`..`6` | *syntax cycle* | *syntax cycle* | Multi-agent causality topology lines, git branches, usage charts | UI button colors; general surface cards |

---

## Typography

| Token | CSS Variable | Value / Stack | Line Height | Use for | Do not use for |
|---|---|---|---|---|---|
| `type.ui` | `--font` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif` | 1.5 | All application UI: toolbars, sidebars, buttons, labels | Code blocks, terminal logs, git commit hashes |
| `type.mono` | `--mono` | `'Geist Mono Variable', Menlo, Consolas, 'PingFang SC', monospace` | 1.0–1.2 | Code editors, unified diffs, terminal outputs, file paths | General body paragraphs; menu headers |
| `type.chat.body` | `--chat-font-size` | `14px` (settings: 10–20px) | 1.7 | Main conversation responses and user messages | Dense tabular reports; compact sidebar lists |
| `type.chat.small`| `--chat-font-small`| `calc(var(--chat-font-size) - 2px)` (12px) | 1.5 | Tool invocation params, timestamp headers, sub-agent chips | Long-form reading paragraphs |

---

## Spacing

| Token | CSS Variable | Value | Use for |
|---|---|---|---|
| `space.1` | `--space-1` | `4px` | Fine-grain gaps: badge text padding, icon-to-label spacing |
| `space.2` | `--space-2` | `8px` | Group internal spacing: button padding, tool header row gap |
| `space.3` | `--space-3` | `12px` | Horizontal padding for collapsible tool rows, card headers |
| `space.4` | `--space-4` | `16px` | Component-to-component separation, modal dialog body padding |
| `space.5` | `--space-5` | `20px` | Form field spacing, panel interior gutter |
| `space.6` | `--space-6` | `24px` | Section-level breaks in settings, empty state padding |
| `space.8` | `--space-8` | `32px` | Page-level top/bottom clearance, dashboard card gap |

**Rules**
- **Strict 4px Rhythm**: Always snap to 4 / 8 / 12 / 16 / 20 / 24 / 32px. Arbitrary values (e.g. 5px, 7px, 11px) are considered visual defects.
- **Collapsible Rhythm**: Every collapsible step in the chat flow (tool call, sub-agent delegation, unified diff head) shares a unified rhythm: **28–32px height, 12px horizontal padding**.

---

## Elevation

| Token | CSS Variable | Light | Dark | Use for | Do not use for |
|---|---|---|---|---|---|
| `elevation.card` | `--shadow` | `0 1px 2px rgb(0 0 0 / 6%)` | `transparent` | Subtle grounding for resting cards and buttons in light mode | Dark mode elements; flat tool call rows |
| `elevation.float`| `--shadow-float` | `0 6px 20px rgb(0 0 0 / 16%)` | `transparent` | Floating modals, dropdown context menus, waiting request HUD | Standard static cards; embedded lists |

**Rules**
- **Surfaces over Heavy Shadows**: Hierarchy is built through surfaces (`--bg` → `--surface` → `--fill`) and hairline borders (`--border`).
- **Zero Dark Shadows**: Dark mode renders zero box-shadows (`transparent`). Depth is created exclusively by surface lightness steps (`#000000` canvas vs `#0c0d0e` containers in Studio; `#0c0a09` vs `#1c1917` in Ember).

---

## Motion

| Token | CSS Variable | Value | Use for | Do not use for |
|---|---|---|---|---|---|
| `motion.fast` | `--duration-fast` | `120ms` | Hover states, border color transitions, tab highlight slides | Page routing transitions; complex multi-step layout morphs |
| `motion.normal`| `--duration-normal`| `200ms` | Accordion expand/collapse, modal fade-in, flyout overlays | Micro-state hover reactions |
| `motion.ease` | `--ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | Natural deceleration curve across all UI transitions | Linear robotic animations |

**Rules**
- **Motion Signals Activity Only**: Continuous looping animation (spinners, flowing line dashes) is reserved strictly for `--status-running`. Inactive, waiting, or completed states must remain completely static.
- **Accessibility**: `@media (prefers-reduced-motion: reduce)` immediately terminates all continuous loops. Information must remain fully readable through icon glyphs and text labels alone.

---

## Radius

| Token | CSS Variable | Value | Use for |
|---|---|---|---|
| `radius.xs` | `--radius-xs` | `4px` | Small badges, row hover washes, inline code chips |
| `radius.sm` | `--radius-sm` | `6px` | Input controls, segmented buttons, filter pills |
| `radius.md` | `--radius` | `8px` | Standard buttons, code blocks, option rows, cards |
| `radius.lg` | `--radius-lg` | `12px` | Main message bubbles, modal dialogs, inspector panels |
| `radius.full`| `--radius-full` | `999px` | Round avatars, status indicator dots, capsule counters |

---

## Layout & Measure

| Token | CSS Variable | Value | Use for | Do not use for |
|---|---|---|---|---|---|
| `layout.reading`| `--page-reading` | `800px` | Message stream, chat composer, task description view | Broad multi-column tables, kanban boards |
| `layout.form` | `--page-form` | `896px` | Settings pages, team configuration, editing forms | Single-column narrative reading |
| `layout.wide` | `--page-wide` | `1152px` | Overview dashboard, analytics, scheduling, inbox lists | Text-heavy conversational flows |

**Rules**
- **Purpose-driven Width**: Reading columns stay constrained to avoid excessive line lengths. Only the Kanban board and true multi-column data grids stretch to fill the pane.
