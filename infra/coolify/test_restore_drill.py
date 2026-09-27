"""Validate the pilot's restored inventory across the smoke-to-application handoff."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "restore_drill", Path(__file__).with_name("restore-drill.py")
)
restore_drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore_drill)


class InventoryTests(unittest.TestCase):
    def test_smoke_service_inventory_is_accepted(self):
        restore_drill.validate_inventory({
            "server_count": 3, "ssh_key_count": 3,
            "service_count": 1, "application_count": 0,
        })

    def test_application_replacing_smoke_service_is_accepted(self):
        restore_drill.validate_inventory({
            "server_count": 3, "ssh_key_count": 3,
            "service_count": 0, "application_count": 1,
        })

    def test_missing_pilot_inventory_is_rejected(self):
        cases = [
            {"server_count": 2, "ssh_key_count": 3, "service_count": 1, "application_count": 0},
            {"server_count": 3, "ssh_key_count": 2, "service_count": 0, "application_count": 1},
            {"server_count": 3, "ssh_key_count": 3, "service_count": 0, "application_count": 0},
        ]
        for inventory in cases:
            with self.subTest(inventory=inventory), self.assertRaises(RuntimeError):
                restore_drill.validate_inventory(inventory)


if __name__ == "__main__":
    unittest.main()
