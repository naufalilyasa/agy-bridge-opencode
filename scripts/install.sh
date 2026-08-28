#!/usr/bin/env bash
# ==============================================================================
# agy-bridge & OMO Cross-Platform Installer (macOS / Linux)
# ==============================================================================
# Sets up agy-bridge MCP server, OpenCode configuration, OMO plugin,
# delegate guard plugin, model routing rules, and CLI utilities.
#
# Idempotent and safe:
# - Existing configurations are preserved; new versions written to *.new
# - Plugin files backed up with timestamps before updates
# - Generates convenience shims in ~/.local/bin
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Logging Helpers (Zero Emojis)
# ------------------------------------------------------------------------------
log_info() {
  printf "[INFO] %s\n" "$*"
}

log_ok() {
  printf "[OK] %s\n" "$*"
}

log_warn() {
  printf "[WARN] %s\n" "$*"
}

log_error() {
  printf "[ERROR] %s\n" "$*" >&2
}

# ------------------------------------------------------------------------------
# Resolve Script and Repository Roots
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log_info "agy-bridge repository detected at: ${REPO_DIR}"

# ------------------------------------------------------------------------------
# Configuration Target Paths
# ------------------------------------------------------------------------------
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGINS_DIR="${OPENCODE_CONFIG_DIR}/plugins"
OMO_CONFIG_DIR="${OMO_CONFIG_DIR:-$HOME/.omo}"
GEMINI_CONFIG_DIR="${GEMINI_CONFIG_DIR:-$HOME/.gemini/config}"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-$HOME/.local/bin}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# ------------------------------------------------------------------------------
# Dependency Pre-flight Verification
# ------------------------------------------------------------------------------
log_info "Verifying prerequisites..."

# 1. Node.js (>= 18 required)
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "${NODE_VER}" | cut -d. -f1)"
  if [ "${NODE_MAJOR}" -ge 18 ]; then
    log_ok "Node.js ${NODE_VER} detected."
  else
    log_warn "Node.js version is ${NODE_VER}. Node.js 18+ is recommended."
  fi
else
  log_warn "Node.js not found. Please install Node.js 18+ from https://nodejs.org"
fi

# 2. Bun Runtime (required for agy-live TUI)
if command -v bun >/dev/null 2>&1; then
  BUN_VER="$(bun -v)"
  log_ok "Bun ${BUN_VER} detected."
else
  log_warn "Bun not found. Install via: curl -fsSL https://bun.sh/install | bash"
fi

# 3. Antigravity CLI (agy)
AGY_BIN_PATH=""
if command -v agy >/dev/null 2>&1; then
  AGY_BIN_PATH="$(command -v agy)"
  log_ok "Antigravity CLI (agy) detected at: ${AGY_BIN_PATH}"
elif [ -f "$HOME/.local/bin/agy" ]; then
  AGY_BIN_PATH="$HOME/.local/bin/agy"
  log_ok "Antigravity CLI (agy) detected at: ${AGY_BIN_PATH}"
elif [ -f "/usr/local/bin/agy" ]; then
  AGY_BIN_PATH="/usr/local/bin/agy"
  log_ok "Antigravity CLI (agy) detected at: ${AGY_BIN_PATH}"
else
  AGY_BIN_PATH="$HOME/.local/bin/agy"
  log_warn "Antigravity CLI (agy) not found in PATH."
  log_warn "Defaulting binary path to: ${AGY_BIN_PATH}"
  log_warn "Install Antigravity CLI via: curl -fsSL https://antigravity.google/cli/install.sh | bash"
fi

# 4. OpenCode CLI
if command -v opencode >/dev/null 2>&1; then
  log_ok "OpenCode CLI detected at: $(command -v opencode)"
else
  log_warn "OpenCode CLI not found in PATH."
  log_warn "Install OpenCode CLI via: curl -fsSL https://opencode.ai/install | bash"
fi

