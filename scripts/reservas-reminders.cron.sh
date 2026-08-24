#!/bin/bash
set -euo pipefail

PATH=/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin:~/bin
export PATH

CRON_FILE=/www/server/cron/25659316984a4c6c7cb4736f72d9f0b2
echo $$ > "${CRON_FILE}.pl"

APP=/www/wwwroot/auth.allsender.tech
ENV_FILE="$APP/.env"

env_value() {
  local key="$1"
  local value=""
  if [ -f "$ENV_FILE" ]; then
    value=$(grep "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
  fi
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

CRON_TOKEN="$(env_value RESERVAS_REMINDERS_CRON_TOKEN)"
if [ -z "$CRON_TOKEN" ]; then
  CRON_TOKEN="$(env_value CRON_SECRET)"
fi

curl --fail --silent --show-error \
  -H "x-cron-token: ${CRON_TOKEN}" \
  "https://auth.allsender.tech/api/cron/reservas/reminders" >/dev/null

unset CRON_TOKEN
echo "----------------------------------------------------------------------------"
endDate=$(date +"%Y-%m-%d %H:%M:%S")
echo "★[$endDate] Successful"
echo "----------------------------------------------------------------------------"
if [[ "${1:-}" != "start" ]] && command -v btpython >/dev/null 2>&1; then
  btpython /www/server/panel/script/log_task_analyzer.py "${CRON_FILE}.log" || true
fi
rm -f "${CRON_FILE}.pl"
