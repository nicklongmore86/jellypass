#!/usr/bin/env bash
# Takes the App Store screenshots on one fresh simulator: take.sh <app> <out dir> <expected WxH> <device type>...
# The first device type the runner's Xcode has is created on its newest iOS runtime, booted with a clean status bar,
# given the app, and walked through flows/ with Maestro. After each flow the screen is saved at full resolution with
# simctl (Maestro's own screenshots can be scaled), named for its place in the App Store listing.
set -euo pipefail

app="$1"
out="$2"
expected="$3"
shift 3
here="$(cd "$(dirname "$0")" && pwd)"

# Each flow, and the listing position and name of the screenshot taken after it.
shots=(
  "01-address:06-sign-in"
  "02-home:01-home"
  "03-see-all:02-see-all"
  "04-requests:04-my-requests"
  "05-search:05-search"
  "06-title:03-title"
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
  if ! maestro --device "$udid" test "${here}/flows/${flow}.yaml"; then
    # What the screen showed when the flow gave up, for the run's maestro-debug artifact.
    xcrun simctl io "$udid" screenshot --type=png "${out}/failed-${flow}.png" || true
    echo "::error::The ${flow} flow failed on ${name}"
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