# ------------------------------------------------------------------------------
# Create Target Directories
# ------------------------------------------------------------------------------
log_info "Creating destination directories..."
mkdir -p "${OPENCODE_CONFIG_DIR}"
mkdir -p "${PLUGINS_DIR}"
mkdir -p "${OMO_CONFIG_DIR}"
mkdir -p "${GEMINI_CONFIG_DIR}"
mkdir -p "${LOCAL_BIN_DIR}"

# ------------------------------------------------------------------------------
# Install Component 1: Agy Delegate Guard Plugin
# ------------------------------------------------------------------------------
GUARD_SRC="${REPO_DIR}/config/agy-delegate-guard.js.example"
GUARD_DST="${PLUGINS_DIR}/agy-delegate-guard.js"

if [ -f "${GUARD_SRC}" ]; then
  if [ -f "${GUARD_DST}" ]; then
    GUARD_BAK="${GUARD_DST}.bak.${TIMESTAMP}"
    cp "${GUARD_DST}" "${GUARD_BAK}"
    log_info "Existing guard plugin backed up to: ${GUARD_BAK}"
  fi
  cp "${GUARD_SRC}" "${GUARD_DST}"
  chmod +x "${GUARD_DST}" 2>/dev/null || true
  log_ok "Installed guard plugin: ${GUARD_DST}"
else
  log_error "Source file not found: ${GUARD_SRC}"
fi

# ------------------------------------------------------------------------------
# Install Component 2a: Model Routing Config (agy_bridge.jsonc)
# ------------------------------------------------------------------------------
ROLES_SRC="${REPO_DIR}/config/agy_bridge.jsonc.example"
ROLES_DST="${GEMINI_CONFIG_DIR}/agy_bridge.jsonc"

if [ -f "${ROLES_SRC}" ]; then
  if [ -f "${ROLES_DST}" ]; then
    ROLES_NEW="${ROLES_DST}.new"
    cp "${ROLES_SRC}" "${ROLES_NEW}"
    log_warn "Configuration already exists: ${ROLES_DST}"
    log_info "Wrote updated template to: ${ROLES_NEW}"
    log_info "Please review and merge custom role chains manually if needed."
  else
    cp "${ROLES_SRC}" "${ROLES_DST}"
    log_ok "Created model routing config: ${ROLES_DST}"
  fi
else
  log_error "Source file not found: ${ROLES_SRC}"
fi

# ------------------------------------------------------------------------------
# Install Component 2b: agy-delegation SKILL.md (so agy-bridge MCP injects it
# into every delegate prompt via listAvailableSkills scanning
# ~/.gemini/config/skills/<name>/SKILL.md)
# ------------------------------------------------------------------------------
SKILL_SRC="${REPO_DIR}/SKILL.md"
SKILL_DST="${GEMINI_CONFIG_DIR}/skills/agy-delegation/SKILL.md"

if [ -f "${SKILL_SRC}" ]; then
  mkdir -p "$(dirname "${SKILL_DST}")"
  cp "${SKILL_SRC}" "${SKILL_DST}"
  log_ok "Installed agy-delegation skill: ${SKILL_DST}"
else
  log_error "Source file not found: ${SKILL_SRC}"
fi

# ------------------------------------------------------------------------------
# Install Component 2c: agy CLI runtime configs (mcp_config.json, hooks.json,
# GEMINI.md) so the Antigravity CLI gets the same MCP servers, safety hook and
# engineering protocol as the reference laptop. Generic files: auto-installed
# with .new fallback. Machine-specific files (config.json hostname, agy CLI
# settings.json): copied as .example ONLY — do NOT auto-activate.
# ------------------------------------------------------------------------------

# Detect ANDROID_HOME for the mobile-mcp entry (default: macOS/Linux SDK path)
ANDROID_HOME_DETECTED="${ANDROID_HOME:-}"
if [ -z "${ANDROID_HOME_DETECTED}" ] && [ -d "${HOME}/Library/Android/sdk" ]; then
  ANDROID_HOME_DETECTED="${HOME}/Library/Android/sdk"
