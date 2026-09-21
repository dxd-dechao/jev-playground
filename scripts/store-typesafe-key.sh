#!/bin/zsh
# Store the TypeSafe credential in the logged-in user's macOS login Keychain.
# The `security` tool prompts for the password; this script never accepts it
# as an argument, writes it to disk, or prints it.

set -eu

readonly SERVICE="jev-playground/TYPESAFE_API_KEY"
readonly ACCOUNT="$(/usr/bin/id -un)"

print "Store or update the TypeSafe key for ${ACCOUNT} in the login Keychain."
print "When prompted, paste the key into the macOS password prompt."

# `-w` must be the final argument: macOS then prompts securely instead of
# putting the value in shell history or the process command line.
/usr/bin/security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" \
  -l "Jev playground TypeSafe API key" -w

print "Saved in macOS Keychain. Use scripts/with-typesafe-key.sh to run the app."
