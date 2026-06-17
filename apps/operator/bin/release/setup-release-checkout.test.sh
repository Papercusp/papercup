#!/usr/bin/env bash
# Test suite for setup-release-checkout.sh need_node_modules() function.
# Tests the fix for EI-935: detecting new non-scoped dependencies.

set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

# Extract and test the need_node_modules function from the script
SCRIPT_PATH="$(dirname "$0")/setup-release-checkout.sh"

# Helper to run a test case
test_case() {
  local name="$1"
  local expected="$2"
  
  # Run the function in a subshell with the given state
  local actual=0
  (
    set -euo pipefail
    export INTEGRATION_ROOT="$INT_ROOT"
    export RELEASE_ROOT="$REL_ROOT"
    export NODE_MODULES_MODE="auto"
    
    # Source only the need_node_modules function
    source <(sed -n '/^need_node_modules()/,/^}/p' "$SCRIPT_PATH")
    
    # Run the function
    need_node_modules || true
  ) && actual=0 || actual=1
  
  if [ "$actual" -eq "$expected" ]; then
    echo -e "${GREEN}✓${NC} $name"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗${NC} $name (expected $expected, got $actual)"
    ((TESTS_FAILED++))
  fi
}

# Setup test directories
TMPDIR="$(mktemp -d)"
trap "rm -rf '$TMPDIR'" EXIT

INT_ROOT="$TMPDIR/int"
REL_ROOT="$TMPDIR/rel"

mkdir -p "$INT_ROOT/node_modules/@papercusp"
mkdir -p "$INT_ROOT/node_modules/@papercup"
mkdir -p "$REL_ROOT/node_modules/@papercusp"
mkdir -p "$REL_ROOT/node_modules/@papercup"

echo "=== Testing setup-release-checkout.sh need_node_modules() ==="
echo

# Test 1: No node_modules in release → should copy (return 0)
echo "Test 1: No node_modules in release"
rm -rf "$REL_ROOT/node_modules"
test_case "No node_modules in release" 0

# Recreate for subsequent tests
mkdir -p "$REL_ROOT/node_modules/@papercusp"
mkdir -p "$REL_ROOT/node_modules/@papercup"

# Test 2: Identical state → should NOT copy (return 1)
echo
echo "Test 2: Identical node_modules"
test_case "Identical state" 1

# Test 3: New scoped package added → should copy (return 0)
echo
echo "Test 3: New scoped package added"
mkdir -p "$INT_ROOT/node_modules/@papercusp/new-package"
touch "$INT_ROOT/node_modules/@papercusp/new-package/package.json"
test_case "New scoped package in @papercusp" 0

# Cleanup scoped test
rm -rf "$INT_ROOT/node_modules/@papercusp/new-package"

# Test 4: New NON-scoped package added → should copy (return 0) **THIS IS THE KEY TEST FOR EI-935**
echo
echo "Test 4: New non-scoped package added (EI-935 - the fix)"
mkdir -p "$INT_ROOT/node_modules/lodash"
touch "$INT_ROOT/node_modules/lodash/package.json"
test_case "New non-scoped package (lodash) detected" 0

# Cleanup
rm -rf "$INT_ROOT/node_modules/lodash"

# Test 5: Different package-lock.json → should copy (return 0)
echo
echo "Test 5: Different package-lock.json"
echo '{"version": 1}' > "$INT_ROOT/package-lock.json"
echo '{"version": 2}' > "$REL_ROOT/package-lock.json"
test_case "Different package-lock.json" 0

# Test 6: Integration has package-lock.json, release doesn't → should copy (return 0)
echo
echo "Test 6: Missing package-lock.json in release (fail-safe)"
rm "$REL_ROOT/package-lock.json"
test_case "Release missing package-lock.json" 0

# Test 7: Identical package-lock.json → should NOT copy (return 1)
echo
echo "Test 7: Identical package-lock.json"
cp "$INT_ROOT/package-lock.json" "$REL_ROOT/package-lock.json"
test_case "Identical package-lock.json" 1

echo
echo "==================================="
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
if [ "$TESTS_FAILED" -gt 0 ]; then
  echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
else
  echo -e "Tests failed: ${GREEN}0${NC}"
fi
echo "==================================="

exit $TESTS_FAILED
