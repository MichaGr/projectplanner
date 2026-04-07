from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..core.errors import ServiceError
from ..integrations.notion_client import NotionClient
from ..schemas.notion import NotionDatabaseSchemaResponse, NotionProgressEntry
from ..schemas.planner import AIDocument, AIContext, PlannerSnapshot

MAX_CONTEXT_RESULTS = 3
MAX_CONTEXT_CHARS = 4000
NOTION_SCAN_BATCH_SIZE = 25
NOTION_SCAN_PAGE_LIMIT = 100
NOTION_FIRST_PASS_LIMIT = 8
NOTION_MAX_BLOCK_DEPTH = 3
NOTION_MAX_BLOCKS = 80
NOTION_MAX_BLOCK_TEXT = 6000
NOTION_MIN_SCORE = 8
PROGRESS_FIELD_TYPES = {
    "titleField": "title",
    "projectNameField": "rich_text",
    "syncedAtField": "date",
    "changedCountField": "number",
    "completedCountField": "number",
    "scopeField": "rich_text",
}
NOTES_FIELD_TYPES = {
    "titleField": {"title"},
    "summaryField": {"rich_text"},
    "statusField": {"status", "select"},
    "tagsField": {"multi_select"},
    "scopeField": {"rich_text", "select", "multi_select"},
}
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "i", "if", "in", "into", "is",
    "it", "my", "of", "on", "or", "so", "that", "the", "their", "this", "to", "up", "use", "want", "what", "when", "with",
}
SHORT_WHITELIST = {"ai", "api", "ux", "ui", "qa", "db"}
TEXT_BLOCK_TYPES = {
    "paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "heading_1", "heading_2", "heading_3",
    "quote", "callout",
}


@dataclass
class NotionSearchContext:
    raw_query: str
    phrase_terms: list[str]
    priority_terms: list[str]
    support_terms: list[str]
    scope_terms: list[str]


@dataclass
class NotionCandidate:
    page_id: str
    title: str
    property_text: str
    lightweight_text: str
    status: str
    last_edited_time: str | None
    score: int = 0
    full_text: str = ""
    match_reasons: list[str] | None = None


def _normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _plain_text_from_rich_text(items: list[dict[str, Any]]) -> str:
    return "".join(item.get("plain_text", "") for item in items)


def _extract_database_title(payload: dict[str, Any]) -> str:
    title_items = payload.get("title", [])
    if isinstance(title_items, list):
        text = _plain_text_from_rich_text(title_items).strip()
        return text or "Untitled database"
    return "Untitled database"


def resolve_data_source(client: NotionClient, identifier: str) -> tuple[str, dict[str, Any]]:
    try:
        payload = client.retrieve_data_source(identifier)
        return str(payload.get("id") or identifier), payload
    except RuntimeError:
        database_payload = client.retrieve_database(identifier)
        data_sources = database_payload.get("data_sources", [])
        if not data_sources:
            raise RuntimeError("The selected Notion database does not expose any queryable data sources.")
        first_data_source_id = data_sources[0].get("id")
        if not first_data_source_id:
            raise RuntimeError("Could not resolve the Notion data source for this database.")
        payload = client.retrieve_data_source(str(first_data_source_id))
        return str(payload.get("id") or first_data_source_id), payload


def get_database_schema(client: NotionClient, database_id: str) -> dict[str, Any]:
    data_source_id, payload = resolve_data_source(client, database_id)
    properties = payload.get("properties", {})
    return {
        "databaseId": database_id,
        "dataSourceId": data_source_id,
        "title": _extract_database_title(payload),
        "properties": [
            {"id": property_payload.get("id", name), "name": name, "type": property_payload.get("type", "unknown")}
            for name, property_payload in properties.items()
        ],
    }


