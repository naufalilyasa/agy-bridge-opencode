#!/usr/bin/env bash
# ==============================================================================
# agy-bridge Uninstaller (macOS / Linux)
# ==============================================================================
# Removes the agy-bridge integration installed by install.sh:
#   - guard plugin, model routing config, agy-delegation skill
#   - agy CLI runtime configs (mcp_config.json, hooks.json, GEMINI.md, .examples)
#   - omo.jsonc + ON snapshot, opencode.jsonc merge (restored from backup)
#   - CLI shims (agy-bridge-toggle/on/off/status, agy-live, agy-live2)
#
# Safe by design:
#   - Never deletes user data: if the installer found a pre-existing config it
#     wrote a *.new file and left the original untouched — uninstall removes
#     only that *.new artifact, never the original.
#   - opencode.jsonc is restored from the timestamped backup the merge script
#     created before its edit. If no backup exists, entries are NOT force
#     removed — a warning tells you what to strip manually.
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Logging Helpers (Zero Emojis)
# ------------------------------------------------------------------------------
log_info() { printf "[INFO] %s\n" "$*"; }
log_ok()   { printf "[OK]   %s\n" "$*"; }
log_warn() { printf "[WARN] %s\n" "$*"; }

# ------------------------------------------------------------------------------
# Resolve target paths (mirrors install.sh)
# ------------------------------------------------------------------------------
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGINS_DIR="${OPENCODE_CONFIG_DIR}/plugins"
OMO_CONFIG_DIR="${OMO_CONFIG_DIR:-$HOME/.omo}"
GEMINI_CONFIG_DIR="${GEMINI_CONFIG_DIR:-$HOME/.gemini/config}"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-$HOME/.local/bin}"

log_info "agy-bridge uninstaller starting"

# ------------------------------------------------------------------------------
# Component 1: Delegate Guard Plugin
# ------------------------------------------------------------------------------
GUARD_DST="${PLUGINS_DIR}/agy-delegate-guard.js"
if [ -f "${GUARD_DST}" ]; then
  rm -f "${GUARD_DST}"
  log_ok "Removed guard plugin: ${GUARD_DST}"
  # Leave *.bak.* backups in place (user data) but report them.
  if ls "${GUARD_DST}".bak.* >/dev/null 2>&1; then
    log_info "  kept guard plugin backups: ${GUARD_DST}.bak.* (remove manually if desired)"
  fi
else
  log_info "  guard plugin not present (skip)"
fi

# ------------------------------------------------------------------------------
# Component 2a: Model Routing Config (agy_bridge.jsonc)
# ------------------------------------------------------------------------------
ROLES_DST="${GEMINI_CONFIG_DIR}/agy_bridge.jsonc"
if [ -f "${ROLES_DST}.new" ]; then
  # Installer found a pre-existing config and wrote .new — remove only the .new.
  rm -f "${ROLES_DST}.new"
  log_ok "Removed template artifact: ${ROLES_DST}.new (your original config kept)"
elif [ -f "${ROLES_DST}" ]; then
  rm -f "${ROLES_DST}"
  log_ok "Removed model routing config: ${ROLES_DST}"
else
  log_info "  agy_bridge.jsonc not present (skip)"
fi

# ------------------------------------------------------------------------------
# Component 2b: agy-delegation SKILL.md
# ------------------------------------------------------------------------------
SKILL_DIR="${GEMINI_CONFIG_DIR}/skills/agy-delegation"
if [ -d "${SKILL_DIR}" ]; then
  rm -rf "${SKILL_DIR}"
  log_ok "Removed agy-delegation skill: ${SKILL_DIR}"
else
  log_info "  agy-delegation skill not present (skip)"
fi

# ------------------------------------------------------------------------------
# Component 2c: agy CLI runtime configs
# ------------------------------------------------------------------------------
for cfg in mcp_config.json hooks.json GEMINI.md; do
  DST="${GEMINI_CONFIG_DIR}/${cfg}"
  if [ -f "${DST}.new" ]; then
    rm -f "${DST}.new"
    log_ok "Removed template artifact: ${DST}.new (your original ${cfg} kept)"
  elif [ -f "${DST}" ]; then
    rm -f "${DST}"
    log_ok "Removed agy CLI config: ${DST}"
  fi
