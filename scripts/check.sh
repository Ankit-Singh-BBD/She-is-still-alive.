#!/usr/bin/env bash
set -euo pipefail

# P01 - check.sh - Runs lint, typecheck, and test in order.

echo "=== lint ==="
npm run lint

echo "=== typecheck ==="
npm run typecheck

echo "=== test ==="
npm run test

echo "=== all checks passed ==="
