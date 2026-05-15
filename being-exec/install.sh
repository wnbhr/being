#!/usr/bin/env bash
# being-exec one-line installer
# Usage:
#   BRIDGE_TOKEN=<token> curl -sSL https://raw.githubusercontent.com/wnbhr/ruddia/main/being-exec/install.sh | bash
#
# Requirements: Linux amd64, systemd, curl, sudo

set -euo pipefail

VERSION="${BRIDGE_VERSION:-0.1.0}"
INSTALL_DIR="/opt/being-exec"
SERVICE_USER="being-exec"
SERVICE_FILE="/etc/systemd/system/being-exec.service"
REPO="wnbhr/ruddia"
BASE_URL="https://github.com/${REPO}/releases/download/exec-v${VERSION}"
BINARY_URL="${BASE_URL}/being-exec-linux-amd64"

echo "==> Being Exec installer v${VERSION}"
echo ""

# ── Detect OS ──────────────────────────────────────────────────────────────
ARCH=$(uname -m)
if [[ "$ARCH" != "x86_64" ]]; then
  echo "ERROR: Only linux/amd64 is supported in this release." >&2
  exit 1
fi

# ── Create user ────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
  echo "==> Creating system user: $SERVICE_USER"
  sudo useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

# ── Install directory ──────────────────────────────────────────────────────
echo "==> Installing to $INSTALL_DIR"
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── Download binary ────────────────────────────────────────────────────────
TMP=$(mktemp)
trap "rm -f $TMP" EXIT

echo "==> Downloading binary from $BINARY_URL"
curl -sSL "$BINARY_URL" -o "$TMP"
chmod +x "$TMP"
sudo install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$TMP" "$INSTALL_DIR/being-exec"

# ── Config ─────────────────────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/config.yaml" ]]; then
  echo "==> Installing default config to $INSTALL_DIR/config.yaml"
  EXAMPLE_URL="https://raw.githubusercontent.com/${REPO}/main/being-exec/config.example.yaml"
  sudo curl -sSL "$EXAMPLE_URL" -o "$INSTALL_DIR/config.yaml"
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/config.yaml"
  sudo chmod 0640 "$INSTALL_DIR/config.yaml"
else
  echo "==> Config already exists at $INSTALL_DIR/config.yaml — skipping."
fi

# ── Env file (token) ──────────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/env" ]]; then
  if [[ -n "${BRIDGE_TOKEN:-}" ]]; then
    echo "==> Writing token to $INSTALL_DIR/env"
    printf 'BRIDGE_TOKEN=%s\n' "$BRIDGE_TOKEN" | sudo tee "$INSTALL_DIR/env" > /dev/null
    sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/env"
    sudo chmod 0600 "$INSTALL_DIR/env"
  else
    echo ""
    echo "  ⚠️  No BRIDGE_TOKEN set."
    echo "  Create $INSTALL_DIR/env with:"
    echo "    BRIDGE_TOKEN=<your-secret-token>"
    echo "  Then: sudo systemctl restart being-exec"
    echo ""
    # Create empty env file so systemd doesn't fail
    sudo touch "$INSTALL_DIR/env"
    sudo chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/env"
    sudo chmod 0600 "$INSTALL_DIR/env"
  fi
else
  echo "==> Env file already exists at $INSTALL_DIR/env — skipping."
fi

# ── systemd unit ───────────────────────────────────────────────────────────
echo "==> Installing systemd unit"
SERVICE_URL="https://raw.githubusercontent.com/${REPO}/main/being-exec/being-exec.service"
sudo curl -sSL "$SERVICE_URL" -o "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable being-exec
sudo systemctl restart being-exec

echo ""
echo "==> being-exec installed and started."
echo ""
echo "  Status:  sudo systemctl status being-exec"
echo "  Logs:    sudo journalctl -u being-exec -f"
echo "  Config:  sudo nano $INSTALL_DIR/config.yaml"
echo "  Token:   sudo nano $INSTALL_DIR/env"
echo ""
echo "  Health check (local):  curl http://127.0.0.1:7070/health"
echo ""
echo "  Next: set up a tunnel (e.g. Cloudflare Tunnel) pointing to"
echo "        http://127.0.0.1:7070 and register the HTTPS URL in"
echo "        your Being's partner_tools.remote_hosts."
