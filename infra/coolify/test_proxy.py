"""Exercise the pinned proxies locally, without touching application hosts.

Run with RELTIDE_PROXY_DOCKER_TEST=1; requires the local Docker daemon.
"""

import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("proxy_restore", ROOT / "restore-drill.py")
RESTORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESTORE)
DOCKER = []


def docker(*arguments):
    if not DOCKER:
        raise RuntimeError("The local Docker endpoint has not been verified")
    return subprocess.check_output(
        [*DOCKER, *arguments], text=True, stderr=subprocess.STDOUT,
        timeout=120,
    ).strip()


def compose_service(filename, name):
    configuration = json.loads(docker(
        "compose", "-f", str(ROOT / filename), "config", "--format", "json",
    ))
    return configuration["services"][name]


def request(port, host, path):
    query = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", headers={"Host": host},
    )
    try:
        with urllib.request.urlopen(query, timeout=2) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()


def await_status(port, host, path, expected):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if request(port, host, path)[0] == expected:
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise AssertionError(f"{host}{path} did not return {expected}")


@unittest.skipUnless(
    os.environ.get("RELTIDE_PROXY_DOCKER_TEST") == "1",
    "set RELTIDE_PROXY_DOCKER_TEST=1 to run isolated Docker routing checks",
)
class ProxyExposureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse the restore drill's local Unix-socket guard and pin the endpoint
        # before any container/network operation, including readiness/cleanup.
        DOCKER[:] = RESTORE.local_docker_command()

    def test_dashboard_is_unavailable_while_application_routing_works(self):
        application = compose_service("staging-smoke.compose.yml", "smoke")
        for role in ("production", "staging", "management"):
            with self.subTest(role=role):
                self.check_proxy(role, application["image"])

    def check_proxy(self, role, application_image):
        proxy = compose_service(f"{role}-proxy.compose.yml", "traefik")
        token = secrets.token_hex(6)
        network = f"reltide-proxy-test-{token}"
        proxy_name = f"reltide-proxy-{token}"
        app_name = f"reltide-app-{token}"
        app_host = f"app-{token}.test"
        containers = []
        docker("network", "create", network)
        try:
            with tempfile.TemporaryDirectory(prefix="reltide-proxy-") as directory:
                temporary = Path(directory)
                (temporary / "dynamic").mkdir()
                (temporary / "acme.json").touch(mode=0o600)
                app_labels = {
                    "reltide.proxy-test": token,
                    "traefik.enable": "true",
                    "traefik.http.routers.test-app.rule": f"Host(`{app_host}`)",
                    "traefik.http.routers.test-app.entrypoints": "http",
                    "traefik.http.services.test-app.loadbalancer.server.port": "8080",
                }
                labels = [
                    argument
                    for key, value in app_labels.items()
                    for argument in ("--label", f"{key}={value}")
                ]
                docker(
                    "run", "--detach", "--rm", "--name", app_name,
                    "--network", network, *labels, application_image,
                    "--port=8080",
                )
                containers.append(app_name)
                proxy_labels = [
                    argument
                    for key, value in proxy["labels"].items()
                    for argument in ("--label", f"{key}={value}")
                ]
                docker(
                    "run", "--detach", "--rm", "--name", proxy_name,
                    "--network", network, "--publish", "127.0.0.1::80",
                    "--volume", "/var/run/docker.sock:/var/run/docker.sock:ro",
                    "--volume", f"{directory}:/traefik",
                    "--label", f"reltide.proxy-test={token}",
                    *proxy_labels, proxy["image"], *proxy["command"],
                    f"--providers.docker.constraints=Label(`reltide.proxy-test`, `{token}`)",
                )
                containers.append(proxy_name)
                port = int(docker("port", proxy_name, "80/tcp").rsplit(":", 1)[1])
                await_status(port, proxy_name, "/ping", 200)
                # A real application route proves Docker discovery is active.
                await_status(port, app_host, "/", 200)
                for host in (proxy_name, "coolify-proxy", "traefik-coolify-proxy"):
                    for path in ("/dashboard/", "/api/http/routers", "/api/rawdata"):
                        self.assertEqual(
                            request(port, host, path)[0], 404,
                            f"{role}: exposed {path} to Host {host}",
                        )
        finally:
            for container in reversed(containers):
                docker("rm", "--force", container)
            docker("network", "rm", network)


if __name__ == "__main__":
    unittest.main()
