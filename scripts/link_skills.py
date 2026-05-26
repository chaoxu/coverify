#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from json import loads
from pathlib import Path


def default_codex_skill_dir() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def skill_names(skills_root: Path) -> list[str]:
    manifest = loads((skills_root / "manifest.json").read_text(encoding="utf-8"))
    return [item["name"] for item in manifest["skills"]]


def stale_autoprover_links(dest_root: Path, expected: set[str]) -> list[str]:
    if not dest_root.exists():
        return []
    stale: list[str] = []
    for path in dest_root.iterdir():
        if path.name.startswith("autoprover-") and path.name not in expected:
            stale.append(f"stale Autoprover skill in discovery dir: {path}")
    return stale


def ensure_link(source: Path, dest: Path, *, check: bool) -> list[str]:
    problems: list[str] = []
    if not source.is_dir():
        return [f"missing source skill {source}"]
    if dest.is_symlink():
        target = dest.resolve()
        if target != source.resolve():
            problems.append(f"{dest} points to {target}, expected {source}")
        return problems
    if dest.exists():
        return [f"{dest} exists and is not a symlink"]
    if check:
        return [f"{dest} is not linked"]
    dest.symlink_to(source, target_is_directory=True)
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Link repo-owned Autoprover skills into Codex skill discovery.")
    parser.add_argument("--skills-dir", type=Path, default=repo_root() / "skills")
    parser.add_argument("--codex-skills-dir", type=Path, default=default_codex_skill_dir())
    parser.add_argument("--check", action="store_true", help="verify links without creating them")
    args = parser.parse_args(argv[1:])

    problems: list[str] = []
    names = skill_names(args.skills_dir)
    if args.check and not args.codex_skills_dir.exists():
        problems.append(f"{args.codex_skills_dir} does not exist")
    if not args.check:
        args.codex_skills_dir.mkdir(parents=True, exist_ok=True)

    problems.extend(stale_autoprover_links(args.codex_skills_dir, set(names)))
    for name in names:
        source = (args.skills_dir / name).resolve()
        dest = args.codex_skills_dir / name
        problems.extend(ensure_link(source, dest, check=args.check))

    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        return 1
    action = "verified" if args.check else "linked"
    print(f"{action} {len(names)} Autoprover skills in {args.codex_skills_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
