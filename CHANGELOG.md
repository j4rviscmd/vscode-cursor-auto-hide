# Changelog

## [0.0.1]

- Initial release
- Auto-hide mouse cursor after N seconds of inactivity
- 3-layer CSS defense: cursor:none, pointer-events:none, hover UI suppression
- mousedown protection (no hiding during text selection or drag)
- Overlay exemption (dialogs, menus, input fields keep cursor visible)
- Configurable delay: 1–30 seconds (default: 3s)
- Instant delay update without VS Code restart
