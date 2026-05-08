# CLI Contract: Artifact Verification

## Commands

```text
python -m autoprover init STORE
python -m autoprover draft STORE ID --title TITLE --type TYPE [--body TEXT] [--body-file PATH] [--source ID]
python -m autoprover submit STORE ID
python -m autoprover review STORE ARTIFACT_ID --verifier ID --verdict approve|reject|unsure --summary TEXT [--reusable TEXT]
python -m autoprover status STORE ARTIFACT_ID
python -m autoprover search STORE QUERY [--mode exploration|golden|mixed]
python -m autoprover benchmark coin-fpt STORE
python -m autoprover worker-explore STORE ID --backend codex|claude|gemini --prompt TEXT --title TITLE --type TYPE [--model MODEL]
python -m autoprover worker-verify STORE ARTIFACT_ID --backend codex|claude|gemini [--verifier ID] [--model MODEL]
python -m autoprover codex-explore STORE ID --prompt TEXT --title TITLE --type TYPE [--model MODEL]
python -m autoprover codex-verify STORE ARTIFACT_ID [--verifier ID] [--model MODEL]
```

## Behavior

- `submit` copies a draft into submitted artifacts and refuses to overwrite an existing submitted artifact.
- `review` writes a new review document and never edits the artifact.
- `status` derives status from review documents.
- `search --mode golden` searches only `golden/`.
- `search --mode exploration` searches artifacts and reviews with status labels.
- `benchmark coin-fpt` creates the initial coin-denomination exploration artifacts and reviews.
- `worker-explore` calls the selected CLI backend in YOLO mode, captures the final response, and stores it as a draft artifact.
- `worker-verify` calls the selected CLI backend in YOLO mode, parses a JSON verifier response, and stores it as a review document.
- `codex-explore` and `codex-verify` are compatibility aliases for the Codex backend.
