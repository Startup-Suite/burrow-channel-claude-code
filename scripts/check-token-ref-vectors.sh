#!/bin/sh
# Is spec/token-ref-vectors.json byte-identical to suite-cli's at the pinned commit?
#
# The vectors are defined ONCE, in suite-cli (spec/token-ref.md). This repo
# vendors a copy so its tests run offline, and pins the suite-cli commit it was
# copied from in spec/token-ref-vectors.pin. This script fetches that commit's
# file and compares bytes. Any difference -- a local edit, or a pin that names
# a different file -- exits 1 and prints the diff. A fetch that fails exits 2:
# a check that cannot see upstream must not read as a pass.
#
#   SUITE_CLI_VECTORS_URL   fetch from here instead (a file:// URL in tests)
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
vendored="$here/spec/token-ref-vectors.json"
pin_file="$here/spec/token-ref-vectors.pin"

[ -f "$vendored" ] || { printf 'check-token-ref-vectors: %s is missing\n' "$vendored" >&2; exit 1; }
[ -f "$pin_file" ] || { printf 'check-token-ref-vectors: %s is missing\n' "$pin_file" >&2; exit 1; }
pin="$(tr -d ' \n\r\t' <"$pin_file")"
case "$pin" in
*[!0-9a-f]* | '') printf 'check-token-ref-vectors: pin %s is not a commit sha\n' "$pin" >&2; exit 1 ;;
esac
[ "${#pin}" -eq 40 ] || { printf 'check-token-ref-vectors: pin %s is not a full 40-hex sha\n' "$pin" >&2; exit 1; }

url="${SUITE_CLI_VECTORS_URL:-https://raw.githubusercontent.com/Startup-Suite/suite-cli/$pin/spec/token-ref-vectors.json}"
tmp="$(mktemp "${TMPDIR:-/tmp}/token-ref-vectors.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT HUP TERM

if ! curl -fsSL "$url" -o "$tmp"; then
	printf 'check-token-ref-vectors: could not fetch %s\n' "$url" >&2
	exit 2
fi
if cmp -s "$tmp" "$vendored"; then
	printf 'check-token-ref-vectors: spec/token-ref-vectors.json matches suite-cli@%s\n' "$pin"
	exit 0
fi
printf 'check-token-ref-vectors: spec/token-ref-vectors.json DIFFERS from suite-cli@%s:\n' "$pin" >&2
diff -u "$tmp" "$vendored" >&2 || true
exit 1