def _infer_progress_field_map(schema: dict[str, Any]) -> dict[str, str | None]:
    properties = schema.get("properties", [])
    inferred: dict[str, str | None] = {field: None for field in PROGRESS_FIELD_TYPES}
    type_matches: dict[str, list[str]] = {}
    name_preferences = {
        "titleField": {"name", "title"},
        "projectNameField": {"projectname", "project"},
        "syncedAtField": {"syncedat", "syncat", "date", "timestamp"},
        "changedCountField": {"changedcount", "changes", "countchanged"},
        "completedCountField": {"completedcount", "donecount", "completed"},
        "scopeField": {"scope", "context"},
    }
    for property_item in properties:
        type_matches.setdefault(property_item["type"], []).append(property_item["name"])

    for field, expected_type in PROGRESS_FIELD_TYPES.items():
        for property_item in properties:
            if property_item["type"] != expected_type:
                continue
            normalized_name = _normalize_key(property_item["name"])
            if normalized_name in name_preferences[field]:
                inferred[field] = property_item["name"]
                break
        if inferred[field] is None and len(type_matches.get(expected_type, [])) == 1:
            inferred[field] = type_matches[expected_type][0]
    return inferred


def _infer_notes_field_map(schema: dict[str, Any]) -> dict[str, str | None]:
    properties = schema.get("properties", [])
    inferred: dict[str, str | None] = {field: None for field in NOTES_FIELD_TYPES}
    for property_item in properties:
        normalized_name = _normalize_key(property_item["name"])
        property_type = property_item["type"]
        if property_type == "title" and inferred["titleField"] is None:
            inferred["titleField"] = property_item["name"]
        elif property_type == "rich_text" and inferred["summaryField"] is None and normalized_name in {"summary", "notes", "content", "description"}:
            inferred["summaryField"] = property_item["name"]
        elif property_type in {"status", "select"} and inferred["statusField"] is None and normalized_name in {"status", "state"}:
            inferred["statusField"] = property_item["name"]
        elif property_type == "multi_select" and inferred["tagsField"] is None and normalized_name in {"tags", "labels"}:
            inferred["tagsField"] = property_item["name"]
        elif property_type in {"rich_text", "select", "multi_select"} and inferred["scopeField"] is None and normalized_name in {"scope", "area", "project", "context"}:
            inferred["scopeField"] = property_item["name"]
    return inferred


def validate_progress_database(
    client: NotionClient,
    database_id: str,
    progress_field_map: dict[str, str | None] | None = None,
) -> tuple[dict[str, str | None], dict[str, Any]]:
    schema = get_database_schema(client, database_id)
    properties_by_name = {item["name"]: item for item in schema["properties"]}
    field_map = {**_infer_progress_field_map(schema), **(progress_field_map or {})}

    missing: list[str] = []
    mismatched: list[str] = []
    unresolved: list[str] = []
    for field, expected_type in PROGRESS_FIELD_TYPES.items():
        selected_name = field_map.get(field)
        if not selected_name:
            unresolved.append(field)
            continue
        property_item = properties_by_name.get(selected_name)
        if not property_item:
            missing.append(selected_name)
            continue
        if property_item["type"] != expected_type:
            mismatched.append(f"{selected_name} ({property_item['type']}, expected {expected_type})")

    if missing or mismatched or unresolved:
        problems = []
        if unresolved:
            problems.append("unmapped: " + ", ".join(unresolved))
        if missing:
            problems.append("missing: " + ", ".join(missing))
        if mismatched:
            problems.append("wrong types: " + ", ".join(mismatched))
        raise RuntimeError("Progress database schema is invalid: " + "; ".join(problems))

    return field_map, schema


def validate_notes_database_schema(
    client: NotionClient,
    database_id: str,
    notes_field_map: dict[str, str | None] | None = None,
) -> tuple[dict[str, str | None], dict[str, Any]]:
    schema = get_database_schema(client, database_id)
    properties_by_name = {item["name"]: item for item in schema["properties"]}
    field_map = {**_infer_notes_field_map(schema), **(notes_field_map or {})}

    selected_title = field_map.get("titleField")
    if not selected_title:
        raise RuntimeError("Notes database schema is invalid: unmapped: titleField")
    title_property = properties_by_name.get(selected_title)
    if not title_property:
        raise RuntimeError(f"Notes database schema is invalid: missing: {selected_title}")
    if title_property["type"] != "title":
        raise RuntimeError(f"Notes database schema is invalid: wrong types: {selected_title} ({title_property['type']}, expected title)")

    for field, allowed_types in NOTES_FIELD_TYPES.items():
        if field == "titleField":
            continue
        selected_name = field_map.get(field)
        if not selected_name:
            continue
        property_item = properties_by_name.get(selected_name)
        if not property_item:
            raise RuntimeError(f"Notes database schema is invalid: missing: {selected_name}")
        if property_item["type"] not in allowed_types:
            expected = ", ".join(sorted(allowed_types))
            raise RuntimeError(
                f"Notes database schema is invalid: wrong types: {selected_name} ({property_item['type']}, expected one of {expected})"
            )
    return field_map, schema


