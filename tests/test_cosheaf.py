import unittest

from autoprover.context import load_context
from autoprover.cosheaf import CosheafConfig, CosheafError, normalize_api_url


class CosheafTests(unittest.TestCase):
    def test_normalize_api_url(self) -> None:
        self.assertEqual(normalize_api_url("http://x:3030"), "http://x:3030/api/v1")
        self.assertEqual(normalize_api_url("http://x:3030/api/v1/"), "http://x:3030/api/v1")

    def test_config_requires_workspace_and_token(self) -> None:
        with self.assertRaises(CosheafError):
            CosheafConfig.from_env(url="http://x", workspace="", token="t")
        with self.assertRaises(CosheafError):
            CosheafConfig.from_env(url="http://x", workspace="w", token="")

    def test_load_context_tolerates_search_failure(self) -> None:
        class Client:
            def search(self, query: str, statuses=None, doc_types=None, limit=None):
                raise CosheafError("bad fts query")

        self.assertEqual(load_context(Client(), "x.y", 3), [])

    def test_load_context_requests_filtered_search(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.args = None

            def search(self, query: str, statuses=None, doc_types=None, limit=None):
                self.args = (query, statuses, doc_types, limit)
                return []

        client = Client()
        self.assertEqual(load_context(client, "compactness", 5), [])
        self.assertEqual(client.args, ("compactness", ["golden", "unreviewed", "draft"], None, 5))


if __name__ == "__main__":
    unittest.main()
