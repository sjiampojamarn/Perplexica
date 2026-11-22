#!/bin/sh
set -e

if [ -z "$SEARXNG_SECRET" ]; then
  echo "SEARXNG_SECRET must be set" >&2
  exit 1
fi

python - <<'PY'
import os

with open('/etc/searxng/settings.yml.template', encoding='utf-8') as src:
    content = src.read()

content = content.replace('${SEARXNG_SECRET}', os.environ['SEARXNG_SECRET'])

with open('/etc/searxng/settings.yml', 'w', encoding='utf-8') as dst:
    dst.write(content)
os.chmod('/etc/searxng/settings.yml', 0o600)
PY
chown searxng:searxng /etc/searxng/settings.yml

echo "Starting SearXNG..."

sudo -H -u searxng bash -c "cd /usr/local/searxng/searxng-src && export SEARXNG_SETTINGS_PATH='/etc/searxng/settings.yml' && export FLASK_APP=searx/webapp.py && /usr/local/searxng/searx-pyenv/bin/python -m flask run --host=0.0.0.0 --port=8080" &
SEARXNG_PID=$!

echo "Waiting for SearXNG to be ready..."
sleep 5

COUNTER=0
MAX_TRIES=30
until curl -s http://localhost:8080 > /dev/null 2>&1; do
  COUNTER=$((COUNTER+1))
  if [ $COUNTER -ge $MAX_TRIES ]; then
    echo "Warning: SearXNG health check timeout, but continuing..."
    break
  fi
  sleep 1
done

if curl -s http://localhost:8080 > /dev/null 2>&1; then
  echo "SearXNG started successfully (PID: $SEARXNG_PID)"
else
  echo "SearXNG may not be fully ready, but continuing (PID: $SEARXNG_PID)"
fi

cd /home/vane
echo "Starting Vane..."

exec node server.js