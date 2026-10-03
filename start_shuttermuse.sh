#!/usr/bin/env bash
# ==============================================================================
# ShutterMuse 4-Bit Photography Guidance Server Launcher
# Optimized for RTX 4050 (6GB VRAM) & Miniconda Environment
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find Python executable
if [ -x "/home/fahim/miniconda3/bin/python" ]; then
    PYTHON_EXEC="/home/fahim/miniconda3/bin/python"
elif command -v python3 &> /dev/null; then
    PYTHON_EXEC="$(command -v python3)"
else
    echo "[-] Error: Python executable not found."
    exit 1
fi

export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export SHUTTERMUSE_MODEL_PATH="${SHUTTERMUSE_MODEL_PATH:-$SCRIPT_DIR/ShutterMuse-4bit}"
export SHUTTERMUSE_HOST="${SHUTTERMUSE_HOST:-0.0.0.0}"
export SHUTTERMUSE_PORT="${SHUTTERMUSE_PORT:-8000}"

echo "=========================================================="
echo " Starting ShutterMuse 4-Bit Inference Server"
echo " Python:     $PYTHON_EXEC"
echo " Model:      $SHUTTERMUSE_MODEL_PATH"
echo " Host:       $SHUTTERMUSE_HOST"
echo " Port:       $SHUTTERMUSE_PORT"
echo " Docs:       http://localhost:$SHUTTERMUSE_PORT/docs"
echo " Health:     http://localhost:$SHUTTERMUSE_PORT/health"
echo "=========================================================="

exec "$PYTHON_EXEC" "$SCRIPT_DIR/shuttermuse_server.py" \
  --host "$SHUTTERMUSE_HOST" \
  --port "$SHUTTERMUSE_PORT" \
  --model-path "$SHUTTERMUSE_MODEL_PATH" "$@"