done

for example in config.json.example settings.json.example; do
  DST="${GEMINI_CONFIG_DIR}/${example}"
  if [ -f "${DST}" ]; then
    rm -f "${DST}"
    log_ok "Removed reference template: ${DST}"
  fi
done

# ------------------------------------------------------------------------------
# Component 3: OMO Configuration (omo.jsonc) + ON snapshot
# ------------------------------------------------------------------------------
OMO_DST="${OMO_CONFIG_DIR}/omo.jsonc"
if [ -f "${OMO_DST}.new" ]; then
  rm -f "${OMO_DST}.new"
  log_ok "Removed template artifact: ${OMO_DST}.new (your original omo.jsonc kept)"
elif [ -f "${OMO_DST}" ]; then
  rm -f "${OMO_DST}"
  log_ok "Removed OMO config: ${OMO_DST}"
fi

SNAP_DIR="${OMO_CONFIG_DIR}/.agy-toggle"
if [ -d "${SNAP_DIR}" ]; then
  rm -rf "${SNAP_DIR}"
  log_ok "Removed toggle snapshot dir: ${SNAP_DIR}"
fi

# ------------------------------------------------------------------------------
# Component 4: OpenCode Config — restore from merge backup
# ------------------------------------------------------------------------------
OPENCODE_DST="${OPENCODE_CONFIG_DIR}/opencode.jsonc"
if [ -f "${OPENCODE_DST}" ] && grep -q "agy-bridge" "${OPENCODE_DST}" 2>/dev/null; then
  # Merge script always backs up before editing: opencode.jsonc.backup-<ts>
  LATEST_BAK="$(ls -1t "${OPENCODE_DST}".backup-* 2>/dev/null | head -n1 || true)"
  if [ -n "${LATEST_BAK}" ]; then
    cp "${LATEST_BAK}" "${OPENCODE_DST}"
    log_ok "Restored opencode.jsonc from merge backup: ${LATEST_BAK}"
  else
    log_warn "opencode.jsonc contains agy-bridge entries but no backup was found."
    log_warn "  Not modifying it. Remove manually:"
    log_warn "    - the \"agy-bridge\" block under mcp{}"
    log_warn "    - \"agy-delegate-guard.js\" (and optionally the oh-my-openagent pin) under plugin[]"
  fi
else
  log_info "  opencode.jsonc has no agy-bridge entries (skip)"
fi

# ------------------------------------------------------------------------------
# Component 5: CLI Shims (~/.local/bin)
# ------------------------------------------------------------------------------
for shim in agy-bridge-toggle agy-bridge-on agy-bridge-off agy-bridge-status agy-live agy-live2; do
  if [ -e "${LOCAL_BIN_DIR}/${shim}" ] || [ -L "${LOCAL_BIN_DIR}/${shim}" ]; then
    rm -f "${LOCAL_BIN_DIR}/${shim}"
    log_ok "Removed shim: ${LOCAL_BIN_DIR}/${shim}"
  fi
done

# ------------------------------------------------------------------------------
# Shell alias advisory
# ------------------------------------------------------------------------------
if grep -q "agy-bridge" "$HOME/.zshrc" 2>/dev/null; then
  log_warn "~/.zshrc still references agy-bridge (aliases agy-bridge-on/off/status or similar)."
  log_warn "  Remove those lines manually, or open a new shell where they no longer apply."
fi

log_ok "agy-bridge uninstall complete."
log_info "Next Steps:"
log_info "  1. Restart OpenCode sessions to drop the agy-bridge MCP server."
log_info "  2. Optional: remove the Antigravity CLI itself — 'rm ~/.local/bin/agy'."
log_info "  3. Optional: the repo clone (this directory) is untouched and can be deleted."