def _extract_title(properties: dict[str, Any]) -> str:
    for value in properties.values():
        if value.get("type") == "title":
            return _plain_text_from_rich_text(value.get("title", []))
    return "Untitled"


def _extract_rich_text(properties: dict[str, Any], allowed_names: set[str] | None = None) -> str:
    chunks: list[str] = []
    for name, value in properties.items():
        if allowed_names is not None and name not in allowed_names:
            continue
        value_type = value.get("type")
        if value_type == "rich_text":
            chunks.append(_plain_text_from_rich_text(value.get("rich_text", [])))
        elif value_type == "title":
            chunks.append(_plain_text_from_rich_text(value.get("title", [])))
        elif value_type == "select":
            option_name = value.get("select", {}).get("name")
            if option_name:
                chunks.append(str(option_name))
        elif value_type == "multi_select":
            chunks.extend(option.get("name", "") for option in value.get("multi_select", []) if option.get("name"))
    return " ".join(chunk.strip() for chunk in chunks if chunk.strip())


def _block_to_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    if not block_type:
        return ""
    payload = block.get(block_type, {})
    if block_type in TEXT_BLOCK_TYPES:
        rich_text = payload.get("rich_text")
        if isinstance(rich_text, list):
            return _plain_text_from_rich_text(rich_text).strip()
    return ""


def _normalize_text(value: str) -> str:
    return " ".join(value.split()).strip()


def _tokenize_terms(value: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9][a-z0-9._/-]*", value.lower())
    results: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if len(token) < 3 and token not in SHORT_WHITELIST:
            continue
        if token in STOPWORDS:
            continue
        if token not in seen:
            seen.add(token)
            results.append(token)
    return results


def _extract_phrase_terms(message: str) -> list[str]:
    quoted = [match.strip().lower() for match in re.findall(r'"([^"]+)"', message) if match.strip()]
    if quoted:
        return quoted[:6]
    phrases = re.findall(r"\b[a-z0-9][a-z0-9/-]*(?:\s+[a-z0-9][a-z0-9/-]*){1,3}\b", message.lower())
    cleaned: list[str] = []
    for phrase in phrases:
        normalized = _normalize_text(phrase)
        words = normalized.split()
        if len(words) < 2:
            continue
        if all(word in STOPWORDS for word in words):
            continue
        if normalized not in cleaned:
            cleaned.append(normalized)
    return cleaned[:6]


def _find_selected_node(snapshot: PlannerSnapshot, target_id: str | None) -> Any | None:
    if not target_id:
        return None
    return next((node for node in snapshot.nodes if node.id == target_id), None)


def _find_scope_title(snapshot: PlannerSnapshot, scope_id: str | None) -> str:
    if not scope_id:
        return snapshot.root.title
    return next((node.title for node in snapshot.nodes if node.id == scope_id), snapshot.root.title)


def _build_search_context(message: str, context: AIContext, snapshot: PlannerSnapshot) -> NotionSearchContext:
    selected_node = _find_selected_node(snapshot, context.targetId)
    phrase_terms = _extract_phrase_terms(message)
    priority_terms = _tokenize_terms(" ".join([context.targetTitle, message]))[:12]
    support_parts = []
    if selected_node:
        support_parts.extend([selected_node.description, selected_node.completionCriteria])
    support_terms = _tokenize_terms(" ".join(support_parts))[:12]
    scope_terms = _tokenize_terms(_find_scope_title(snapshot, context.scopeId))[:6]
    return NotionSearchContext(
        raw_query=message.strip(),
        phrase_terms=phrase_terms,
        priority_terms=priority_terms,
        support_terms=support_terms,
        scope_terms=scope_terms,
    )


def _extract_status(properties: dict[str, Any]) -> str:
    for value in properties.values():
        value_type = value.get("type")
        if value_type == "status":
            return str(value.get("status", {}).get("name") or "")
        if value_type == "select":
            return str(value.get("select", {}).get("name") or "")
    return ""


