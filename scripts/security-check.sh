#!/usr/bin/env bash
# WorldSmith security regression checks. Run from a device on the owner's tailnet:
#   bash scripts/security-check.sh
# Exits non-zero if any check fails.
set -u

HOST="${WS_HOST:-worldsmith.tail072963.ts.net}"
B="https://$HOST"
TS_IP="${WS_TS_IP:-$(docker exec worldsmith-ts-1 tailscale ip -4 2>/dev/null | head -1)}"
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then printf "  ✔ %-58s %s\n" "$1" "$3"; else printf "  ✘ %-58s got %s, want %s\n" "$1" "$3" "$2"; fail=1; fi
}
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$@" 2>/dev/null; }

# Wait (up to 60 s) for the hub to answer, so a just-restarted hub isn't reported as a failure.
for _ in $(seq 1 30); do [ "$(code "$B/.well-known/oauth-authorization-server")" = 200 ] && break; sleep 2; done

echo "Public listener (Funnel :443)"
check "OAuth metadata is served"                        200 "$(code "$B/.well-known/oauth-authorization-server")"
check "MCP without a token is refused"                  401 "$(code -X POST "$B/mcp")"
check "Portal API is not mounted publicly"              404 "$(code "$B/api/me")"
check "Portal UI is not mounted publicly"               404 "$(code "$B/index.html")"
check "Forged identity header gains nothing publicly"   404 "$(code -H 'Tailscale-User-Login: ethangruening@gmail.com' "$B/api/connections")"

echo "Hub loopback listeners (must be unreachable from the tailnet)"
check "Direct :3000 (portal) with forged identity"      000 "$(code -H 'Tailscale-User-Login: ethangruening@gmail.com' "http://$TS_IP:3000/api/me")"
check "Direct :3001 (public app)"                       000 "$(code "http://$TS_IP:3001/")"

echo "Tailscale serve config"
serve="$(docker exec worldsmith-ts-1 tailscale serve status 2>&1)"
check "Funnel only on :443"                             1 "$(grep -c '(Funnel on)' <<<"$serve")"
check ":8443 portal is tailnet only"                    1 "$(grep -c ':8443 (tailnet only)' <<<"$serve")"

echo "Secrets and exposure"
check "Hub container can't see PLAYIT_SECRET"           0 "$(docker exec worldsmith-hub-1 sh -c 'env | grep -c PLAYIT' 2>/dev/null)"
check "deploy/.env is gitignored"                       0 "$(git check-ignore -q deploy/.env; echo $?)"
ports="$(docker ps --format '{{.Ports}}' | tr ',' '\n' | grep -E '0\.0\.0\.0|\[::\]' | grep -c . )"
check "No container port published on all interfaces"  0 "$ports"

[ "$fail" = 0 ] && echo "All checks passed." || echo "Some checks FAILED."
exit "$fail"
