#!/usr/bin/env bash
# One command to run the whole platform locally for manual testing (synthetic data only).
# Usage: scripts/demo_up.sh [up|down]     Env: PORT_WEB=8080 PORT_API=8000 ELO_PLAYWRIGHT_DIR=... ELO_CHROME=...
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; PORT_WEB="${PORT_WEB:-8080}"; PORT_API="${PORT_API:-8000}"; RUN="${TMPDIR:-/tmp}/elo-demo"
PY="${PYTHON:-python3}"
if [ "${1:-up}" = "down" ]; then
  for f in api gw; do [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true; done; echo "parado"; exit 0
fi
# stop a previous run (pid files) before starting; refuse to start on busy ports instead of silently using an old server
for f in api gw; do [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true; done
sleep 1
for port in "$PORT_API" "$PORT_WEB"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "A porta $port já está em uso por outro processo. Pare-o ou use PORT_WEB/PORT_API."; exit 1; fi
done
rm -rf "$RUN"; mkdir -p "$RUN/data"
PYTHONPATH="$ROOT/api/src" ELO_DATA_DIR="$RUN/data" ELO_V3_DATA_ORIGIN=synthetic_fixture \
ELO_V3_THERAPIST_SEEDS='[{"therapist_id":"t_localdemo01","username":"terapeuta_demo","password":"senha-sintetica-demo","org_id":"o_localdemo01","display_label":"Terapeuta Sintético Demo"}]' \
  nohup "$PY" -m uvicorn --factory elo.api:app_factory --host 127.0.0.1 --port "$PORT_API" >"$RUN/api.log" 2>&1 &
echo $! >"$RUN/api.pid"
nohup node scripts/gateway.mjs "$ROOT" "$PORT_WEB" "$PORT_API" >"$RUN/gw.log" 2>&1 &
echo $! >"$RUN/gw.pid"
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT_WEB/api/v3/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT_WEB/api/v3/health" >/dev/null || { echo "API não subiu. Veja $RUN/api.log"; exit 1; }
ORIGIN="http://127.0.0.1:$PORT_WEB"
echo "Plataforma no ar. Login da terapeuta: terapeuta_demo / senha-sintetica-demo"
echo "  Landing:      $ORIGIN/"
echo "  Terapeuta:    $ORIGIN/v3/painel.html"
echo "  Participante: $ORIGIN/v3/participant.html"
echo "  Contador:     $ORIGIN/s2/contador.html"
if [ -n "${ELO_PLAYWRIGHT_DIR:-}" ]; then
  echo "Criando o caso demonstrativo (5 sessões)…"
  node web/tests/browser/seed_demo.mjs --origin "$ORIGIN" | tee "$RUN/seed.json"
  echo "Abra: $ORIGIN/v3/painel.html?participant=<participant_id acima>"
else
  echo "Para criar o caso demonstrativo, defina ELO_PLAYWRIGHT_DIR e rode de novo (ou siga docs/UAT.md, caso UAT-00)."
fi
echo "Para parar: scripts/demo_up.sh down"