elif [ -z "${ANDROID_HOME_DETECTED}" ] && [ -d "${HOME}/Android/Sdk" ]; then
  ANDROID_HOME_DETECTED="${HOME}/Android/Sdk"
fi

install_generic_agy_cli_config() {
  local SRC="$1"; local DST="$2"; local LABEL="$3"
  if [ ! -f "${SRC}" ]; then
    log_warn "Source file not found: ${SRC}"
    return 1
  fi
  if [ -f "${DST}" ]; then
    cp "${SRC}" "${DST}.new"
    log_warn "${LABEL} already exists: ${DST}"
    log_info "Wrote updated template to: ${DST}.new — review and merge manually."
    return 0
  fi
  cp "${SRC}" "${DST}"
  log_ok "Created ${LABEL}: ${DST}"
  return 0
}

MCP_SRC="${REPO_DIR}/config/agy-cli-mcp-config.json.example"
MCP_DST="${GEMINI_CONFIG_DIR}/mcp_config.json"
if [ -f "${MCP_SRC}" ]; then
  if [ -z "${ANDROID_HOME_DETECTED}" ]; then
    log_warn "ANDROID_HOME not detected — '{{ANDROID_HOME}}' left in mobile-mcp entry."
    log_warn "Set it manually in ${MCP_DST} if you need the mobile-mcp server."
    install_generic_agy_cli_config "${MCP_SRC}" "${MCP_DST}" "agy CLI MCP config"
  else
    MCP_TMP="$(mktemp)"
    sed "s|{{ANDROID_HOME}}|${ANDROID_HOME_DETECTED}|g" "${MCP_SRC}" > "${MCP_TMP}"
    install_generic_agy_cli_config "${MCP_TMP}" "${MCP_DST}" "agy CLI MCP config"
    rm -f "${MCP_TMP}"
  fi
else
  log_warn "Source file not found: ${MCP_SRC}"
fi

install_generic_agy_cli_config \
  "${REPO_DIR}/config/agy-cli-hooks.json.example" \
  "${GEMINI_CONFIG_DIR}/hooks.json" \
  "agy CLI hooks (cc-safety-net)"

install_generic_agy_cli_config \
  "${REPO_DIR}/config/agy-cli-gemini.md.example" \
  "${GEMINI_CONFIG_DIR}/GEMINI.md" \
  "agy CLI GEMINI.md protocol"

# Machine-specific: ship as reference only, never auto-activate.
cp "${REPO_DIR}/config/agy-cli-config.json.example" "${GEMINI_CONFIG_DIR}/config.json.example" 2>/dev/null \
  && log_ok "Reference template: ${GEMINI_CONFIG_DIR}/config.json.example (edit remoteControlHostname, rename to config.json)" \
  || log_warn "config/agy-cli-config.json.example not found"

cp "${REPO_DIR}/config/agy-cli-settings.json.example" "${GEMINI_CONFIG_DIR}/settings.json.example" 2>/dev/null \
  && log_ok "Reference template: ${GEMINI_CONFIG_DIR}/settings.json.example (add trustedWorkspaces + permissions, rename to settings.json)" \
  || log_warn "config/agy-cli-settings.json.example not found"

# ------------------------------------------------------------------------------
# Install Component 3: OMO Configuration (omo.jsonc)
# ------------------------------------------------------------------------------
OMO_SRC="${REPO_DIR}/config/omo.jsonc.example"
OMO_DST="${OMO_CONFIG_DIR}/omo.jsonc"

if [ -f "${OMO_SRC}" ]; then
  if [ -f "${OMO_DST}" ]; then
    OMO_NEW="${OMO_DST}.new"
    cp "${OMO_SRC}" "${OMO_NEW}"
    log_warn "Configuration already exists: ${OMO_DST}"
    log_info "Wrote updated template to: ${OMO_NEW}"
    log_info "Please review and merge OMO agent definitions manually if needed."
  else
    cp "${OMO_SRC}" "${OMO_DST}"
    log_ok "Created OMO config: ${OMO_DST}"
  fi
