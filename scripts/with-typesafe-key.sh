#!/bin/zsh
# Run one command with the TypeSafe key read from macOS Keychain.
# It is exported only to the launched process and its children.

set -eu

readonly SERVICE="jev-playground/TYPESAFE_API_KEY"
readonly ACCOUNT="$(/usr/bin/id -un)"

if (( $# == 0 )); then
  print -u2 "Usage: scripts/with-typesafe-key.sh <command> [arguments...]"
  print -u2 "Example: scripts/with-typesafe-key.sh npm run dev"
  exit 64
fi

if ! /usr/bin/security find-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1; then
  print -u2 "No TypeSafe key is stored for this macOS account."
  print -u2 "Run scripts/store-typesafe-key.sh first."
  exit 1
fi

export TYPESAFE_API_KEY="$(/usr/bin/security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w)"
exec "$@"
