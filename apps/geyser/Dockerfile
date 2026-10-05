# Geyser Standalone: translates Bedrock (UDP 19132) to Java for the gatekeeper on 127.0.0.1:25565.
# Build from the repo root:  docker build -f apps/geyser/Dockerfile .
FROM eclipse-temurin:21-jre-alpine

# Pinned build, verified by hash at build time.
ARG GEYSER_URL=https://download.geysermc.org/v2/projects/geyser/versions/2.11.3/builds/1248/downloads/standalone
ARG GEYSER_SHA256=17a9e00f3be106c797066664679ca73ebf25af693a750f378a9669ca93b4c07e
RUN mkdir -p /opt/geyser \
 && wget -qO /opt/geyser/Geyser-Standalone.jar "$GEYSER_URL" \
 && echo "$GEYSER_SHA256  /opt/geyser/Geyser-Standalone.jar" | sha256sum -c -

RUN adduser -D -u 1000 geyser && mkdir -p /geyser && chown geyser /geyser
COPY apps/geyser/entrypoint.sh /entrypoint.sh
COPY apps/geyser/config.yml /opt/geyser/config.yml
WORKDIR /geyser
USER geyser
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
