# Workflow UI Maintenance Notes

## March 24, 2026

This update tightened a few workflow and generated-doc regressions that surfaced after the Astro + React Flow migration work.

### Workflow Studio fixes

- Normalized the Workflow Studio share query so the browser URL can store the base object as a stable slug while the request bundle and atomic config still use NetSuite record names.
- Bound the base-object dropdown to the active resolved slug so the combobox renders correctly even when the incoming query uses a record name such as `salesOrder`.
- Added explicit select text styling so browser-native select controls remain readable across platforms.

### Pill and chip overflow fixes

- Hardened the React Flow node pills to allow wrapping inside narrow node cards without clipping.
- Hardened the generated static transform chips so long record names and transform labels wrap inside their cards instead of bleeding across neighboring columns.
- Rebuilt the generated HTML outputs so the overflow fixes are reflected in `public.html`, `transforms.html`, and the record pages under `public/records/`.

### Section reordering feedback

- Added a visible insertion marker to the left navigation panel during section drag-and-drop.
- Updated the section reordering controller to distinguish dropping before vs. after the hovered section instead of only reordering by target index.

### Verification

- `npm run build`
- `npm run netsuite:build`
- Browser verification of the Astro Workflow Studio route and the generated `transforms.html` page