else
  log_error "Source file not found: ${OMO_SRC}"
fi

# ------------------------------------------------------------------------------
# Install Component 4: OpenCode Config — MERGE, never override.
# Existing config is surgically updated: plugin[] pins oh-my-openagent@4.19.4
# + guard plugin, mcp{} gains the agy-bridge server. User's own entries,
# providers, API keys, etc. are preserved untouched.
# ------------------------------------------------------------------------------
OPENCODE_SRC="${REPO_DIR}/config/opencode.jsonc.example"
OPENCODE_DST="${OPENCODE_CONFIG_DIR}/opencode.jsonc"
MERGE_SCRIPT="${REPO_DIR}/scripts/merge-opencode-config.mjs"

if [ -f "${OPENCODE_DST}" ]; then
  if [ -f "${MERGE_SCRIPT}" ]; then
    set +e
    node "${MERGE_SCRIPT}" "${OPENCODE_DST}" "${REPO_DIR}" "${AGY_BIN_PATH}"
    RC=$?
    set -e
    if [ "${RC}" -ne 0 ] && [ "${RC}" -ne 2 ]; then
      log_warn "Merge script failed (exit ${RC}) — writing resolved example to ${OPENCODE_DST}.new"
      sed \
        -e "s|{{AGY_BRIDGE_DIR}}|${REPO_DIR}|g" \
        -e "s|{{AGY_PATH}}|${AGY_BIN_PATH}|g" \
        "${OPENCODE_SRC}" > "${OPENCODE_DST}.new"
      log_info "Review and merge ${OPENCODE_DST}.new manually if needed."
    fi
  else
    log_warn "Merge script not found (${MERGE_SCRIPT}) — writing ${OPENCODE_DST}.new for manual review"
    sed \
      -e "s|{{AGY_BRIDGE_DIR}}|${REPO_DIR}|g" \
      -e "s|{{AGY_PATH}}|${AGY_BIN_PATH}|g" \
      "${OPENCODE_SRC}" > "${OPENCODE_DST}.new"
  fi
else
  if [ -f "${OPENCODE_SRC}" ]; then
    sed \
      -e "s|{{AGY_BRIDGE_DIR}}|${REPO_DIR}|g" \
      -e "s|{{AGY_PATH}}|${AGY_BIN_PATH}|g" \
      "${OPENCODE_SRC}" > "${OPENCODE_DST}"
    log_ok "Created OpenCode config with resolved paths: ${OPENCODE_DST}"
  else
    log_error "Source file not found: ${OPENCODE_SRC}"
  fi
fi

# ------------------------------------------------------------------------------
# Install Component 5: Shims & Toggle Utilities (~/.local/bin)
# ------------------------------------------------------------------------------
log_info "Setting up CLI utilities and shims..."

TOGGLE_SRC="${REPO_DIR}/scripts/agy-bridge-toggle"
if [ -f "${TOGGLE_SRC}" ]; then
  chmod +x "${TOGGLE_SRC}"

  # 1. Main toggle utility
  TOGGLE_DST="${LOCAL_BIN_DIR}/agy-bridge-toggle"
  ln -sf "${TOGGLE_SRC}" "${TOGGLE_DST}"
  log_ok "Linked toggle utility: ${TOGGLE_DST}"

  # 2. agy-bridge-on shortcut
  cat << 'EOF' > "${LOCAL_BIN_DIR}/agy-bridge-on"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${DIR}/agy-bridge-toggle" on "$@"
EOF
  chmod +x "${LOCAL_BIN_DIR}/agy-bridge-on"

  # 3. agy-bridge-off shortcut
  cat << 'EOF' > "${LOCAL_BIN_DIR}/agy-bridge-off"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${DIR}/agy-bridge-toggle" off "$@"
