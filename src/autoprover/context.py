from __future__ import annotations

from .cosheaf import CosheafClient, CosheafError
from .prompts import ContextDoc


def strip_frontmatter(content: str) -> str:
    if not content.startswith("---\n"):
        return content
    end = content.find("\n---\n", 4)
    if end == -1:
        return content
    return content[end + len("\n---\n") :]


def context_from_doc(client: CosheafClient, doc_id: str) -> ContextDoc:
    doc = client.get_document(doc_id)
    path = str(doc["path"])
    note = client.get_note(path)
    return ContextDoc(
        doc_id=doc_id,
        path=path,
        title=str(doc.get("title") or path),
        doc_type=str(doc.get("type", "")),
        status=str(doc.get("status", "")),
        content=truncate_content(strip_frontmatter(str(note.get("content", "")))),
    )


def context_from_result(client: CosheafClient, result: dict[str, object]) -> ContextDoc:
    doc_id = str(result["doc_id"])
    doc = context_from_doc(client, doc_id)
    title = str(result.get("title") or doc.title)
    return ContextDoc(doc.doc_id, doc.path, title, doc.doc_type, doc.status, doc.content)


def context_sort_key(doc: ContextDoc) -> tuple[int, int, str]:
    status_rank = {"golden": 0, "unreviewed": 1, "draft": 2, "rejected": 3, "archived": 4}
    type_rank = {"page": 0, "review": 1, "proposal": 2}
    return (status_rank.get(doc.status, 9), type_rank.get(doc.doc_type, 9), doc.path)


def load_context(client: CosheafClient, query: str, limit: int) -> list[ContextDoc]:
    try:
        results = client.search(query)
    except CosheafError:
        return []
    docs: list[ContextDoc] = []
    for result in results:
        try:
            docs.append(context_from_result(client, result))
        except CosheafError:
            continue
    return sorted(docs, key=context_sort_key)[: max(0, limit)]


def truncate_content(content: str, max_chars: int = 6000) -> str:
    if len(content) <= max_chars:
        return content
    return content[:max_chars].rstrip() + "\n\n[context truncated]"
