from __future__ import annotations

import re
import unittest

from contract_support import require_symbols


class JobTokenContractTests(unittest.TestCase):
    MODULE = "extreme_worker.security"

    def _hasher(self):
        hasher_type, = require_symbols(self, self.MODULE, "JobTokenHasher")
        return hasher_type()

    def test_issued_token_is_opaque_urlsafe_and_high_entropy_length(self) -> None:
        hasher = self._hasher()
        token = hasher.issue()
        self.assertGreaterEqual(len(token), 43)
        self.assertRegex(token, re.compile(r"^[A-Za-z0-9_-]+$"))
        self.assertNotIn("job", token.lower())
        self.assertNotIn("@", token)

    def test_hash_verifies_only_the_matching_token(self) -> None:
        hasher = self._hasher()
        token = hasher.issue()
        encoded_hash = hasher.hash(token)
        self.assertTrue(hasher.verify(token, encoded_hash))
        self.assertFalse(hasher.verify(hasher.issue(), encoded_hash))
        self.assertNotIn(token, encoded_hash)

    def test_hashes_are_salted(self) -> None:
        hasher = self._hasher()
        token = hasher.issue()
        self.assertNotEqual(hasher.hash(token), hasher.hash(token))

    def test_blank_or_malformed_tokens_fail_closed(self) -> None:
        hasher = self._hasher()
        encoded_hash = hasher.hash(hasher.issue())
        for malformed in ("", " ", "not+urlsafe", "tiny"):
            with self.subTest(malformed=malformed):
                self.assertFalse(hasher.verify(malformed, encoded_hash))


if __name__ == "__main__":
    unittest.main()
