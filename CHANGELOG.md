# Changelog

## [0.1.2] - 2026-04-05

### Fixed
- Allow keyboard-triggered suggest widget (Ctrl+Space IntelliSense) to display correctly while cursor is hidden
- Narrow Layer 3 CSS to only target `.monaco-tooltip` instead of blanket-hiding all `overflowingContentWidgets` children
- Suppress `.monaco-sash` hover highlight persistence when cursor is hidden

### Changed
- Extend overlay exemptions with `.suggest-widget`, `.suggest-details-container`, and `.parameter-hints-widget`
- Refactor JS `overlayWatcher` to monitor `.suggest-widget` display changes alongside `.quick-input-widget`

## [0.1.1] - 2026-03-30

### Fixed
- Restore cursor visibility when quickOpen (Cmd+P) is opened while cursor is hidden
- Restore cursor visibility when Quick Fix suggestions (Ctrl+.) are triggered
- Split Layer 1 CSS: `pointer-events:none` no longer applied to `<html>` element itself, preventing Chromium focus-dispatch disruption
- Properly disconnect MutationObservers in `destroy()` to prevent leaks on re-injection

### Changed
- Expand overlay exemptions: added `.editor-widget`, `.zone-widget`, `.action-widget`, `.context-view`
- Add MutationObserver `watchOverlayWidgets()` to detect overlay widget visibility changes and call `show()` immediately
- Add SSH environment limitation to Known Limitations in README

## [0.0.1]

- Initial release
- Auto-hide mouse cursor after N seconds of inactivity
- 3-layer CSS defense: cursor:none, pointer-events:none, hover UI suppression
- mousedown protection (no hiding during text selection or drag)
- Overlay exemption (dialogs, menus, input fields keep cursor visible)
- Configurable delay: 1–30 seconds (default: 3s)
- Instant delay update without VS Code restart
