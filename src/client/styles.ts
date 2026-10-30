/**
 * 市场 design system.
 *
 * Follows the approved redesign: 8pt spacing, tokenised colour, pill tabs and
 * chips, one primary action per card, and a maximum four-column grid. Colours
 * are declared locally rather than borrowed from the Host — its alias tokens are
 * not defined inside a plugin slot, which previously made sheets transparent and
 * filled buttons unreadable.
 */

export const styles = `
.qym,
.qym-scrim,
.qym-skillBar,
.qym-skillTrigger,
.qym-skillMenu {
  --qym-primary-50: #eef4ff;
  --qym-primary-100: #dbe7ff;
  --qym-primary-500: #3b6ef6;
  --qym-primary-600: #2b5be0;
  --qym-primary-700: #1e46b8;

  --qym-bg: #f7f8fa;
  --qym-surface: #ffffff;
  --qym-border: #e6e8ec;
  --qym-border-strong: #d4d8df;

  --qym-text-1: #1a1d24;
  --qym-text-2: #4b5261;
  --qym-text-3: #8a90a0;

  --qym-success: #16a34a;
  --qym-success-bg: #ecfdf3;
  --qym-danger: #dc2626;
  --qym-danger-bg: #fef2f2;

  --qym-radius-sm: 8px;
  --qym-radius-md: 12px;
  --qym-radius-lg: 16px;
  --qym-radius-full: 999px;

  --qym-shadow-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --qym-shadow-md: 0 4px 12px -2px rgb(16 24 40 / 0.1), 0 2px 4px -2px rgb(16 24 40 / 0.06);
  --qym-shadow-lg: 0 12px 24px -6px rgb(16 24 40 / 0.14);

  --qym-t-fast: 150ms ease;
}
@media (prefers-color-scheme: dark) {
  .qym,
  .qym-scrim,
  .qym-skillBar,
  .qym-skillTrigger,
  .qym-skillMenu {
    --qym-primary-50: #16213c;
    --qym-primary-100: #1d2c50;
    --qym-primary-500: #6b95ff;
    --qym-primary-600: #5a86f5;
    --qym-primary-700: #8fb0ff;

    --qym-bg: #16171a;
    --qym-surface: #1e1f23;
    --qym-border: #2a2c32;
    --qym-border-strong: #3a3d45;

    --qym-text-1: #f2f3f5;
    --qym-text-2: #b9bdc7;
    --qym-text-3: #8a90a0;

    --qym-success: #4ade80;
    --qym-success-bg: #14281c;
    --qym-danger: #f87171;
    --qym-danger-bg: #2a1618;

    --qym-shadow-md: 0 4px 12px -2px rgb(0 0 0 / 0.5);
    --qym-shadow-lg: 0 12px 24px -6px rgb(0 0 0 / 0.6);
  }
}

/* Block flow on purpose: as a flex column, the grid wrap was shrinkable and a
 * height-constrained Host panel squashed every card. Only the page scrolls. */
.qym,
.qym *,
.qym *::before,
.qym *::after {
  box-sizing: border-box;
}
.qym {
  height: 100%;
  min-height: 0;
  display: block;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--qym-bg);
  color: var(--qym-text-1);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.qym button { font-family: inherit; cursor: pointer; }
.qym :focus-visible { outline: 2px solid var(--qym-primary-500); outline-offset: 2px; border-radius: 4px; }

/* header */
.qym-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: color-mix(in srgb, var(--qym-surface) 85%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--qym-border);
}
.qym-headerInner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 32px;
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 76px;
}
.qym-brand { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
/* The mark carries its own rounded mask, so the container stays transparent and
 * only clips the very edge — a gradient behind it would show through the corners. */
.qym-brandLogo {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  overflow: hidden;
  background: transparent;
}
.qym-brandLogo img { display: block; width: 100%; height: 100%; object-fit: contain; }
.qym-brandName { font-size: 16px; font-weight: 700; letter-spacing: 0.2px; white-space: nowrap; }
/* One solid wordmark: same ink for both halves, weight carries the difference. */
.qym-brandName span { color: var(--qym-text-1); font-weight: 600; }

.qym-search { flex: 1; min-width: 200px; max-width: none; position: relative; display: flex; align-items: center; }
.qym-searchIcon {
  position: absolute;
  left: 14px;
  width: 16px;
  height: 16px;
  color: var(--qym-text-3);
  pointer-events: none;
}
.qym-searchInput {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding: 0 76px 0 40px;
  border: 1px solid var(--qym-border-strong);
  border-radius: var(--qym-radius-full);
  background: var(--qym-bg);
  font-size: 14px;
  color: var(--qym-text-1);
  transition: all var(--qym-t-fast);
  outline: none;
}
.qym-searchInput::placeholder { color: var(--qym-text-3); }
.qym-searchInput:hover { border-color: #b9bfc9; }
.qym-searchInput:focus {
  background: var(--qym-surface);
  border-color: var(--qym-primary-500);
  box-shadow: 0 0 0 3px var(--qym-primary-100);
}
.qym-searchKbd {
  position: absolute;
  right: 38px;
  font-size: 12px;
  color: var(--qym-text-3);
  border: 1px solid var(--qym-border);
  border-radius: 5px;
  padding: 1px 6px;
  background: var(--qym-surface);
  pointer-events: none;
}
.qym-searchClear {
  position: absolute;
  right: 12px;
  border: none;
  background: var(--qym-border);
  color: var(--qym-text-2);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
  display: grid;
  place-items: center;
}

.qym-headerActions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
.qym-btnGhost {
  height: 36px;
  padding: 0 16px;
  border-radius: var(--qym-radius-full);
  border: 1px solid transparent;
  background: transparent;
  color: var(--qym-text-2);
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all var(--qym-t-fast);
}
.qym-btnGhost:hover { background: var(--qym-border); color: var(--qym-text-1); }
.qym-btnGhost[data-active='true'] { background: var(--qym-primary-50); color: var(--qym-primary-700); }
.qym-badgeCount {
  background: var(--qym-border);
  border-radius: var(--qym-radius-full);
  font-size: 12px;
  padding: 0 7px;
  line-height: 18px;
  color: var(--qym-text-2);
}

/* toolbar */
.qym-toolbar {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 32px 12px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.qym-tabs { display: flex; background: var(--qym-border); border-radius: var(--qym-radius-full); padding: 3px; }
.qym-tab {
  height: 32px;
  padding: 0 16px;
  border: none;
  background: transparent;
  border-radius: var(--qym-radius-full);
  font-size: 14px;
  color: var(--qym-text-2);
  transition: all var(--qym-t-fast);
  white-space: nowrap;
}
.qym-tab:hover { color: var(--qym-text-1); }
.qym-tab[data-active='true'] {
  background: var(--qym-surface);
  color: var(--qym-text-1);
  font-weight: 600;
  box-shadow: var(--qym-shadow-sm);
}
.qym-tabCount { margin-left: 6px; font-size: 12px; color: var(--qym-text-3); font-variant-numeric: tabular-nums; }
.qym-toolbarRight { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.qym-select {
  box-sizing: border-box;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--qym-border-strong);
  border-radius: var(--qym-radius-sm);
  background: var(--qym-surface);
  font-family: inherit;
  font-size: 13px;
  color: var(--qym-text-2);
  outline: none;
}

/* chips */
.qym-chips {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 32px 8px;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.qym-chips::-webkit-scrollbar { display: none; }
.qym-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--qym-border-strong);
  border-radius: var(--qym-radius-full);
  background: var(--qym-surface);
  font-size: 13px;
  color: var(--qym-text-2);
  transition: all var(--qym-t-fast);
}
.qym-chip:hover { border-color: var(--qym-primary-500); color: var(--qym-primary-600); }
.qym-chip[data-active='true'] {
  background: var(--qym-primary-50);
  border-color: var(--qym-primary-500);
  color: var(--qym-primary-700);
  font-weight: 600;
}
.qym-chipCount {
  font-size: 12px;
  color: var(--qym-text-3);
  background: var(--qym-bg);
  border-radius: var(--qym-radius-full);
  padding: 0 6px;
  line-height: 17px;
}
.qym-chip[data-active='true'] .qym-chipCount { background: var(--qym-primary-100); color: var(--qym-primary-700); }

/* grid */
.qym-gridWrap {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 32px 40px;
}
.qym-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

/* card */
.qym-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--qym-surface);
  border: 1px solid var(--qym-border);
  border-radius: var(--qym-radius-lg);
  padding: 20px;
  transition: all var(--qym-t-fast);
  cursor: pointer;
  height: 100%;
  box-sizing: border-box;
}
.qym-card:hover {
  border-color: var(--qym-border-strong);
  box-shadow: var(--qym-shadow-md);
  transform: translateY(-2px);
}
.qym-cardHead { display: flex; align-items: flex-start; gap: 12px; }
.qym-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--qym-radius-md);
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 16px;
  color: #fff;
  overflow: hidden;
  background: var(--qym-primary-500);
  border: 1px solid var(--qym-border);
}
.qym-avatar img { width: 100%; height: 100%; object-fit: contain; background: var(--qym-surface); }
.qym-cardTitleWrap { min-width: 0; flex: 1; }
.qym-cardTitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--qym-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qym-cardSub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--qym-text-3);
  min-width: 0;
}
.qym-cardSub span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qym-dot { flex: none; width: 3px; height: 3px; border-radius: 50%; background: currentColor; }
.qym-tagType {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--qym-radius-full);
  background: var(--qym-primary-50);
  color: var(--qym-primary-600);
  font-weight: 500;
  flex-shrink: 0;
}
.qym-tagType[data-tone='off'] { background: var(--qym-border); color: var(--qym-text-3); }
.qym-tagType[data-tone='on'] { background: var(--qym-success-bg); color: var(--qym-success); }

.qym-cardDesc {
  margin: 0;
  font-size: 13px;
  color: var(--qym-text-2);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 42px;
}
.qym-cardFoot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--qym-border);
}
.qym-cardMeta {
  font-size: 12px;
  color: var(--qym-text-3);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}
.qym-cardMeta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.qym-btnInstall {
  height: 32px;
  padding: 0 16px;
  border-radius: var(--qym-radius-full);
  border: 1px solid var(--qym-primary-500);
  background: var(--qym-primary-500);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  flex-shrink: 0;
  transition: all var(--qym-t-fast);
}
.qym-btnInstall:hover:not(:disabled) { background: var(--qym-primary-600); border-color: var(--qym-primary-600); }
.qym-btnInstall:active:not(:disabled) { transform: scale(0.96); }
.qym-btnInstall:disabled { opacity: 0.6; cursor: default; }
.qym-btnInstall[data-state='loading'] {
  background: var(--qym-primary-50);
  border-color: var(--qym-primary-100);
  color: var(--qym-primary-600);
}
.qym-btnInstall[data-state='done'] {
  background: var(--qym-success-bg);
  border-color: transparent;
  color: var(--qym-success);
}
.qym-spinner {
  width: 12px;
  height: 12px;
  display: inline-block;
  vertical-align: -2px;
  margin-right: 5px;
  border: 2px solid var(--qym-primary-100);
  border-top-color: var(--qym-primary-600);
  border-radius: 50%;
  animation: qym-spin 0.7s linear infinite;
}
@keyframes qym-spin { to { transform: rotate(360deg); } }

/* states */
.qym-empty { margin: 40px 0; text-align: center; color: var(--qym-text-3); font-size: 14px; }
.qym-emptyIcon { font-size: 40px; margin-bottom: 12px; }
.qym-error {
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: var(--qym-radius-sm);
  background: var(--qym-danger-bg);
  color: var(--qym-danger);
  font-size: 13px;
}
.qym-note {
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: var(--qym-radius-sm);
  background: var(--qym-primary-50);
  color: var(--qym-primary-700);
  font-size: 13px;
  line-height: 1.5;
}
.qym-note[data-tone='error'] { background: var(--qym-danger-bg); color: var(--qym-danger); }
.qym-note[data-snapshot-hint] {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
  background: var(--qym-primary-50);
  color: var(--qym-primary-700);
}
.qym-note[data-tone='ok'] { background: var(--qym-success-bg); color: var(--qym-success); }
.qym-hint { margin: 0; font-size: 12px; color: var(--qym-text-3); line-height: 1.5; }
.qym-more { display: flex; justify-content: center; padding-top: 20px; }

/* sheet */
.qym-scrim {
  position: fixed;
  inset: 0;
  /* Above the sticky header (z-index 50), otherwise the bar stays bright and
   * looks like the dialog is only covering part of the page. */
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(16 24 40 / 0.32);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.qym-sheet {
  box-sizing: border-box;
  width: min(560px, 100%);
  max-height: min(84vh, 780px);
  overflow-y: auto;
  padding: 24px 26px 22px;
  border-radius: var(--qym-radius-lg);
  background: var(--qym-surface);
  border: 1px solid var(--qym-border);
  box-shadow: var(--qym-shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--qym-text-1);
}
.qym-sheetHead { display: flex; gap: 14px; align-items: flex-start; }
.qym-sheetTitle { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; }
.qym-sheetSub { margin: 2px 0 0; font-size: 12px; line-height: 17px; color: var(--qym-text-3); }
.qym-sheetBody { margin: 0; font-size: 13px; line-height: 1.65; color: var(--qym-text-2); white-space: pre-wrap; }
.qym-close {
  appearance: none;
  flex: none;
  width: 26px;
  height: 26px;
  margin: -4px -6px 0 0;
  border-radius: 50%;
  border: 0;
  background: var(--qym-border);
  color: var(--qym-text-2);
  font-size: 14px;
  line-height: 1;
}
.qym-close:hover { color: var(--qym-text-1); }
.qym-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.qym-divider { height: 1px; background: var(--qym-border); margin: 2px 0; }
.qym-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 10px 16px; }
.qym-factKey { font-size: 11px; line-height: 15px; color: var(--qym-text-3); }
.qym-factValue { font-size: 12.5px; line-height: 18px; color: var(--qym-text-1); overflow-wrap: anywhere; }
.qym-sectionTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--qym-text-2);
}
.qym-prompt {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--qym-border);
  border-radius: var(--qym-radius-sm);
  background: var(--qym-bg);
  color: var(--qym-text-1);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
}
.qym-prompt:hover { border-color: var(--qym-primary-500); color: var(--qym-primary-700); }
.qym-promptText { flex: 1; min-width: 0; }
.qym-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

/* buttons */
.qym-btn {
  appearance: none;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  padding: 6px 14px;
  border-radius: var(--qym-radius-full);
  border: 1px solid var(--qym-border-strong);
  background: var(--qym-surface);
  color: var(--qym-text-1);
  white-space: nowrap;
  transition: all var(--qym-t-fast);
}
.qym-btn:hover:not(:disabled) { border-color: var(--qym-primary-500); color: var(--qym-primary-600); }
.qym-btn:disabled { opacity: 0.45; cursor: default; }
.qym-btn--primary { background: var(--qym-primary-500); border-color: var(--qym-primary-500); color: #fff; font-weight: 500; }
.qym-btn--primary:hover:not(:disabled) { background: var(--qym-primary-600); border-color: var(--qym-primary-600); color: #fff; }
.qym-btn--danger { color: var(--qym-danger); border-color: color-mix(in srgb, var(--qym-danger) 40%, transparent); }
.qym-btn--danger:hover:not(:disabled) { background: var(--qym-danger-bg); color: var(--qym-danger); border-color: var(--qym-danger); }
.qym-btn--lg { font-size: 14px; line-height: 20px; padding: 8px 20px; }

/* badges */
.qym-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 17px;
  padding: 1px 8px;
  border-radius: var(--qym-radius-full);
  border: 1px solid var(--qym-border);
  color: var(--qym-text-2);
  white-space: nowrap;
}
.qym-badge[data-tone='on'] { background: var(--qym-success-bg); color: var(--qym-success); border-color: transparent; }
.qym-badge[data-tone='off'] { background: var(--qym-border); color: var(--qym-text-3); border-color: transparent; }

/* form */
.qym-field { display: flex; flex-direction: column; gap: 6px; }
.qym-label { font-size: 12px; color: var(--qym-text-2); }
.qym-input,
.qym-textarea {
  box-sizing: border-box;
  width: 100%;
  font: inherit;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: var(--qym-radius-sm);
  border: 1px solid var(--qym-border-strong);
  background: var(--qym-surface);
  color: var(--qym-text-1);
  outline: none;
}
.qym-textarea { min-height: 132px; resize: vertical; font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; }
.qym-input:focus,
.qym-textarea:focus { border-color: var(--qym-primary-500); box-shadow: 0 0 0 3px var(--qym-primary-100); }
.qym-pickRow { display: flex; align-items: center; gap: 8px; }
.qym-pickRow .qym-input { flex: 1; min-width: 0; }

/* installed board */
.qym-owned { display: flex; flex-direction: column; gap: 24px; }
.qym-group { display: flex; flex-direction: column; gap: 12px; }
.qym-groupHead { display: flex; align-items: baseline; gap: 8px; }
.qym-groupTitle { margin: 0; font-size: 14px; font-weight: 600; color: var(--qym-text-1); }
.qym-count { font-size: 12px; color: var(--qym-text-3); font-variant-numeric: tabular-nums; }
.qym-card--owned { cursor: default; }
.qym-card--owned:hover { transform: none; }
.qym-cardActions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.qym-hintline { font-size: 12px; color: var(--qym-text-3); }

.qym-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.qym-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--qym-radius-sm);
  border: 1px solid transparent;
}
.qym-row:hover { background: var(--qym-surface); border-color: var(--qym-border); }
.qym-rowMain { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.qym-rowName { font-size: 13px; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qym-rowIcon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
.qym-rowIcon img { width: 100%; height: 100%; object-fit: contain; }
.qym-rowMeta { font-size: 11.5px; color: var(--qym-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qym-rowActions { flex: none; display: flex; align-items: center; gap: 6px; }

@media (max-width: 768px) {
  .qym-headerInner, .qym-toolbar, .qym-chips, .qym-gridWrap { padding-left: 16px; padding-right: 16px; }
  .qym-searchKbd { display: none; }
}

/* Composer input-left entry —— 点击调用技能/专家。挂在宿主
   conversation.input.left 工具行（连接器入口左边），触发器为紧凑工具按钮，
   点击在其上方弹出 qym-skillMenu 浮层（自带 qym 变量作用域）。
   已选技能/专家以胶囊 chip 就地渲染在同一工具条（未选 ⇄ 已选）。 */
.qym-skillBar {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  overflow-x: auto;
}
.qym-skillChip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  flex: none;
  box-sizing: border-box;
  padding: 0 8px 0 4px;
  border: 1px solid var(--qym-border);
  border-radius: 18px;
  background: var(--qym-surface);
  box-shadow: var(--qym-shadow-sm);
}
.qym-skillChip:hover { border-color: var(--qym-primary-500); }
.qym-skillChipMain {
  appearance: none;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  border-radius: 14px;
  background: transparent;
  color: var(--qym-text-1);
  cursor: pointer;
  transition: background var(--qym-t-fast);
}
.qym-skillChipMain:hover { background: var(--qym-primary-50); }
.qym-skillChipName {
  font-size: 13px;
  font-weight: 700;
  color: var(--qym-text-1);
  white-space: nowrap;
}
.qym-skillChipRemove {
  appearance: none;
  font: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--qym-text-3);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--qym-t-fast);
}
.qym-skillChipRemove:hover { color: var(--qym-danger); background: var(--qym-danger-bg); }
.qym-skillTrigger {
  appearance: none;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--qym-border);
  border-radius: var(--qym-radius-full);
  background: var(--qym-surface);
  color: var(--qym-text-2);
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--qym-t-fast);
}
.qym-skillTrigger:hover { border-color: var(--qym-primary-500); color: var(--qym-primary-600); }
.qym-skillTrigger[aria-expanded='true'] { border-color: var(--qym-primary-500); color: var(--qym-primary-600); }
.qym-skillTriggerLabel { font-weight: 500; }
.qym-skillTriggerIcon { flex: none; }
.qym-skillTriggerCount {
  min-width: 18px;
  height: 18px;
  box-sizing: border-box;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--qym-radius-full);
  background: var(--qym-primary-50);
  color: var(--qym-primary-600);
  font-size: 11px;
  line-height: 18px;
}
.qym-skillScrim {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
}
.qym-skillMenu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  max-height: min(420px, calc(100vh - 24px));
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--qym-border);
  border-radius: var(--qym-radius-md);
  background: var(--qym-surface);
  box-shadow: var(--qym-shadow-md);
}
.qym-skillSearch {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--qym-border-strong);
  border-radius: var(--qym-radius-full);
  background: var(--qym-bg);
  color: var(--qym-text-1);
  font-size: 13px;
  outline: none;
  transition: all var(--qym-t-fast);
}
.qym-skillSearch::placeholder { color: var(--qym-text-3); }
.qym-skillSearch:focus {
  background: var(--qym-surface);
  border-color: var(--qym-primary-500);
  box-shadow: 0 0 0 3px var(--qym-primary-100);
}
.qym-skillList { margin-top: 8px; max-height: 320px; overflow-y: auto; }
.qym-skillGroup + .qym-skillGroup { margin-top: 6px; }
.qym-skillGroupTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--qym-text-3);
}
.qym-skillGroup ul { list-style: none; margin: 0; padding: 0; }
.qym-skillRow {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  box-sizing: border-box;
}
.qym-skillRowMain {
  appearance: none;
  font: inherit;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 8px;
  border: none;
  border-radius: var(--qym-radius-sm);
  background: transparent;
  color: var(--qym-text-1);
  text-align: left;
  cursor: pointer;
  transition: background var(--qym-t-fast);
}
.qym-skillRowMain:hover { background: var(--qym-primary-50); }
.qym-skillRow[data-selected='true'] .qym-skillRowMain { background: var(--qym-primary-50); }
.qym-skillRowSelected { flex: none; font-size: 11px; color: var(--qym-primary-600); }
.qym-skillRowText { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.qym-skillRowTitle {
  font-size: 13px;
  line-height: 18px;
  color: var(--qym-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qym-skillRowName {
  font-size: 12px;
  color: var(--qym-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qym-skillRowGo {
  appearance: none;
  font: inherit;
  flex: none;
  box-sizing: border-box;
  padding: 5px 10px;
  border: none;
  border-radius: var(--qym-radius-sm);
  background: transparent;
  color: var(--qym-primary-600);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--qym-t-fast);
}
.qym-skillRowGo:hover { background: var(--qym-primary-50); }
.qym-skillEmpty { margin: 10px 6px 4px; font-size: 12.5px; line-height: 18px; color: var(--qym-text-3); }
.qym-skillAttachError { margin: 8px 6px 2px; padding: 6px 10px; font-size: 12px; line-height: 17px; color: #b42318; background: #fef3f2; border: 1px solid #fee4e2; border-radius: 8px; }
.qym-skillGroupCount { font-size: 11px; color: var(--qym-text-3); }
`
