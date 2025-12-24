#!/bin/bash

# Cron Job Setup for OpenTable Monitor
# This script sets up automated monitoring every 30 minutes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_SCRIPT="$SCRIPT_DIR/monitor.js"
LOG_FILE="$SCRIPT_DIR/data/monitor.log"

# Ensure data directory exists
mkdir -p "$SCRIPT_DIR/data"

# Create wrapper script that handles environment
cat > "$SCRIPT_DIR/run-monitor.sh" << 'WRAPPER'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment variables if present
[ -f .env ] && export $(cat .env | grep -v '^#' | xargs)

# Run the monitor
node monitor.js >> data/monitor.log 2>&1
WRAPPER

chmod +x "$SCRIPT_DIR/run-monitor.sh"

echo "OpenTable Monitor Cron Setup"
echo "=============================="
echo ""

# Show current crontab
echo "Current crontab entries:"
crontab -l 2>/dev/null || echo "(none)"
echo ""

# Generate cron line
CRON_LINE="*/30 * * * * $SCRIPT_DIR/run-monitor.sh"

echo "Recommended cron entry (runs every 30 minutes):"
echo ""
echo "  $CRON_LINE"
echo ""

read -p "Add this to your crontab? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Add to crontab if not already present
    (crontab -l 2>/dev/null | grep -v "run-monitor.sh"; echo "$CRON_LINE") | crontab -
    echo "✅ Cron job added!"
    echo ""
    echo "New crontab:"
    crontab -l
else
    echo ""
    echo "To add manually, run:"
    echo "  crontab -e"
    echo ""
    echo "Then add this line:"
    echo "  $CRON_LINE"
fi

echo ""
echo "=============================="
echo "Other useful commands:"
echo ""
echo "  View logs:        tail -f $LOG_FILE"
echo "  Run once:         $SCRIPT_DIR/run-monitor.sh"
echo "  Remove cron:      crontab -e (delete the line)"
echo ""
