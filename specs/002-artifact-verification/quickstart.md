# Quickstart: Artifact Verification

Run the v1 smoke flow:

```bash
PYTHONPATH=src python -m unittest discover -s tests
STORE="$(mktemp -d)"
PYTHONPATH=src python -m autoprover init "$STORE"
PYTHONPATH=src python -m autoprover benchmark coin-fpt "$STORE"
PYTHONPATH=src python -m autoprover search "$STORE" coin --mode exploration
PYTHONPATH=src python -m autoprover status "$STORE" coin-net-formulation
```

Expected result:
- the store has `drafts/`, `artifacts/`, `reviews/`, and `golden/`;
- the coin benchmark creates one reusable net-formulation artifact;
- rejected or unsure proof directions are visible as exploration records;
- golden search does not show these artifacts unless a golden document is created separately.
