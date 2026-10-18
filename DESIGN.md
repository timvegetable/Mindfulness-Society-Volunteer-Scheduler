---
name: UMD Mindfulness Society volunteer scheduling
description: A calm operational workspace for coordinating volunteer sessions.
colors:
  accent: "#2f604b"
  accent-hover: "#244c3a"
  ink: "#242e28"
  muted: "#657069"
  amber: "#f4b64f"
  leaf: "#81d254"
  canvas: "#f7f6f2"
  header: "#fff"
  surface: "#fff"
  surface-subtle: "#eeece5"
  border: "#dedbd2"
  focus: "#936118"
  quiet: "#fff"
  quiet-hover: "#f0eee8"
  tab-hover: "#eeece5"
  field-border: "#c9c8be"
  table-heading: "#47534b"
  table-divider: "#dedbd2"
  shortfall-bg: "#fbe7bd"
  shortfall-ink: "#775014"
  notice-bg: "#fff4df"
  notice-ink: "#76500d"
  error-bg: "#fff0e9"
  error-ink: "#8b3428"
  error-border: "#e8c9ba"
  success-bg: "#e5f0e2"
  success-ink: "#244c32"
  success-border: "#c5d8bf"
  danger-ink: "#a24132"
  danger-bg: "#fff5f0"
  selection-bg: "#f8d99e"
  selection-ink: "#1b1b1b"
  publication-bg: "#e3eee7"
  session-ink: "#50594f"
  cancelled-bg: "#f5e0da"
  cancelled-ink: "#943e2c"
  badge-border: "#e5ddc4"
  badge-bg: "#fbf8ef"
  heatmap-ink: "#23482f"
  heatmap-border: "#d6dfd7"
  scrollbar: "#a6a69d"
  row-hover: "#faf9f6"
typography:
  display:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "clamp(1.8rem, 3vw, 2.6rem)"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.03em"
  title:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "1.5rem"
    fontWeight: 600
  brand:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "1.25rem"
    fontWeight: 700
  body:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "15px"
    lineHeight: 1.55
  label:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.84rem"
    fontWeight: 500
  table:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.94rem"
  section:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "1rem"
  metadata:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.88rem"
  identity:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.85rem"
  table-heading:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.75rem"
  compact:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.8rem"
  schedule-table:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.94rem"
  schedule-table-heading:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.75rem"
  pill:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "0.86rem"
  schedule-title:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "1.8rem"
  schedule-title-mobile:
    fontFamily: '"DM Sans", system-ui, sans-serif'
    fontSize: "1.3rem"
rounded:
  badge: "9px"
  field: "10px"
  control: "10px"
  panel: "18px"
  flat: "0"
  heatmap: "10px"
  status: "7px"
  table-frame: "12px"
  pill: "999px"
  logo-badge: "50%"
spacing:
  actions: "0.5rem"
  fields: "0.85rem"
  standard: "1rem"
  content: "1.3rem"
  panel: "1.8rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    backgroundColor: "{colors.quiet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
  button-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger-ink}"
    rounded: "{rounded.control}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "0.6rem 0.7rem"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "1.8rem"
  tab-selected:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "0"
    padding: "0.7rem 0.9rem"
  shortfall:
    backgroundColor: "{colors.shortfall-bg}"
    textColor: "{colors.shortfall-ink}"
    rounded: "{rounded.badge}"
    padding: "0.15rem 0.55rem"
  publication-pill:
    backgroundColor: "{colors.publication-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "0.12rem 0.65rem"
  session-status:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.session-ink}"
    rounded: "{rounded.pill}"
    padding: "0.12rem 0.65rem"
  session-status-success:
    backgroundColor: "{colors.publication-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "0.12rem 0.65rem"
  session-status-cancelled:
    backgroundColor: "{colors.cancelled-bg}"
    textColor: "{colors.cancelled-ink}"
    rounded: "{rounded.pill}"
    padding: "0.12rem 0.65rem"
---

# Design System: UMD Mindfulness Society

## Overview

**Creative North Star: "Compact operational scheduling workspace"**

Follow the user's supplied schedule-page reference: warm neutral canvas, white shell and panels, restrained forest actions, and clear tabular hierarchy. The official amber-and-leaf society icon sits in a cream circular badge. DM Sans serves all visible typography.

Authenticated pages lead directly from the compact identity header into role navigation and task panels. Keep copy directly useful: no taglines, filler, header subtitle, or redundant visible workspace title. The authenticated H1 remains available to assistive technology.

**Key Characteristics:**
- Warm neutral surfaces with restrained forest accents.
- Official icon in a cream circular badge.
- Explicit publication, session, and shortage states.
- Full-height schedule with native horizontal scrolling.

## Colors

Frontmatter records implemented colors. Warm off-white is the canvas; white is the header, panels, fields, and quiet buttons. Warm gray defines table headings, borders, and neutral session pills. Green emphasizes primary actions, active navigation, and publication state; it is not the general panel or table-header tint.

The official icon retains amber and leaf. Gold supports shortage badges, notices, selection, and keyboard focus. Cancelled sessions use pale terracotta with dark red text. Success and error feedback keep their implemented text, border, and surface combinations.

**The Identity Rule.** Preserve the supplied official SVG byte-for-byte and use it for the shell and favicon. Contain it within its badge without cropping or stretching.

