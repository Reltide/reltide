#!/bin/sh
set -eu
address=$(hostname -i)
case "$address" in *' '*|''|*[!0-9.]*) echo 'Expected one private IPv4 container address' >&2; exit 1;; esac
sed "s/__CAPACITY_BROADCAST_ADDRESS__/$address/" /etc/capacity/temporal.yaml > /tmp/capacity-temporal.yaml
exec temporal-server --config-file /tmp/capacity-temporal.yaml --allow-no-auth start
