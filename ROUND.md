# ROUND 14 — 2026-08-06 (autonomous iteration round 14)

User instruction: **improve UI/UX** — mobile/responsive polish across every
page, verified through device-emulated browser probes.

## What changed this round

- **Site nav on small screens** — at ≤640px the nav gutters, gaps, and link
  padding compact; at ≤380px the brand shortens to "FMCV" so all five nav
  links fit a 320px-wide viewport (previously the Settings link was clipped
  off-screen).
- **Agent page** — `.container` now shrinks to the viewport (`min-width: 0`),
  header action rows (Chat/Sessions/Channels/Workspace/model/Clear) wrap, and
  the composer with the Send button stays fully on-screen at 320px (previously
  a 657px-wide row pushed the content off-center and clipped Send).
- **Settings page** — container, field rows, action rows, and connection-list
  items wrap at small widths so no control extends past the viewport.
- **Files page** — container shrink, header scope select/refresh wrap, and
  file rows switch to a three-column grid (icon, ellipsized name, actions)
  with size/mtime hidden on phones; long names truncate instead of wrapping
  or overflowing.
- **Home page** — dark mode now renders the landing card as a `#111827`
  surface with a border (previously an invisible black-on-black panel); CTA
  rows wrap and the layout compacts on narrow screens.
- **Browser E2E** — new mobile probes for all four routes at 360×640
  (`Emulation.setDeviceMetricsOverride`): no horizontal overflow, nav links
  fit, agent composer visible, files rows use the responsive grid; the home
  dark probe now also asserts the card color. New `*-mobile.png` screenshots;
  report refreshed.

## Test status

- Unit: **59 passed / 10 suites**.
- API E2E: **44 passed / 7 suites**.
- Backend build: `nest build` clean.
- Frontend: `tsc --noEmit` + `eslint` clean (`next build` clean in Docker).
- Browser E2E: all green, exit 0 — zero console/network errors on every
  probe (light, dark, mobile) and all live flows; mobile + dark checks pass.

## Known issues / open tickets

- None. 320px is the verified floor; real phones below that (rare legacy
  devices) would need a hamburger menu, which is not worth the complexity for
  this tool. No TODO/FIXME/XXX/HACK markers introduced; worktree clean end of
  round.

## Next round focus

- (empty) — mobile polish shipped with green suites and accurate docs; no open
  tickets and no obviously valuable follow-up without a new user instruction.
  Loop closed per exit condition C.