## Typography

DM Sans with system-ui and sans-serif fallbacks handles all roles. Root text is 15px with a 1.55 line height; frontmatter lists the implemented sizes rather than imposing a new scale. Loaded weights are 400, 500, 600, and 700.

Panel headings are 1.5rem desktop and 1.3rem mobile; the schedule title is 1.8rem desktop and 1.3rem mobile. The brand name is 1.25rem desktop and 1rem mobile. All table data uses 0.94rem. Table headings are uppercase with 0.035em tracking, at 0.75rem throughout. Session-time metadata is 0.88rem and wraps. Numeric metadata uses tabular figures where implemented.

The visible sign-in H1 uses the display role. Authenticated workspaces retain a visually hidden H1. Task explanations stop at 72ch.

## Layout

Main content is centered at a maximum width of 1800px, with `1.8rem max(3vw, 1rem) 4rem` padding. The compact white header uses `0.8rem max(1.5vw, 1rem)` padding. The desktop cream badge is 48×48px with a 40×25px contained icon; mobile uses a 52×52px badge and 44×28px icon.

Navigation wraps above a one-column task grid. At 1100px, volunteer panels use two columns with first and last panels spanning both. At 650px and below, panels use 1rem padding, account identity stacks and ellipsizes visually while retaining its complete DOM text, and schedule actions occupy their own row. Proposal and exception forms use paired fields and spanning action rows.

The schedule table grows vertically to show every row: its scroll region has `max-height: none`. It retains native horizontal scrolling at narrow widths and a 48rem minimum table width. Its first column uses 35%, final column 10%, and the five-column layout gives status 14%. All table regions share a warm bordered 12px frame and uppercase warm gray headers. Non-schedule tables retain bounded native scrolling capped at `min(28rem, 55vh)` and sticky headers. The participant-resolution table retains a 76rem minimum width. The five-column heatmap scrolls horizontally.

**The Table Rule.** Keep the schedule uncapped vertically; preserve horizontal overflow within its panel. Keep native scrolling and sticky headings for other table regions.

## Elevation & Depth

Panels are flat with no shadows. White surfaces, warm gray borders, and whitespace establish grouping. Focus outlines convey keyboard position; sticky headings stay above scrolling rows.

## Shapes

Panels use 18px corners; buttons use 10px; fields use 10px. The schedule's table frame uses 12px, shortfall badges 9px, and heatmap cells 10px. Notices and feedback retain 7px corners; selected heatmap details use a neutral canvas surface and 12px corners. Publication and session states use full pills; the cream logo badge is circular. Tabs remain square and flat.

## Components

### Buttons and fields

Primary buttons use forest and white, darkening on hover. Quiet buttons are white with a warm gray border and dark ink; hover warms the surface. Destructive quiet actions use terracotta. Buttons have semibold text, 0.7rem 1.1rem padding, a 0.15s background transition, and 0.45 opacity when disabled. White fields use a neutral warm gray border, 10px corners, stacked labels, and a 42px minimum height.

### Navigation

Tabs use transparent backgrounds, muted text, and a forest underline for the active page. Hover uses warm gray. Tabs wrap and Reload view remains in the navigation group. Tab background and border transitions are 180ms ease-out only when reduced motion is not requested.

### Panels and schedule

White bordered panels share 1.8rem desktop padding and 1rem mobile padding across all role workspaces. Shared panel toolbars place Sync now or sort fields alongside the task title and description; controls wrap below on narrow screens. The schedule toolbar pairs its heading with its actions. Its warm gray uppercase table headings, generous 1.2rem 1.25rem cells, and light hover surface support scanning all rows.

### State pills and shortages

Publication is a green pill followed by version text. The shared status pill uses terracotta for cancelled or failed, green for confirmed, completed, or available, and a neutral surface for other states such as locked. It appears in session, proposal, exception, and import-history records. Positive unfilled counts use a gold rounded rectangle; zero stays muted. Text and counts carry meaning alongside color.

### Feedback and availability

Success, error, and notice surfaces include written feedback. The availability heatmap uses muted forest `hsl(145 22% L)` with lightness descending from 97% to 77% by relative count. Cells show time and count, have a 44px minimum height, and retain a forest inset outline when `aria-pressed="true"`; activating one reveals volunteer details. These functional states retain their source colors without recoloring the neutral shell.

**The Focus Rule.** Controls and table scroll regions use a visible 3px gold focus outline with a 3px offset.

## Do's and Don'ts

### Do:
- **Do** follow the supplied reference's neutral shell, cream logo badge, green actions, and explicit status hierarchy.
- **Do** keep all schedule rows visible vertically and contain horizontal overflow.
- **Do** retain concise task copy, wrapped navigation, responsive forms, and visible keyboard focus.

### Don't:
- **Don't** redraw, recolor, crop, or stretch the official icon.
- **Don't** tint general table headings or quiet controls green.
- **Don't** add redundant visible workspace titles, header subtitles, taglines, or filler.
- **Don't** communicate staffing or session state through color alone.

Proposal row actions stay on a single line in a content-sized Actions column. Keep Edit, Withdraw, and (for administrators) Confirm visible in their existing order; narrow screens use the table’s horizontal scroll.
