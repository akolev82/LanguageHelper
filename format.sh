#!/bin/bash
# format.sh
# Unified formatting utility script for LanguageHelper monorepo

set -e

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORKSPACE_ROOT="$SCRIPT_DIR"

echo "🚀 Starting the format script..."

# Mode flags
RUST_MODE="apply" # apply, check
DART_MODE="apply" # apply, check
SH_MODE="apply"   # apply, check

for arg in "$@"; do
  case "$arg" in
    --rust-check)
      RUST_MODE="check"
      DART_MODE="none"
      SH_MODE="none"
      ;;
    --dart-check)
      DART_MODE="check"
      RUST_MODE="none"
      SH_MODE="none"
      ;;
    --sh-check)
      SH_MODE="check"
      RUST_MODE="none"
      DART_MODE="none"
      ;;
    --check|--set-exit-if-changed)
      RUST_MODE="check"
      DART_MODE="check"
      SH_MODE="check"
      ;;
  esac
done

# 1. Rust Formatter
if [ "$RUST_MODE" != "none" ]; then
  CARGO_ARGS=()
  if [ "$RUST_MODE" == "check" ]; then
    CARGO_ARGS+=("--check")
  fi
  echo "Running Rust formatter ($RUST_MODE)..."
  cargo fmt --manifest-path "$WORKSPACE_ROOT/Cargo.toml" --all "${CARGO_ARGS[@]}"
fi

# 2. Dart Formatter
if [ "$DART_MODE" != "none" ]; then
  if command -v dart &> /dev/null; then
    DART_FLAGS=(--line-length 300)
    if [ "$DART_MODE" == "check" ]; then
      DART_FLAGS+=("--set-exit-if-changed")
    fi
    echo "Running Dart formatter ($DART_MODE)..."
    if [ -d "$WORKSPACE_ROOT/apps/frontend" ]; then
      dart format "$WORKSPACE_ROOT/apps/frontend" "${DART_FLAGS[@]}"
    fi
  fi
fi

# 3. Shell Scripts Formatter
if [ "$SH_MODE" != "none" ]; then
  if command -v shfmt &> /dev/null; then
    echo "Running Shell script formatter ($SH_MODE)..."
    if [ "$SH_MODE" == "check" ]; then
      shfmt -d -i 2 -bn "$WORKSPACE_ROOT"/*.sh
    else
      shfmt -w -i 2 -bn "$WORKSPACE_ROOT"/*.sh
    fi
  fi
fi

echo "✅ Formatting script finished successfully."
