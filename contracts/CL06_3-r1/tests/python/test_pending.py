"""Reports verifier/service cases as PENDING. They are NEVER counted as passed: no verifier or service exists."""
import json, os, unittest
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
class Pending(unittest.TestCase):
    def test_pending_inventory(self):
        cases = json.load(open(os.path.join(ROOT, "fixtures/adversarial/cases.v3.json")))["cases"]
        pend = [c for c in cases if c["status"] == "PENDING_IMPLEMENTATION"]
        self.assertEqual(len(pend), 20)
        for c in pend: self.assertTrue(c["layer"] in ("verifier", "service"))
        for c in pend:
            if c["id"] in ("P5", "P6"): self.assertIn("regression_of", c)
if __name__ == "__main__": unittest.main()