def _extract_property_value(properties: dict[str, Any], property_name: str | None) -> str:
    if not property_name:
        return ""
    value = properties.get(property_name)
    if not value:
        return ""
    value_type = value.get("type")
    if value_type == "title":
        return _plain_text_from_rich_text(value.get("title", []))
    if value_type == "rich_text":
        return _plain_text_from_rich_text(value.get("rich_text", []))
    if value_type == "select":
        return str(value.get("select", {}).get("name") or "")
    if value_type == "status":
        return str(value.get("status", {}).get("name") or "")
    if value_type == "multi_select":
        return " ".join(option.get("name", "") for option in value.get("multi_select", []) if option.get("name"))
    return ""


def _match_count(text: str, terms: list[str]) -> int:
    return sum(1 for term in terms if term and term in text)


def _score_candidate(candidate: NotionCandidate, search: NotionSearchContext, *, include_full_text: bool) -> tuple[int, list[str]]:
    reasons: list[str] = []
    title_text = candidate.title.lower()
    property_text = candidate.property_text.lower()
    body_text = (candidate.full_text if include_full_text else candidate.lightweight_text).lower()
    score = 0

    for phrase in search.phrase_terms:
        if phrase in title_text:
            score += 12
            reasons.append(f'title phrase "{phrase}"')
        elif phrase in property_text:
            score += 8
            reasons.append(f'property phrase "{phrase}"')
        elif phrase in body_text:
            score += 6
            reasons.append(f'body phrase "{phrase}"')

    title_matches = min(_match_count(title_text, search.priority_terms), 3)
    if title_matches:
        score += title_matches * 5
        reasons.append("priority title match")
    property_matches = min(_match_count(property_text, search.priority_terms + search.support_terms), 4)
    if property_matches:
        score += property_matches * 3
        reasons.append("property term overlap")
    body_matches = min(_match_count(body_text, search.priority_terms + search.support_terms), 5)
    if body_matches:
        score += body_matches * 2
        reasons.append("body term overlap")
    scope_matches = min(_match_count(f"{title_text} {property_text} {body_text}", search.scope_terms), 2)
    if scope_matches:
        score += scope_matches * 2
        reasons.append("scope match")

    categories = sum([
        int(bool(search.phrase_terms and any(phrase in title_text or phrase in property_text or phrase in body_text for phrase in search.phrase_terms))),
        int(title_matches > 0),
        int(property_matches > 0),
        int(body_matches > 0),
    ])
    if categories >= 2:
        score += 4
        reasons.append("multi-signal relevance")

    context_title = next((term for term in search.priority_terms if " " not in term and term in title_text), None)
    if context_title:
        reasons.append(f'context term "{context_title}"')

    status = candidate.status.lower()
    if status in {"archived", "archive"}:
        score -= 8
    elif status in {"draft"}:
        score -= 2

    if candidate.last_edited_time:
        try:
            updated_at = datetime.fromisoformat(candidate.last_edited_time.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - updated_at).days
            if age_days <= 14:
                score += 3
            elif age_days <= 30:
                score += 1
        except ValueError:
            pass

    if not candidate.title.strip() and not candidate.property_text.strip() and not body_text.strip():
        score -= 4

    strong_match = bool(search.phrase_terms and any(phrase in title_text or phrase in property_text or phrase in body_text for phrase in search.phrase_terms))
    if not strong_match and _match_count(f"{title_text} {property_text} {body_text}", search.priority_terms) == 0:
        score = min(score, 0)

    return score, reasons


def _extract_page_search_text(result: dict[str, Any], notes_field_map: dict[str, str | None] | None = None) -> NotionCandidate:
    properties = result.get("properties", {})
    if notes_field_map:
        title = _normalize_text(_extract_property_value(properties, notes_field_map.get("titleField")) or _extract_title(properties))
        property_chunks = [
            _extract_property_value(properties, notes_field_map.get("summaryField")),
            _extract_property_value(properties, notes_field_map.get("scopeField")),
            _extract_property_value(properties, notes_field_map.get("tagsField")),
        ]
        status = _extract_property_value(properties, notes_field_map.get("statusField")) or _extract_status(properties)
        property_text = _normalize_text(" ".join(chunk for chunk in property_chunks if chunk))
    else:
        title = _normalize_text(_extract_title(properties))
        property_text = _normalize_text(_extract_rich_text(properties))
        status = _extract_status(properties)
    return NotionCandidate(
        page_id=result["id"],
        title=title,
        property_text=property_text,
        lightweight_text="",
        status=status,
        last_edited_time=result.get("last_edited_time"),
    )


