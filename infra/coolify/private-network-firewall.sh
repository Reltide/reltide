#!/usr/bin/env bash
set -euo pipefail
umask 077

# Hetzner Cloud Firewalls do not filter private-network traffic.
role=$(cat /etc/reltide/host-role)
case "$role" in
  management|staging|production) ;;
  *) echo "Unknown Reltide host role" >&2; exit 1 ;;
esac

exec 9>/run/reltide-private-firewall.lock
flock -x 9
rules=$(mktemp)
trap 'rm -f -- "$rules"' EXIT
echo '*filter' > "$rules"
# Even --noflush clears a declared user chain. Only create DOCKER-USER
# when absent; leave Docker/operator entries and our existing jump intact.
iptables -w -S DOCKER-USER >/dev/null 2>&1 ||
  echo ':DOCKER-USER - [0:0]' >> "$rules"
cat >> "$rules" <<'RULES'
:RELTIDE-PRIVATE-IN - [0:0]
:RELTIDE-PRIVATE-DOCKER - [0:0]
-F RELTIDE-PRIVATE-IN
-F RELTIDE-PRIVATE-DOCKER
-A RELTIDE-PRIVATE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A RELTIDE-PRIVATE-IN -p icmp -j ACCEPT
RULES
if [[ "$role" != management ]]; then
  echo '-A RELTIDE-PRIVATE-IN -s 172.30.0.2/32 -p tcp --dport 22 -j ACCEPT' >> "$rules"
fi
echo '-A RELTIDE-PRIVATE-IN -j DROP' >> "$rules"
iptables -w -C INPUT -s 172.30.0.0/24 -j RELTIDE-PRIVATE-IN 2>/dev/null ||
  echo '-I INPUT 1 -s 172.30.0.0/24 -j RELTIDE-PRIVATE-IN' >> "$rules"

echo '-A RELTIDE-PRIVATE-DOCKER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' >> "$rules"
if [[ "$role" == management ]]; then
  for source in 172.30.0.3/32 172.30.0.4/32; do
    echo "-A RELTIDE-PRIVATE-DOCKER -s $source -p tcp -m conntrack --ctorigdst 172.30.0.2 --ctorigdstport 9800 -j ACCEPT" >> "$rules"
  done
fi
echo '-A RELTIDE-PRIVATE-DOCKER -j DROP' >> "$rules"
iptables -w -C DOCKER-USER -s 172.30.0.0/24 -j RELTIDE-PRIVATE-DOCKER 2>/dev/null ||
  echo '-I DOCKER-USER 1 -s 172.30.0.0/24 -j RELTIDE-PRIVATE-DOCKER' >> "$rules"
echo COMMIT >> "$rules"
# Commit the filter changes atomically; never expose an empty active chain.
iptables-restore --wait 10 --noflush --test < "$rules"
iptables-restore --wait 10 --noflush < "$rules"
