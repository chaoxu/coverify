#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from json import loads
from pathlib import Path


MANIFEST = "manifest.json"
LEGACY_SKILL_PREFIX = "auto" + "prover-"


@dataclass(frozen=True)
class SkillCheck:
    name: str
    ok: bool
    problems: list[str]


@dataclass(frozen=True)
class SkillSpec:
    name: str
    required_sections: list[str]
    must_contain: list[str]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    parts = text.split("---\n", 2)
    if len(parts) < 3:
        return {}
    data: dict[str, str] = {}
    for line in parts[1].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data


def parse_openai_yaml(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "interface:":
        return {}
    data: dict[str, str] = {}
    for line in lines[1:]:
        match = re.match(r"  ([a-z_]+):\s*\"(.*)\"\s*$", line)
        if match:
            data[match.group(1)] = match.group(2)
        elif line.strip():
            data["_invalid"] = line
    return data


def load_manifest(root: Path) -> list[SkillSpec]:
    manifest_path = root / MANIFEST
    payload = loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1:
        raise ValueError("unsupported skills manifest schema_version")
    specs = []
    seen: set[str] = set()
    for item in payload.get("skills", []):
        name = item["name"]
        if name in seen:
            raise ValueError(f"duplicate skill in manifest: {name}")
        seen.add(name)
        specs.append(
            SkillSpec(
                name=name,
                required_sections=list(item.get("required_sections", [])),
                must_contain=list(item.get("must_contain", [])),
            ),
        )
    if not specs:
        raise ValueError("skills manifest has no skills")
    return specs


def check_skill(root: Path, spec: SkillSpec) -> SkillCheck:
    problems: list[str] = []
    name = spec.name
    skill_dir = root / name
    skill_md = skill_dir / "SKILL.md"
    openai_yaml = skill_dir / "agents" / "openai.yaml"

    if not skill_dir.is_dir():
        return SkillCheck(name, False, [f"missing directory {skill_dir}"])
    if not skill_md.is_file():
        return SkillCheck(name, False, ["missing SKILL.md"])

    text = skill_md.read_text(encoding="utf-8")
    frontmatter = parse_frontmatter(text)
    if frontmatter.get("name") != name:
        problems.append("frontmatter name mismatch")
    description = frontmatter.get("description", "")
    if len(description) < 80:
        problems.append("description is too short to trigger reliably")
    if "TODO" in text:
        problems.append("contains TODO")
    if len(text.splitlines()) > 140:
        problems.append("SKILL.md is too long; move detail into references")
    for heading in spec.required_sections:
        pattern = rf"(?m)^## {re.escape(heading)}\s*$"
        if re.search(pattern, text) is None:
            problems.append(f"missing section: {heading}")
    for phrase in spec.must_contain:
        if phrase not in text:
            problems.append(f"missing behavioral phrase: {phrase}")

    if not openai_yaml.is_file():
        problems.append("missing agents/openai.yaml")
    else:
        ui = parse_openai_yaml(openai_yaml.read_text(encoding="utf-8"))
        if "_invalid" in ui:
            problems.append(f"invalid agents/openai.yaml line: {ui['_invalid']}")
        if not ui.get("display_name"):
            problems.append("missing display_name")
        short = ui.get("short_description", "")
        if not (25 <= len(short) <= 64):
            problems.append("short_description must be 25-64 characters")
        if f"${name}" not in ui.get("default_prompt", ""):
            problems.append("default_prompt must mention the skill name")

    return SkillCheck(name, not problems, problems)


def check_repository(root: Path, specs: list[SkillSpec]) -> SkillCheck:
    expected = {spec.name for spec in specs}
    problems: list[str] = []
    for skill_dir in root.iterdir():
        if not skill_dir.is_dir():
            continue
        if not (skill_dir / "SKILL.md").exists():
            continue
        if skill_dir.name.startswith(LEGACY_SKILL_PREFIX):
            problems.append(f"legacy pre-Coverify skill directory: {skill_dir.name}")
        if skill_dir.name.startswith("coverify-") and skill_dir.name not in expected:
            problems.append(f"unmanifested skill directory: {skill_dir.name}")
    return SkillCheck("skills-root", not problems, problems)


def check_all(root: Path, specs: list[SkillSpec] | None = None) -> list[SkillCheck]:
    if specs is None:
        specs = load_manifest(root)
    return [check_skill(root, spec) for spec in specs]


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else repo_root() / "skills"
    specs = load_manifest(root)
    checks = check_all(root, specs)
    repository_check = check_repository(root, specs)
    passed = sum(1 for check in checks if check.ok)
    total = len(checks)
    print(f"skill completeness: {passed}/{total}")
    for check in checks:
        status = "OK" if check.ok else "FAIL"
        print(f"{status} {check.name}")
        for problem in check.problems:
            print(f"  - {problem}")
    if not repository_check.ok:
        print(f"FAIL {repository_check.name}")
        for problem in repository_check.problems:
            print(f"  - {problem}")
    return 0 if passed == total and repository_check.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