def _query_candidate_pages(client: NotionClient, database_id: str, notes_field_map: dict[str, str | None] | None = None) -> list[NotionCandidate]:
    data_source_id, _ = resolve_data_source(client, database_id)
    candidates: list[NotionCandidate] = []
    cursor: str | None = None
    scanned = 0
    while scanned < NOTION_SCAN_PAGE_LIMIT:
        payload = client.query_data_source(
            data_source_id,
            page_size=min(NOTION_SCAN_BATCH_SIZE, NOTION_SCAN_PAGE_LIMIT - scanned),
            start_cursor=cursor,
        )
        results = payload.get("results", [])
        if not results:
            break
        for result in results:
            candidates.append(_extract_page_search_text(result, notes_field_map))
        scanned += len(results)
        cursor = payload.get("next_cursor")
        if not payload.get("has_more") or not cursor:
            break
    return candidates


def _retrieve_blocks_recursive(
    client: NotionClient,
    block_id: str,
    *,
    depth: int = 0,
    max_depth: int = NOTION_MAX_BLOCK_DEPTH,
    limit: int = NOTION_MAX_BLOCKS,
) -> list[str]:
    if depth > max_depth or limit <= 0:
        return []

    payload = client.retrieve_block_children(block_id, page_size=min(50, limit))
    texts: list[str] = []
    remaining = limit
    for block in payload.get("results", []):
        if remaining <= 0:
            break
        text = _block_to_text(block)
        if text:
            texts.append(text)
            remaining -= 1
        if block.get("has_children") and depth < max_depth and remaining > 0:
            child_texts = _retrieve_blocks_recursive(client, block["id"], depth=depth + 1, max_depth=max_depth, limit=remaining)
            texts.extend(child_texts)
            remaining -= len(child_texts)
    return texts


def _build_document_content(candidate: NotionCandidate, reasons: list[str]) -> tuple[str, str]:
    content_sections = [f"Title: {candidate.title}", f"Why relevant: {', '.join(reasons[:3]) or 'matched current planner context'}"]
    if candidate.property_text:
        content_sections.append(f"Properties: {candidate.property_text[:300]}")
    if candidate.full_text:
        content_sections.append(f"Content:\n{candidate.full_text[:MAX_CONTEXT_CHARS]}")
    content = "\n".join(content_sections)
    excerpt_source = _normalize_text(candidate.full_text or candidate.property_text or candidate.title)
    return excerpt_source[:500], content[:MAX_CONTEXT_CHARS]


def fetch_context_documents(
    client: NotionClient,
    *,
    database_id: str,
    message: str,
    context: AIContext,
    snapshot: PlannerSnapshot,
    notes_field_map: dict[str, str | None] | None = None,
) -> list[AIDocument]:
    search = _build_search_context(message, context, snapshot)
    active_notes_field_map, _ = validate_notes_database_schema(client, database_id, notes_field_map)
    candidates = _query_candidate_pages(client, database_id, active_notes_field_map)

    first_pass: list[NotionCandidate] = []
    for candidate in candidates:
        score, reasons = _score_candidate(candidate, search, include_full_text=False)
        candidate.score = score
        candidate.match_reasons = reasons
        if score >= 6:
            first_pass.append(candidate)

    first_pass.sort(key=lambda item: item.score, reverse=True)
    shortlisted = first_pass[:NOTION_FIRST_PASS_LIMIT]

    reranked: list[NotionCandidate] = []
    for candidate in shortlisted:
        block_text = _normalize_text("\n".join(_retrieve_blocks_recursive(client, candidate.page_id, limit=NOTION_MAX_BLOCKS)))[:NOTION_MAX_BLOCK_TEXT]
        candidate.full_text = block_text
        score, reasons = _score_candidate(candidate, search, include_full_text=True)
        candidate.score = score
        candidate.match_reasons = reasons
        if score >= NOTION_MIN_SCORE:
            reranked.append(candidate)

    reranked.sort(key=lambda item: item.score, reverse=True)

    documents: list[AIDocument] = []
    for candidate in reranked[:MAX_CONTEXT_RESULTS]:
        excerpt, content = _build_document_content(candidate, candidate.match_reasons or [])
        documents.append(
            AIDocument(
                id=f"notion-{candidate.page_id[:8]}",
                name=f"Notion: {candidate.title}",
                pageCount=1,
                excerpt=excerpt,
                content=content,
            )
        )
    return documents


