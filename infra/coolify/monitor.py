#!/usr/bin/env python3
"""Host monitoring independent of Coolify's scheduler and database."""

import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import urllib.request


def send(config, subject, message):
    body = json.dumps({
        "from": config["from"], "to": [config["to"]],
        "subject": config.get("subject_prefix", "") + subject, "text": message,
    }).encode()
    request = urllib.request.Request(
        "https://api.resend.com/emails", data=body,
        headers={"Authorization": "Bearer " + config["token"],
                 "Content-Type": "application/json", "User-Agent": "reltide-monitor/1"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    print(json.dumps({"subject": subject, "email_id": result["id"]}))


def save_state(path, state):
    temporary = path.with_suffix(".new")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


def process_checks(config, checks, path, now, host):
    state = json.loads(path.read_text()) if path.exists() else {}
    for name, (bad, _, _) in checks.items():
        previous = state.get(name, {"count": 0, "alerted": False, "sent": 0})
        previous["count"] = previous["count"] + 1 if bad else 0
        state[name] = previous
    failures = []
    state_writable = True
    # Preserve detector progress, but unavailable storage must not silence alerts.
    try:
        save_state(path, state)
    except OSError as error:
        state_writable = False
        failures.append({"check": "state", "error": type(error).__name__})
    attempted = set()
    for name, (bad, description, required) in checks.items():
        previous = state[name]
        alert = bad and (not state_writable or (
            previous["count"] >= required and (
                not previous["alerted"] or now.timestamp() - previous["sent"] >= 86400
            )
        ))
        recovery = not bad and previous["alerted"]
        if not (alert or recovery):
            continue
        status = "ALERT" if alert else "RECOVERED"
        attempted.add(name)
        try:
            send(config, f"[{status}] Reltide {host}: {name}", description)
        except Exception as error:
            # Do not log response bodies or credentials. Retry on the next tick.
            failures.append({"check": name, "error": type(error).__name__})
            continue
        previous.update(alerted=bool(alert), sent=now.timestamp())
        if state_writable:
            try:
                save_state(path, state)
            except OSError as error:
                state_writable = False
                failures.append({"check": "state", "error": type(error).__name__})
    if not state_writable:
        # A late write failure also invalidates earlier checks' threshold tracking.
        for name, (bad, description, _) in checks.items():
            if not bad or name in attempted:
                continue
            try:
                send(config, f"[ALERT] Reltide {host}: {name}", description)
            except Exception as error:
                failures.append({"check": name, "error": type(error).__name__})
    return failures


def main():
    config = json.loads(Path("/etc/reltide/alerts.json").read_text())
    host = socket.gethostname()
    if sys.argv[1:] == ["--test"]:
        send(config, "[TEST] Reltide resource and availability monitoring",
             f"Test from {host}. Resource thresholds: disk 80%, memory 85%, "
             "one-minute load 1.5 per CPU. Three consecutive checks trigger a resource alert. "
             "The production host also checks the controller every five minutes. "
             "This test does not indicate an outage.")
        return
    if sys.argv[1:]:
        raise SystemExit("Usage: reltide-monitor [--test]")

    now = datetime.datetime.now(datetime.timezone.utc)
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.strip().split()[0])
    disk = shutil.disk_usage("/")
    disk_percent = 100 * disk.used / disk.total
    memory_percent = 100 * (1 - memory["MemAvailable"] / memory["MemTotal"])
    load = os.getloadavg()[0]
    checks = {
        "disk": (disk_percent >= 80, f"Root filesystem {disk_percent:.1f}% used", 3),
        "memory": (memory_percent >= 85, f"Memory {memory_percent:.1f}% used", 3),
        "load": (load >= 1.5 * (os.cpu_count() or 1), f"One-minute load {load:.2f}", 3),
    }
    if config.get("controller_health_url"):
        try:
            with urllib.request.urlopen(config["controller_health_url"], timeout=10) as response:
                healthy = response.status == 200 and response.read(32).strip() == b"OK"
        except Exception:
            healthy = False
        checks["controller"] = (not healthy, f"Controller health from production: {'healthy' if healthy else 'unavailable'}", 2)
    if config.get("check_controller_backup"):
        try:
            backup = json.loads(Path("/var/lib/reltide-controller-backup/last-success.json").read_text())
            age = (now - datetime.datetime.fromisoformat(backup["completed_at"])).total_seconds()
            stale = age > 26 * 3600
        except (OSError, ValueError, KeyError, TypeError):
            stale = True
        checks["backup"] = (stale, f"Verified off-server controller backup within 26 hours: {not stale}", 1)

    directory = Path("/run/reltide-monitor")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        failures = process_checks(config, checks, directory / "state.json", now, host)
    print(json.dumps({"host": host, "checks": {k: {"bad": v[0], "detail": v[1]} for k, v in checks.items()}}))
    if failures:
        print(json.dumps({"delivery_failures": failures}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
