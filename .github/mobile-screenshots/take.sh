#!/usr/bin/env bash
# Takes the App Store screenshots on one fresh simulator: take.sh <app> <out dir> <expected WxH> <device type>...
# The first device type the runner's Xcode has is created on its newest iOS runtime, booted with a clean status bar,
# given the app, and walked through flows/ with Maestro. After each flow the screen is saved at full resolution with
# simctl (Maestro's own screenshots can be scaled), named for its place in the App Store listing.
set -euo pipefail

missing=0
if [ -z "${ADDRESS:-}" ]; then
  echo "::error::Missing ADDRESS; set MOBILE_SCREENSHOT_ADDRESS for the workflow"
  missing=1
fi
if [ -z "${PROFILE:-}" ]; then
  echo "::error::Missing PROFILE; set MOBILE_SCREENSHOT_PROFILE for the workflow"
  missing=1
fi
[ "$missing" -eq 0 ] || exit 1

app="$1"
out="$2"
expected="$3"
shift 3
here="$(cd "$(dirname "$0")" && pwd)"

# Each flow, and the listing position and name of the screenshot taken after it. The flows run in the app's order
# (sign in comes first); the listing leads with the demo library's own titles and collection, and Home, whose posters
# come from TMDB, stays late.
shots=(
  "01-address:07-sign-in"
  "02-home:06-home"
  "03-search:03-search"
  "04-title-sintel:01-sintel"
  "05-title-tears-of-steel:02-tears-of-steel"
  "06-collection-caminandes:05-caminandes-collection"
  "07-requests:04-my-requests"
)

runtime="$(xcrun simctl list runtimes --json | jq -r '[.runtimes[] | select(.isAvailable and .platform == "iOS")] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier')"
types="$(xcrun simctl list devicetypes --json)"
device_type=""
for name in "$@"; do
  device_type="$(jq -r --arg name "$name" '.devicetypes[] | select(.name == $name) | .identifier' <<<"$types")"
  [ -n "$device_type" ] && break
done
if [ -z "$device_type" ]; then
  echo "::error::None of these simulators is available: $*"
  jq -r '.devicetypes[].name' <<<"$types"
  exit 1
fi
echo "Simulator: ${name} on ${runtime}"

udid="$(xcrun simctl create "screenshots-${name}" "$device_type" "$runtime")"
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
xcrun simctl ui "$udid" appearance light
# A full battery that is not charging: "charged" draws the charging bolt.
xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --operatorName '' --batteryState discharging --batteryLevel 100
xcrun simctl install "$udid" "$app"

mkdir -p "$out"
if [[ "$name" == iPad* ]]; then
  maestro --device "$udid" test "${here}/flows/00-ipad-full-screen.yaml"
fi
for shot in "${shots[@]}"; do
  flow="${shot%%:*}"
  file="${out}/${shot#*:}.png"
  if ! maestro --device "$udid" test -e ADDRESS="$ADDRESS" -e PROFILE="$PROFILE" "${here}/flows/${flow}.yaml"; then
    # Do not capture failure screens: sign-in failures may display configured values. Only which of the app's own
    # fixed labels were on screen is printed, from Maestro's debug output (never uploaded).
    echo "::error::The ${flow} flow failed on ${name}"
    echo "App labels on screen:"
    grep -rhoF -e 'Connect to your household' -e 'Loading…' -e 'Choose your profile to sign in.' -e 'Try again' \
      -e "Can't sign in right now" -e 'Check your connection' -e "There's no JellyPass household" -e 'Too many attempts' \
      -e "Can't keep your sign-in" -e 'Sign in with a different name' -e 'See all Trending' "$HOME/.maestro/tests" 2>/dev/null |
      sort | uniq -c || true
    exit 1
  fi
  # Posters arrive after the screen settles; give them a moment.
  sleep 4
  xcrun simctl io "$udid" screenshot --type=png "$file"
done

# App Store Connect takes exact sizes only, and no alpha channel: simctl's PNGs have one, so it is dropped first.
xcrun swift "${here}/strip-alpha.swift" "$out"/*.png
failed=0
for file in "$out"/*.png; do
  width="$(sips -g pixelWidth "$file" | awk '/pixelWidth/ {print $2}')"
  height="$(sips -g pixelHeight "$file" | awk '/pixelHeight/ {print $2}')"
  alpha="$(sips -g hasAlpha "$file" | awk '/hasAlpha/ {print $2}')"
  echo "$(basename "$file"): ${width}x${height}, alpha: ${alpha}"
  if [ "${width}x${height}" != "$expected" ]; then
    echo "::error::$(basename "$file") is ${width}x${height}, not ${expected}"
    failed=1
  fi
  if [ "$alpha" = "yes" ]; then
    echo "::error::$(basename "$file") has an alpha channel"
    failed=1
  fi
done

xcrun simctl shutdown "$udid"
xcrun simctl delete "$udid"
exit "$failed"
