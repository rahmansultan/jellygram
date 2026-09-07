#!/usr/bin/env bash
#
# Install the systemd *user* units for this checkout.
#
# The units in systemd/ are templates: they carry @APP_DIR@, @NODE@ and @TZ@
# rather than paths from whoever wrote them. This script fills those in from
# the machine it runs on and writes the result to ~/.config/systemd/user/.
#
#   ./deploy/install-systemd.sh              install api, bot, worker, backup
#   ./deploy/install-systemd.sh --geofence   also the optional country fence
#   ./deploy/install-systemd.sh --dry-run    print what would be written
#   ./deploy/install-systemd.sh --uninstall  stop, disable and remove them
#
# It never starts anything on its own — it prints the commands and lets you
# run them, because starting three services against a half-configured .env is
# a worse first experience than one more copy-paste.
#
# User units, not system units, so nothing here needs root. The trade-off is
# that a user unit cannot order itself after a system unit (PostgreSQL, say),
# which is why each service waits for the database itself via wait-for-db.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE_DIR="$APP_DIR/deploy/systemd"

BASE_UNITS=(jellygram-api.service jellygram-bot.service jellygram-worker.service jellygram-backup.service jellygram-backup.timer)
GEOFENCE_UNITS=(jellygram-geofence.service jellygram-geofence.timer)

with_geofence=0
dry_run=0
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --geofence)  with_geofence=1 ;;
    --dry-run)   dry_run=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

units=("${BASE_UNITS[@]}")
(( with_geofence )) && units+=("${GEOFENCE_UNITS[@]}")

if (( uninstall )); then
  echo "Stopping and removing user units..."
  for unit in "${BASE_UNITS[@]}" "${GEOFENCE_UNITS[@]}"; do
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$UNIT_DIR/$unit"
  done
  systemctl --user daemon-reload
  echo "Done. Your .env, database and media were not touched."
  exit 0
fi

# --- The three substitutions -------------------------------------------------

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not on PATH. Install Node.js 22 or newer first." >&2
  exit 1
fi

# A systemd unit needs an absolute interpreter path, and a version manager's
# shim in ~/.nvm or ~/.volta is a real path that keeps working — but only for
# as long as that version stays installed. Say so rather than silently
# producing units that break at the next `nvm install`.
case "$NODE_BIN" in
  "$HOME"/*) echo "Note: node resolves to $NODE_BIN, inside your home directory."
             echo "      If that is a version manager, the units will break when you change"
             echo "      versions. Consider a system-wide Node for a server." ;;
esac

node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "Node $($NODE_BIN -v) is too old; this application needs 22 or newer." >&2
  exit 1
fi

TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Warning: $APP_DIR/.env does not exist yet."
  echo "         The units reference it with EnvironmentFile= and will fail to start"
  echo "         until it does. Run 'npm run init' first."
  echo
fi
if [[ ! -d "$APP_DIR/dist" ]]; then
  echo "Warning: $APP_DIR/dist does not exist yet. Run 'npm run build' first."
  echo
fi

echo "Application : $APP_DIR"
echo "Node        : $NODE_BIN ($($NODE_BIN -v))"
echo "Timezone    : $TZ_NAME"
echo "Unit dir    : $UNIT_DIR"
echo

render() {
  sed -e "s|@APP_DIR@|$APP_DIR|g" \
      -e "s|@NODE@|$NODE_BIN|g" \
      -e "s|@TZ@|$TZ_NAME|g" \
      "$1"
}

if (( dry_run )); then
  for unit in "${units[@]}"; do
    echo "----- $UNIT_DIR/$unit -----"
    render "$TEMPLATE_DIR/$unit.in"
    echo
  done
  exit 0
fi

mkdir -p "$UNIT_DIR"
for unit in "${units[@]}"; do
  render "$TEMPLATE_DIR/$unit.in" > "$UNIT_DIR/$unit"
  echo "wrote $UNIT_DIR/$unit"
done

systemctl --user daemon-reload
echo
echo "Installed. Next:"
echo
echo "  # Let the services survive logout and start at boot."
echo "  # Needs one sudo, and is the only privileged step here."
echo "  sudo loginctl enable-linger \"$USER\""
echo
echo "  systemctl --user enable --now jellygram-api jellygram-worker jellygram-bot"
echo "  systemctl --user enable --now jellygram-backup.timer"
if (( with_geofence )); then
  echo
  echo "  # Edit GEOFENCE_COUNTRY and --must-include in the unit FIRST:"
  echo "  \$EDITOR $UNIT_DIR/jellygram-geofence.service"
  echo "  systemctl --user enable --now jellygram-geofence.timer"
fi
echo
echo "  systemctl --user status jellygram-api jellygram-worker jellygram-bot"
echo "  journalctl --user -u jellygram-worker -f"
