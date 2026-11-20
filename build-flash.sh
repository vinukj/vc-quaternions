#!/bin/bash
#
# build-flash.sh — build + flash + monitor for the Cricket Bat Tracker
#
# Prerequisites (install first):
#   $ . $IDF_PATH/export.sh        # or install ESP-IDF: pip install esp-idf
#   $ idf.py --version
#
# Usage:
#   ./build-flash.sh              # build + flash + monitor
#   ./build-flash.sh flash        # flash only (no monitor)
#   ./build-flash.sh clean        # clean build
#   ./build-flash.sh build        # build only
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET=$1
case "$TARGET" in
    flash)
        echo "=== Flashing firmware ==="
        idf.py flash
        ;;
    clean)
        echo "=== Cleaning build ==="
        idf.py fullclean
        ;;
    monitor)
        echo "=== Starting monitor ==="
        idf.py monitor
        ;;
    build)
        echo "=== Building firmware ==="
        idf.py build
        ;;
    *)
        echo "=== Building firmware ==="
        idf.py build
        echo "=== Flashing firmware ==="
        idf.py flash
        echo "=== Starting monitor ==="
        idf.py monitor
        ;;
esac
