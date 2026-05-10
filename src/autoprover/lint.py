from __future__ import annotations


class LintError(RuntimeError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def strip_frontmatter_for_lint(content: str) -> tuple[str, list[str]]:
    if not content.startswith("---\n"):
        return content, []
    end = content.find("\n---\n", 4)
    if end == -1:
        return content, ["frontmatter is opened but not closed"]
    errors: list[str] = []
    frontmatter = content[4:end]
    for line_number, line in enumerate(frontmatter.splitlines(), start=2):
        stripped = line.strip()
        if stripped and ":" not in stripped:
            errors.append(f"frontmatter line {line_number} is not a key/value entry")
    return content[end + len("\n---\n") :], errors


def lint_coflat_body(content: str) -> list[str]:
    body, errors = strip_frontmatter_for_lint(content)
    if not body.strip():
        errors.append("body is empty")
    h1_count = sum(1 for line in body.splitlines() if line.startswith("# "))
    if h1_count != 1:
        errors.append(f"expected exactly one H1 heading, found {h1_count}")
    if "```" in body:
        errors.append("triple-backtick code fences are not allowed in Coflat math documents")
    return errors


def require_valid_coflat(content: str, enabled: bool = True) -> None:
    if not enabled:
        return
    errors = lint_coflat_body(content)
    if errors:
        raise LintError(errors)
