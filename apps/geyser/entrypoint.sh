#!/bin/sh
# Fresh config every start (the template is the source of truth) + the shared Floodgate key.
set -eu
cp /opt/geyser/config.yml /geyser/config.yml
if [ -z "${FLOODGATE_KEY_B64:-}" ]; then
  echo "FLOODGATE_KEY_B64 is not set; Bedrock players can't be authenticated" >&2
  exit 1
fi
umask 077
echo "$FLOODGATE_KEY_B64" | base64 -d > /geyser/key.pem
exec java -Xmx"${GEYSER_MEMORY:-512M}" -jar /opt/geyser/Geyser-Standalone.jar --nogui
