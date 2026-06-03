from __future__ import annotations

RESOLUTION_OUTPUT_TYPES = (
    "proof",
    "disproof",
    "counterexample",
    "construction",
    "witness",
    "bound",
    "certificate",
    "reduction",
    "obstruction",
    "precise gap",
)


def comma_or(items: tuple[str, ...]) -> str:
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} or {items[1]}"
    return ", ".join(items[:-1]) + f", or {items[-1]}"


RESOLUTION_OUTPUT_TYPE_LIST = comma_or(RESOLUTION_OUTPUT_TYPES)
