#!/bin/bash
set -e

# This script runs as root on startup, fixes volume permissions, 
# then drops privileges to pptruser for security.

USER_ID=${PUID:-1000}
GROUP_ID=${PGID:-1000}

echo "Starting initialization script..."

# Ensure the data directory exists
mkdir -p "$CHROME_USER_DATA_DIR"

# Fix permissions for the mounted volume
echo "Fixing permissions for $CHROME_USER_DATA_DIR..."
chown -R pptruser:pptruser "$CHROME_USER_DATA_DIR"
chown -R pptruser:pptruser /app

# Check if we should fix permissions for /tmp/chrome-data too
if [ -d "/tmp/chrome-data" ]; then
    chown -R pptruser:pptruser /tmp/chrome-data
fi

echo "Permissions fixed. Switching to pptruser..."

# Execute the main command as pptruser
# Using 'exec' to ensure signals (like SIGTERM) reach the node process
exec gosu pptruser npm start
