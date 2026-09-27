"""Exercise alert persistence, retries, recovery, and consecutive-check thresholds."""

import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import monitor


class MonitoringTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.json"
        self.now = datetime.datetime(2026, 9, 27, tzinfo=datetime.timezone.utc)

    def run_checks(self, checks):
        return monitor.process_checks({}, checks, self.path, self.now, "test-host")

    def test_consecutive_threshold_and_recovery(self):
        with patch.object(monitor, "send") as send:
            self.run_checks({"disk": (True, "high", 3)})
            self.run_checks({"disk": (True, "high", 3)})
            self.run_checks({"disk": (False, "normal", 3)})
            self.run_checks({"disk": (True, "high", 3)})
            self.run_checks({"disk": (True, "high", 3)})
            send.assert_not_called()
            self.run_checks({"disk": (True, "high", 3)})
            self.run_checks({"disk": (True, "high", 3)})
            self.assertEqual(send.call_count, 1)
            self.run_checks({"disk": (False, "normal", 3)})
            self.run_checks({"disk": (False, "normal", 3)})
            self.assertEqual(send.call_count, 2)
            self.assertIn("[RECOVERED]", send.call_args.args[1])

    def test_partial_delivery_failure_preserves_success_and_other_detectors(self):
        checks = {name: (True, "bad", 1) for name in ("disk", "memory", "controller")}
        with patch.object(monitor, "send", side_effect=[None, TimeoutError(), None]) as send:
            failures = self.run_checks(checks)
            self.assertEqual(send.call_count, 3)
        self.assertEqual(failures, [{"check": "memory", "error": "TimeoutError"}])
        saved = json.loads(self.path.read_text())
        self.assertTrue(saved["disk"]["alerted"])
        self.assertTrue(saved["controller"]["alerted"])
        self.assertFalse(saved["memory"]["alerted"])
        with patch.object(monitor, "send") as send:
            self.assertEqual(self.run_checks(checks), [])
            send.assert_called_once()
            self.assertIn("memory", send.call_args.args[1])

    def test_failed_recovery_retries_and_daily_alerts_do_not_spam(self):
        with patch.object(monitor, "send") as send:
            self.run_checks({"controller": (True, "down", 1)})
            self.now += datetime.timedelta(hours=23)
            self.run_checks({"controller": (True, "down", 1)})
            self.assertEqual(send.call_count, 1)
            self.now += datetime.timedelta(hours=1)
            self.run_checks({"controller": (True, "down", 1)})
            self.assertEqual(send.call_count, 2)
        with patch.object(monitor, "send", side_effect=TimeoutError()):
            self.assertTrue(self.run_checks({"controller": (False, "up", 1)}))
        with patch.object(monitor, "send") as send:
            self.run_checks({"controller": (False, "up", 1)})
            send.assert_called_once()
            self.assertIn("[RECOVERED]", send.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
