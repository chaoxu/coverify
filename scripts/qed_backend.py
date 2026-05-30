#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def read_prompt() -> str:
    prompt = sys.stdin.read().strip()
    if not prompt:
        raise SystemExit("qed backend requires a non-empty prompt on stdin")
    return prompt


def problem_tex(prompt: str) -> str:
    if "\\begin{problem}" in prompt:
        return prompt if prompt.endswith("\n") else prompt + "\n"
    return "\n".join(
        [
            "\\begin{problem}",
            prompt,
            "\\end{problem}",
            "",
        ],
    )


def collect_first_existing(paths: list[Path]) -> tuple[Path | None, str]:
    for path in paths:
        if path.exists():
            return path, path.read_text(encoding="utf-8", errors="replace").strip()
    return None, ""


def find_failure_analysis(output_dir: Path) -> tuple[Path | None, str]:
    candidates = sorted(output_dir.glob("decomposition/**/failure_analysis.md"))
    if not candidates:
        candidates = sorted(output_dir.glob("**/failure_analysis.md"))
    return collect_first_existing(candidates)


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n[truncated]"


def digest_output(output_dir: Path, returncode: int, limit: int) -> str:
    proof_path, proof = collect_first_existing([output_dir / "proof.md"])
    summary_path, summary = collect_first_existing([output_dir / "proof_effort_summary.md"])
    status_path, status = collect_first_existing(
        [
            output_dir / "decomposition" / "STATUS.md",
            output_dir / "related_info" / "difficulty_evaluation.md",
        ],
    )
    failure_path, failure = find_failure_analysis(output_dir)

    if proof:
        qed_status = "SUCCESS"
    elif returncode == 0:
        qed_status = "NO_PROOF"
    else:
        qed_status = "FAILED"

    lines = [
        f"QED_STATUS: {qed_status}",
        f"QED_RETURNCODE: {returncode}",
        f"QED_OUTPUT_DIR: {output_dir}",
    ]
    for label, path in (
        ("QED_PROOF", proof_path),
        ("QED_SUMMARY", summary_path),
        ("QED_STATUS_FILE", status_path),
        ("QED_FAILURE_ANALYSIS", failure_path),
    ):
        if path is not None:
            lines.append(f"{label}: {path}")

    if proof:
        lines.extend(["", "# QED Proof", "", truncate(proof, limit)])
    if summary:
        lines.extend(["", "# QED Proof Effort Summary", "", truncate(summary, limit)])
    if failure:
        lines.extend(["", "# QED Failure Analysis", "", truncate(failure, limit)])
    if status and not proof:
        lines.extend(["", "# QED Status", "", truncate(status, limit)])

    return "\n".join(lines).rstrip() + "\n"


def run_qed(args: argparse.Namespace, prompt: str) -> str:
    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    problem_path = workdir / "problem.tex"
    output_dir = workdir / "qed_output"
    stdout_path = workdir / "qed_stdout.log"
    stderr_path = workdir / "qed_stderr.log"
    problem_path.write_text(problem_tex(prompt), encoding="utf-8")

    if args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "proof.md").write_text(
            "Dry-run QED proof placeholder.\n\nThe adapter wrote problem.tex and skipped QED execution.\n",
            encoding="utf-8",
        )
        return digest_output(output_dir, 0, args.digest_chars)

    qed_root = Path(args.qed_root or os.environ.get("QED_ROOT", "")).expanduser()
    if not qed_root:
        raise SystemExit("provide --qed-root or QED_ROOT")
    qed_root = qed_root.resolve()
    run_sh = qed_root / "run.sh"
    requested_config = Path(args.config).expanduser().resolve() if args.config else qed_root / "config.yaml"
    config = requested_config
    if not run_sh.exists():
        raise SystemExit(f"QED run.sh not found: {run_sh}")
    if not requested_config.exists():
        raise SystemExit(f"QED config not found: {requested_config}")
    if shutil.which("conda") is None:
        raise SystemExit("QED run.sh requires conda on PATH")

    temp_config: Path | None = None
    if requested_config.parent != qed_root:
        # QED smoke_test.py resolves prompts/ and skill/ relative to the config
        # directory, so external per-workspace configs must be copied to the
        # QED root before invoking upstream run.sh.
        temp_config = qed_root / f".coverify-config-{os.getpid()}.yaml"
        shutil.copy2(requested_config, temp_config)
        config = temp_config

    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
            process = subprocess.run(
                ["bash", str(run_sh), str(problem_path), str(output_dir), str(config)],
                cwd=qed_root,
                stdout=stdout_file,
                stderr=stderr_file,
                text=True,
                timeout=args.timeout if args.timeout > 0 else None,
                check=False,
            )
    finally:
        if temp_config is not None:
            temp_config.unlink(missing_ok=True)
    return digest_output(output_dir, process.returncode, args.digest_chars)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coverify script backend adapter for proofQED/QED")
    parser.add_argument("--qed-root", default="", help="path to a proofQED/QED checkout; defaults to QED_ROOT")
    parser.add_argument("--config", default="", help="QED config.yaml path; defaults to <qed-root>/config.yaml")
    parser.add_argument("--workdir", default=".", help="adapter working directory; defaults to the backend artifact dir")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("COVERIFY_QED_TIMEOUT_SECONDS", "0") or "0"))
    parser.add_argument("--digest-chars", type=int, default=12000)
    parser.add_argument("--dry-run", action="store_true", help="write problem.tex and a placeholder proof without running QED")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    print(run_qed(args, read_prompt()), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