EOF
  chmod +x "${LOCAL_BIN_DIR}/agy-bridge-off"

  # 4. agy-bridge-status shortcut
  cat << 'EOF' > "${LOCAL_BIN_DIR}/agy-bridge-status"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${DIR}/agy-bridge-toggle" status "$@"
EOF
  chmod +x "${LOCAL_BIN_DIR}/agy-bridge-status"

  log_ok "Installed shortcuts: agy-bridge-on, agy-bridge-off, agy-bridge-status in ${LOCAL_BIN_DIR}"
else
  log_warn "Toggle script not found at ${TOGGLE_SRC}"
fi

# 5. agy-live runner shortcut
LIVE_RUNNER="${REPO_DIR}/bin/agy-live-runner.js"
if [ -f "${LIVE_RUNNER}" ]; then
  chmod +x "${LIVE_RUNNER}"
  cat << EOF > "${LOCAL_BIN_DIR}/agy-live"
#!/usr/bin/env bash
exec node "${LIVE_RUNNER}" "\$@"
EOF
  chmod +x "${LOCAL_BIN_DIR}/agy-live"
  log_ok "Installed agy-live CLI runner: ${LOCAL_BIN_DIR}/agy-live"
fi

# 6. agy-live2 shortcut (OpenTUI monitor — requires bun)
LIVE_TUI="${REPO_DIR}/bin/agy-live.ts"
if [ -f "${LIVE_TUI}" ]; then
  cat << EOF > "${LOCAL_BIN_DIR}/agy-live2"
#!/usr/bin/env bash
exec bun "${LIVE_TUI}" "\$@"
EOF
  chmod +x "${LOCAL_BIN_DIR}/agy-live2"
  log_ok "Installed agy-live2 OpenTUI runner: ${LOCAL_BIN_DIR}/agy-live2 (requires bun)"
fi

# ------------------------------------------------------------------------------
# Verification & PATH Advisory
# ------------------------------------------------------------------------------
case ":${PATH}:" in
  *:"${LOCAL_BIN_DIR}":*) ;;
  *)
    log_warn "${LOCAL_BIN_DIR} is not currently in your PATH."
    log_warn "Add it by appending the following to your ~/.bashrc or ~/.zshrc:"
    log_warn "  export PATH=\"${LOCAL_BIN_DIR}:\$PATH\""
    ;;
esac

# Build the MCP bundle if missing (npm ci && npm run build)
if [ ! -f "${REPO_DIR}/dist/index.js" ]; then
  log_info "Build artifact 'dist/index.js' not found — building..."
  if command -v npm >/dev/null 2>&1; then
    (cd "${REPO_DIR}" && npm ci && npm run build) || log_warn "npm build failed — run 'npm ci && npm run build' in ${REPO_DIR} manually"
  else
    log_warn "npm not found — run 'npm ci && npm run build' in ${REPO_DIR} manually"
  fi
fi
if [ ! -f "${REPO_DIR}/dist/index.js" ]; then
  log_warn "Build artifact '${REPO_DIR}/dist/index.js' still missing. MCP server won't start until built."
fi

# Seed the ON-state snapshot so `agy-bridge-on` works right after install
if [ -f "${OMO_DST}" ] && [ ! -f "${OMO_CONFIG_DIR}/.agy-toggle/omo.jsonc.on-snapshot" ]; then
  mkdir -p "${OMO_CONFIG_DIR}/.agy-toggle"
  cp "${OMO_DST}" "${OMO_CONFIG_DIR}/.agy-toggle/omo.jsonc.on-snapshot"
  log_ok "Seeded ON-state snapshot for agy-bridge-toggle"
fi

log_ok "agy-bridge installation and setup completed successfully."
log_info "Next Steps:"
log_info "  1. Verify Antigravity CLI models: agy models"
log_info "  2. Check integration state: agy-bridge-status"
log_info "  3. Start OpenCode session: opencode"
