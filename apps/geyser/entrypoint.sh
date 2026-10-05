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
mkdir -p /geyser/native
# Netty unpacks its native transport here; /tmp is a noexec tmpfs in this hardened container.
exec java -Xmx"${GEYSER_MEMORY:-512M}" -Dio.netty.native.workdir=/geyser/native -jar /opt/geyser/Geyser-Standalone.jar --nogui