def build_progress_summary(
    entries: list[NotionProgressEntry],
    context: AIContext,
    project: PlannerSnapshot,
    progress_field_map: dict[str, str | None],
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    now = datetime.now(timezone.utc)
    changed_count = len(entries)
    completed_count = sum(1 for entry in entries if entry.completed)
    project_name = project.root.title or "ProjectPlanner Project"
    scope = context.targetTitle if context.targetType != "root" else project.root.title
    title = f"{project_name} - Session Sync - {now.strftime('%Y-%m-%d %H:%M')}"

    summary = f"{changed_count} planner changes captured for {scope}."
    completed_lines = [f"- {entry.title}" for entry in entries if entry.completed][:10]
    changed_lines = [f"- {entry.title}: {entry.detail}" if entry.detail else f"- {entry.title}" for entry in entries[:20]]
    body_lines = [
        f"Summary: {summary}",
        f"Current focus: {scope}",
        "",
        "Changed items:",
        *(changed_lines or ["- No tracked changes were captured."]),
        "",
        "Completed items:",
        *(completed_lines or ["- No items were marked complete in this session."]),
        "",
        "Next steps:",
        "- Review the current graph and continue from the active scope.",
    ]
    children = [
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": [{"type": "text", "text": {"content": line}}]},
        }
        for line in body_lines
        if line
    ]
    properties = {
        str(progress_field_map["titleField"]): {"title": [{"type": "text", "text": {"content": title[:200]}}]},
        str(progress_field_map["projectNameField"]): {"rich_text": [{"type": "text", "text": {"content": project_name[:200]}}]},
        str(progress_field_map["syncedAtField"]): {"date": {"start": now.isoformat()}},
        str(progress_field_map["changedCountField"]): {"number": changed_count},
        str(progress_field_map["completedCountField"]): {"number": completed_count},
        str(progress_field_map["scopeField"]): {"rich_text": [{"type": "text", "text": {"content": scope[:200]}}]},
    }
    return title, children, properties


class NotionService:
    def get_database_schema(self, token: str, database_id: str) -> NotionDatabaseSchemaResponse:
        try:
            schema = get_database_schema(NotionClient(token), database_id)
        except RuntimeError as error:
            raise ServiceError(400, str(error)) from error
        return NotionDatabaseSchemaResponse.model_validate(schema)

    def validate_notes_settings(
        self,
        token: str,
        database_id: str,
        notes_field_map: dict[str, str | None],
    ) -> tuple[dict[str, str | None], dict[str, Any]]:
        return validate_notes_database_schema(NotionClient(token), database_id, notes_field_map)

    def validate_progress_settings(
        self,
        token: str,
        database_id: str,
        progress_field_map: dict[str, str | None],
    ) -> tuple[dict[str, str | None], dict[str, Any]]:
        return validate_progress_database(NotionClient(token), database_id, progress_field_map)

    def fetch_context_documents(
        self,
        *,
        token: str,
        database_id: str,
        message: str,
        context: AIContext,
        snapshot: PlannerSnapshot,
        notes_field_map: dict[str, str | None],
    ) -> list[AIDocument]:
        try:
            return fetch_context_documents(
                NotionClient(token),
                database_id=database_id,
                message=message,
                context=context,
                snapshot=snapshot,
                notes_field_map=notes_field_map,
            )
        except RuntimeError as error:
            raise ServiceError(502, f"Notion context lookup failed: {error}") from error

    def sync_progress(
        self,
        *,
        token: str,
        database_id: str,
        progress_field_map: dict[str, str | None],
        entries: list[NotionProgressEntry],
        context: AIContext,
        project: PlannerSnapshot,
    ) -> dict[str, str | int]:
        try:
            client = NotionClient(token)
            resolved_map, progress_schema = validate_progress_database(client, database_id, progress_field_map)
            title, children, properties = build_progress_summary(entries, context, project, resolved_map)
            client.create_page(parent_database_id=str(progress_schema["dataSourceId"]), properties=properties, children=children)
        except RuntimeError as error:
            raise ServiceError(502, f"Notion progress sync failed: {error}") from error
        return {"title": title, "syncedEntries": len(entries)}
