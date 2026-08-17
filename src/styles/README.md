# Portiva CSS architecture

`src/App.css` is an ordered manifest for the application shell and its shared
contracts. Keep imports in cascade order and put new rules in the smallest
relevant module instead of adding rules to the manifest.

## Layers

1. `app/foundation.css` — reset, theme palette and reusable UI primitives.
2. `designTokens.css` — spacing, radius, icon, typography, control and row scales.
3. `app/chrome-and-dialogs.css` — application shell, titlebar and dialogs.
4. `app/terminal-workspace.css` — session tabs, workspace and terminal home.
5. `app/connections.css` — saved connections and connection cards.
6. `app/terminal-and-serial.css` — terminal canvas and serial debugger.
7. `app/file-transfer.css` — SFTP and local/remote file browsers.
8. `app/settings.css` — settings navigation and panels.
9. `app/http-*.css` — HTTP foundation, workspace, request editor and states.
10. `app/status-and-theme.css` — shared status areas and final theme overrides.

Cross-feature contracts live next to the modules:

- `componentGeometry.css` maps shared components and legacy feature controls to
  the geometry tokens while those features migrate to shared UI primitives.
- `responsiveTypography.css` applies font-responsive heights and overflow fixes.
- `appWallpaper.css` owns wallpaper surfaces and transparency behavior.

## Token contract

- Colors are semantic: use `--text-strong`, `--text-main`, `--text-muted`,
  `--text-soft`, `--accent`, `--danger`, `--success`, `--online`, `--warning`,
  the `--*-bg` surface roles and the shared border roles. Feature CSS must not
  repeat their hex values.
- Spacing follows the 4px scale in `designTokens.css`: `--space-0-5` through
  `--space-6`. A feature-specific value is acceptable only for optical alignment.
- Controls use `--control-radius`; cards and top-level content surfaces use
  `--surface-radius`. Use `--radius-pill` or `50%` only for genuinely round UI.
- Text controls use `--control-height-sm`, `--control-height` or
  `--control-height-lg`. Rows use the compact/content/section row tokens.
- Font declarations use the generated `--app-font-size-N` scale or the semantic
  `--font-size-*` aliases. Heights containing text must grow from the same scale.

## Rules for new UI

- Prefer components from `src/shared/ui.tsx` (`Button`, `IconButton`,
  `TextInput`, `Select`, `Card`, `Tag`, `Toggle`) before adding feature-specific
  control CSS.
- Use the token contract above instead of raw colors, standard spacing values,
  radii or fixed control sizes.
- Text-bearing containers use `min-height` and padding. Avoid fixed `height` or
  pixel `line-height` because the application font can scale from 8px to 32px.
- Feature modules own their layout and choose semantic roles. Token values live
  only in `designTokens.css`; shared component mappings live in
  `componentGeometry.css`.
- Preserve the import order in `App.css`. Later modules intentionally refine
  earlier shared styles.
