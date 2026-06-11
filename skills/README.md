# Coverify Skills

This directory is the durable home for Coverify operational skills.
`manifest.json` is the source of truth for which skills are expected and what
minimum structure and behavioral guard phrases they must keep.

Use:

```bash
python3 scripts/link_skills.py
python3 scripts/check_skills.py
python3 scripts/link_skills.py --check
```

Adding or removing a skill requires:

1. create or delete `skills/coverify-*/SKILL.md`,
2. create or delete `skills/coverify-*/agents/openai.yaml`,
3. update `skills/manifest.json`,
4. run the checks above and the test suite.

Operational behavior belongs here.

Skill behavior should stay agentic when it involves judgment. Add Python only
for stable tool surfaces, audit recording, and mechanical validation of paths,
ranges, citations, schemas, and verifier results.
