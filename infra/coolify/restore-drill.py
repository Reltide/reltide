#!/usr/bin/env python3
"""Validate an extracted controller backup without starting workers or contacting hosts.

Usage: restore-drill.py EXTRACTED_BACKUP PRIVATE_ADMINISTRATOR_JSON
Requires local Docker. The caller verifies/downloads/decrypts the archive first.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

DOCKER = []


def local_docker_command():
    # Pin the endpoint once: never send recovery secrets to an inherited
    # remote Docker context, including during readiness checks or cleanup.
    context = json.loads(subprocess.check_output(["docker", "context", "inspect"]))[0]
    endpoint = context["Endpoints"]["docker"]["Host"]
    if os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"):
        endpoint = os.environ["DOCKER_HOST"]
    if not endpoint.startswith("unix://") or not Path(endpoint[7:]).is_socket():
        raise RuntimeError("The recovery drill requires a local Docker Unix socket")
    return ["docker", "--host", endpoint]


def docker(*args, **kwargs):
    return subprocess.run([*DOCKER, *args], check=True, **kwargs)


def validate_inventory(result):
    # This is the current three-server pilot acceptance profile.
    # Coolify tracks Docker-image applications separately from compose services.
    if (result["server_count"] != 3 or result["ssh_key_count"] < 3
            or result["service_count"] + result["application_count"] < 1):
        raise RuntimeError("Expected controller inventory is missing")


def main():
    DOCKER.extend(local_docker_command())
    backup, administrator = (Path(arg).resolve() for arg in sys.argv[1:])
    os.umask(0o077)
    prefix = "reltide-restore-" + uuid.uuid4().hex[:10]
    network, database, redis = prefix + "-net", prefix + "-db", prefix + "-redis"
    images = {}
    for line in (backup / "images.txt").read_text().splitlines():
        name, reference, _ = line.split()
        images[name.lstrip("/")] = reference
    if any("@sha256:" not in images[name] for name in ("coolify", "coolify-db", "coolify-redis")):
        raise RuntimeError("Restore requires the recorded digest-pinned images")
    environment = backup / "data/coolify/source/.env"
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
        values = {}
        for line in environment.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value.strip("\"'")
        db_env = Path(temporary) / "postgres.env"
        db_env.write_text("\n".join([
            "POSTGRES_USER=" + values["DB_USERNAME"],
            "POSTGRES_PASSWORD=" + values["DB_PASSWORD"],
            "POSTGRES_DB=" + values.get("DB_DATABASE", "coolify"),
        ]) + "\n")
        docker("network", "create", "--internal", "--opt",
               "com.docker.network.bridge.gateway_mode_ipv4=isolated", network, stdout=subprocess.DEVNULL)
        try:
            docker("run", "--detach", "--name", database, "--network", network,
                   "--env-file", str(db_env), images["coolify-db"], stdout=subprocess.DEVNULL)
            for _ in range(60):
                ready = subprocess.run([*DOCKER, "exec", database, "pg_isready", "-U",
                                        values["DB_USERNAME"]], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Recovery database did not become ready")
            with (backup / "coolify.dmp").open("rb") as dump:
                docker("exec", "-i", database, "pg_restore", "--exit-on-error", "--no-owner",
                       "-U", values["DB_USERNAME"], "-d", values.get("DB_DATABASE", "coolify"), stdin=dump)
            docker("run", "--detach", "--name", redis, "--network", network,
                   "--env-file", str(environment), "--entrypoint", "sh", images["coolify-redis"],
                   "-c", 'exec redis-server --save "" --appendonly no --requirepass "$REDIS_PASSWORD"',
                   stdout=subprocess.DEVNULL)
            # Only bootstrap PHP for database/cryptographic checks. No supervisor,
            # scheduler, queue, Docker socket, SSH mounts, published ports or egress.
            php = r'''
require "vendor/autoload.php";
$app = require "bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$admin = json_decode(file_get_contents('/tmp/administrator.json'), true);
$user = App\Models\User::where('email', $admin['email'])->firstOrFail();
$keys = App\Models\PrivateKey::all();
$result = [
    'admin_password_valid' => Illuminate\Support\Facades\Hash::check($admin['password'], $user->password),
    'two_factor_confirmed' => !is_null($user->two_factor_confirmed_at),
    'two_factor_secret_decrypted' => strlen(decrypt($user->two_factor_secret)) > 0,
    'ssh_keys_decrypted' => $keys->every(fn($key) => str_contains($key->private_key, 'PRIVATE KEY')),
    'ssh_key_count' => $keys->count(),
    'server_count' => App\Models\Server::count(),
    'service_count' => App\Models\Service::count(),
    'application_count' => App\Models\Application::count(),
];
foreach (['admin_password_valid','two_factor_confirmed','two_factor_secret_decrypted','ssh_keys_decrypted'] as $check) {
    if (!$result[$check]) { throw new RuntimeException($check.' failed'); }
}
echo json_encode($result).PHP_EOL;
'''
            restored = docker("run", "--rm", "--no-healthcheck", "--name", prefix + "-app", "--network", network,
                   "--env-file", str(environment), "--env", "DB_HOST=" + database,
                   "--env", "REDIS_HOST=" + redis,
                   "--env", "CACHE_STORE=array", "--env", "CACHE_DRIVER=array",
                   "--env", "SESSION_DRIVER=array", "--env", "QUEUE_CONNECTION=sync",
                   "--mount", f"type=bind,source={administrator},target=/tmp/administrator.json,readonly",
                   "--entrypoint", "php", images["coolify"], "-r", php,
                   capture_output=True, text=True)
            inventory = json.loads(restored.stdout)
            validate_inventory(inventory)
            print(json.dumps(inventory))
            docker("run", "--detach", "--rm", "--no-healthcheck", "--name", prefix + "-app", "--network", network,
                   "--env-file", str(environment), "--env", "DB_HOST=" + database,
                   "--env", "REDIS_HOST=" + redis,
                   "--env", "CACHE_STORE=array", "--env", "CACHE_DRIVER=array",
                   "--env", "SESSION_DRIVER=array", "--entrypoint", "php", images["coolify"],
                   "artisan", "serve", "--host=127.0.0.1", "--port=8080", stdout=subprocess.DEVNULL)
            for _ in range(30):
                probe = subprocess.run([*DOCKER, "exec", prefix + "-app", "php", "-r",
                    '$h=@file_get_contents("http://127.0.0.1:8080/login",false,stream_context_create(["http"=>["timeout"=>3]])); '
                    'exit($h !== false && str_contains($h,"Email") && str_contains($h,"Password") ? 0 : 1);'],
                    capture_output=True, timeout=5)
                if probe.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Restored login page did not serve correctly")
            print(json.dumps({"restored_login_http": "passed"}))
            print(json.dumps({"restore_seconds": round(time.monotonic() - started, 2),
                              "isolation": "internal Docker network; no workers or host connections"}))
        finally:
            for name in (prefix + "-app", redis, database):
                subprocess.run([*DOCKER, "rm", "--force", "--volumes", name], capture_output=True)
            docker("network", "rm", network, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
