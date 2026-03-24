import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from lib.config import GL_MCP_TOKEN, GL_MCP_URL


TABLE_ALIASES = {
    "users": "legacy_users",
}

LEGACY_ID_COLLECTIONS = {
    "legacy_users",
    "trusted_devices",
    "categories",
    "clients",
    "bookmarks",
    "events",
    "memos",
    "user_preferences",
    "teams",
}

DATE_ONLY_FIELDS = {
    "created_at",
    "updated_at",
    "last_used",
    "start_date",
    "end_date",
    "recurrence_end",
    "last_contact_at",
    "next_action_at",
    "incorporation_registry_date",
    "hidden_local_at",
    "last_synced_at",
}

TIMESTAMP_FIELDS = {
    "created_at",
    "updated_at",
    "last_used",
    "hidden_local_at",
    "last_synced_at",
}

RELATION_PATTERN = re.compile(r"(\w+)\(([^)]*)\)")
LIST_HEADER_PATTERN = re.compile(r"페이지\s+(\d+)/(\d+)\s+\(총\s+(\d+)건\)")
ROW_HEADER_PATTERN = re.compile(r"^\[(\d+)\]\s+id:\s+(.+)$")
FIELD_PATTERN = re.compile(r"^\s{2}([^:]+):\s+(.*)$")

_client = None


class QueryResult:
    def __init__(self, data):
        self.data = data


class GlMcpClient:
    def __init__(self, url: str, token: str):
        self.url = url
        self.token = token
        self.session_id: Optional[str] = None
        self._initialized = False
        self._cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
        self._cache_ttl = 2.0

    def table(self, name: str):
        return GlQueryBuilder(self, name)

    def _request(self, payload: Dict[str, Any], use_session: bool = True) -> Dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if use_session and self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        response = httpx.post(self.url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        session_id = response.headers.get("Mcp-Session-Id")
        if session_id:
            self.session_id = session_id
        body = response.text or ""
        if not body.strip():
            return {}
        return _parse_sse_json(body)

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self._request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "linkflow-web", "version": "1.0"},
                },
            },
            use_session=False,
        )
        self._request(
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            use_session=True,
        )
        self._initialized = True

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> str:
        self._ensure_initialized()
        payload = {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000) % 1_000_000_000,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        parsed = self._request(payload, use_session=True)
        if "error" in parsed:
            raise RuntimeError(str(parsed["error"]))
        content = parsed.get("result", {}).get("content", [])
        return "\n".join(
            item.get("text", "")
            for item in content
            if item.get("type") == "text" and item.get("text")
        )

    def resolve_collection(self, table_name: str) -> str:
        return TABLE_ALIASES.get(table_name, table_name)

    def uses_legacy_id(self, table_name: str) -> bool:
        return self.resolve_collection(table_name) in LEGACY_ID_COLLECTIONS

    def invalidate(self, table_name: str) -> None:
        self._cache.pop(self.resolve_collection(table_name), None)

    def list_all_records(self, table_name: str) -> List[Dict[str, Any]]:
        collection = self.resolve_collection(table_name)
        cached = self._cache.get(collection)
        now = time.monotonic()
        if cached and now - cached[0] < self._cache_ttl:
            return [dict(item) for item in cached[1]]

        page = 1
        per_page = 200
        total_pages = 1
        rows: List[Dict[str, Any]] = []
        while page <= total_pages:
            text = self.call_tool(
                "list_records",
                {
                    "collection": collection,
                    "page": page,
                    "perPage": per_page,
                    "sort": "id",
                },
            )
            parsed_rows, total_pages, _total_count = _parse_list_records_text(text)
            rows.extend(parsed_rows)
            if not parsed_rows and page == 1:
                break
            page += 1

        self._cache[collection] = (now, rows)
        return [dict(item) for item in rows]

    def create_record(self, table_name: str, data: Dict[str, Any]) -> Dict[str, Any]:
        collection = self.resolve_collection(table_name)
        text = self.call_tool("create_record", {"collection": collection, "data": data})
        self.invalidate(table_name)
        return _parse_single_record_text(text)

    def update_record(self, table_name: str, record_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        collection = self.resolve_collection(table_name)
        text = self.call_tool(
            "update_record",
            {"collection": collection, "id": record_id, "data": data},
        )
        self.invalidate(table_name)
        return _parse_single_record_text(text)

    def delete_record(self, table_name: str, record_id: str) -> None:
        collection = self.resolve_collection(table_name)
        self.call_tool("delete_record", {"collection": collection, "id": record_id})
        self.invalidate(table_name)


class GlQueryBuilder:
    def __init__(self, client: GlMcpClient, table_name: str):
        self._client = client
        self._table_name = table_name
        self._select_columns = "*"
        self._filters: List[Tuple[str, str, Any]] = []
        self._or_groups: List[str] = []
        self._orders: List[Tuple[str, bool]] = []
        self._limit: Optional[int] = None
        self._method = "GET"
        self._body: Any = None

    def select(self, columns="*"):
        self._select_columns = columns or "*"
        self._method = "GET"
        return self

    def insert(self, data):
        self._body = data if isinstance(data, list) else data
        self._method = "POST"
        return self

    def update(self, data):
        self._body = data
        self._method = "PATCH"
        return self

    def delete(self):
        self._method = "DELETE"
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def neq(self, col, val):
        self._filters.append(("neq", col, val))
        return self

    def in_(self, col, values):
        self._filters.append(("in", col, list(values)))
        return self

    def gt(self, col, val):
        self._filters.append(("gt", col, val))
        return self

    def gte(self, col, val):
        self._filters.append(("gte", col, val))
        return self

    def lt(self, col, val):
        self._filters.append(("lt", col, val))
        return self

    def lte(self, col, val):
        self._filters.append(("lte", col, val))
        return self

    def is_(self, col, val):
        self._filters.append(("is", col, val))
        return self

    def not_(self, col, op, val):
        self._filters.append((f"not:{op}", col, val))
        return self

    def or_(self, conditions):
        if conditions:
            self._or_groups.append(conditions)
        return self

    def order(self, col, desc=False):
        self._orders.append((col, desc))
        return self

    def limit(self, count):
        self._limit = count
        return self

    def execute(self):
        if self._method == "GET":
            return QueryResult(self._select_rows())

        if self._method == "POST":
            payload = self._normalize_write_data(dict(self._body or {}), is_insert=True)
            created = self._client.create_record(self._table_name, payload)
            return QueryResult([self._normalize_row(created)])

        if self._method == "PATCH":
            matched = self._select_rows()
            if not matched:
                return QueryResult([])
            payload = self._normalize_write_data(dict(self._body or {}), is_insert=False)
            updated_rows = []
            for row in matched:
                updated = self._client.update_record(self._table_name, row["_pb_id"], payload)
                updated_rows.append(self._normalize_row(updated))
            return QueryResult(updated_rows)

        if self._method == "DELETE":
            matched = self._select_rows()
            if not matched:
                return QueryResult([])
            for row in matched:
                self._client.delete_record(self._table_name, row["_pb_id"])
            return QueryResult(matched)

        raise ValueError(f"Unknown method: {self._method}")

    def _select_rows(self) -> List[Dict[str, Any]]:
        rows = [self._normalize_row(row) for row in self._client.list_all_records(self._table_name)]
        rows = [row for row in rows if self._matches_filters(row)]
        rows = self._apply_ordering(rows)
        if self._limit is not None:
            rows = rows[: self._limit]
        return self._apply_relations(rows)

    def _normalize_row(self, row: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(row)
        pocketbase_id = normalized.get("id")
        normalized["_pb_id"] = pocketbase_id
        if self._client.uses_legacy_id(self._table_name) and normalized.get("legacy_id"):
            normalized["id"] = normalized["legacy_id"]
        for key, value in list(normalized.items()):
            normalized[key] = _normalize_field_value(key, value)

        if self._table_name == "clients":
            normalized.setdefault("sheet_extra_fields", {})
            normalized.setdefault("source_active", True)
            normalized.setdefault("hidden_local", False)
            normalized.setdefault("gyeongli_password", normalized.get("gyeongli_password") or "")

        return normalized

    def _normalize_write_data(self, data: Dict[str, Any], *, is_insert: bool) -> Dict[str, Any]:
        payload = dict(data)
        public_id = payload.pop("id", None)
        if self._client.uses_legacy_id(self._table_name):
            payload["legacy_id"] = payload.get("legacy_id") or public_id or str(uuid.uuid4())

        if self._table_name == "users":
            payload.setdefault("is_admin", False)
            payload.setdefault("lock_enabled", False)
            payload.setdefault("lock_timeout", 300)
            payload.setdefault("pin_code", "")
            payload.setdefault("team_id", "")
            payload.setdefault("subteam_name", "")

        if is_insert:
            payload = {key: value for key, value in payload.items() if value is not None}

        return payload

    def _matches_filters(self, row: Dict[str, Any]) -> bool:
        for op, key, expected in self._filters:
            if not _match_filter_condition(_coerce_empty(row.get(key)), op, expected):
                return False

        for group in self._or_groups:
            clauses = [item.strip() for item in group.split(",") if item.strip()]
            if clauses and not any(_match_or_clause(row, clause) for clause in clauses):
                return False
        return True

    def _apply_ordering(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        ordered = list(rows)
        for key, desc in reversed(self._orders):
            ordered.sort(key=lambda row: _sortable_value(row.get(key)), reverse=desc)
        return ordered

    def _apply_relations(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        joins = RELATION_PATTERN.findall(self._select_columns or "")
        if not joins:
            return rows

        result_rows = [dict(row) for row in rows]
        for relation_name, inner_columns in joins:
            fields = [item.strip() for item in inner_columns.split(",") if item.strip() and item.strip() != "*"]
            if self._table_name == "bookmarks" and relation_name == "categories":
                related_rows = [self._normalize_row(row) for row in self._client.list_all_records("categories")]
                related_by_id = {row["id"]: row for row in related_rows}
                for row in result_rows:
                    row["categories"] = _select_relation_fields(related_by_id.get(row.get("category_id")), fields)
            elif self._table_name == "trusted_devices" and relation_name == "users":
                related_rows = [self._normalize_row(row) for row in self._client.list_all_records("users")]
                related_by_id = {row["id"]: row for row in related_rows}
                for row in result_rows:
                    row["users"] = _select_relation_fields(related_by_id.get(row.get("user_id")), fields)
        return result_rows


def _parse_sse_json(body: str) -> Dict[str, Any]:
    data_lines = []
    for line in body.splitlines():
        if line.startswith("data: "):
            data_lines.append(line[6:])
    if not data_lines:
        raise RuntimeError(f"Could not parse MCP response body: {body[:500]}")
    return json.loads(data_lines[-1])


def _parse_text_value(raw: str) -> Any:
    value = raw.strip()
    if value in {"true", "false"}:
        return value == "true"
    if value in {"null", "None"}:
        return None
    if value.startswith(('"', "[", "{")):
        try:
            return json.loads(value)
        except Exception:
            return value.strip('"')
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)
    return value


def _parse_list_records_text(text: str) -> Tuple[List[Dict[str, Any]], int, int]:
    if text.startswith("오류:"):
        raise RuntimeError(text)

    lines = text.splitlines()
    total_pages = 1
    total_count = 0
    if lines:
        match = LIST_HEADER_PATTERN.search(lines[0])
        if match:
            total_pages = int(match.group(2))
            total_count = int(match.group(3))

    rows: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for line in lines[1:]:
        if ROW_HEADER_PATTERN.match(line):
            if current is not None:
                rows.append(current)
            current = {}
            continue
        field_match = FIELD_PATTERN.match(line)
        if field_match and current is not None:
            current[field_match.group(1).strip()] = _parse_text_value(field_match.group(2))
    if current is not None:
        rows.append(current)
    return rows, total_pages, total_count


def _parse_single_record_text(text: str) -> Dict[str, Any]:
    if text.startswith("오류:"):
        raise RuntimeError(text)
    record: Dict[str, Any] = {}
    for line in text.splitlines():
        field_match = FIELD_PATTERN.match(line)
        if field_match:
            record[field_match.group(1).strip()] = _parse_text_value(field_match.group(2))
    return record


def _coerce_empty(value: Any) -> Any:
    if value == "":
        return None
    return value


def _normalize_field_value(key: str, value: Any) -> Any:
    value = _coerce_empty(value)
    if isinstance(value, str):
        stripped = value.strip()
        if key in DATE_ONLY_FIELDS and stripped:
            match = re.match(r"^(\d{4}-\d{2}-\d{2})", stripped)
            if match:
                if key in TIMESTAMP_FIELDS and "T" not in stripped and " " in stripped:
                    return stripped.replace(" ", "T", 1)
                if key in {"start_date", "end_date", "recurrence_end", "last_contact_at", "next_action_at", "incorporation_registry_date"}:
                    return match.group(1)
                if "T" not in stripped and " " in stripped:
                    return stripped.replace(" ", "T", 1)
        if key.endswith("_at") and "T" not in stripped and " " in stripped:
            return stripped.replace(" ", "T", 1)
    return value


def _parse_condition_value(raw: str) -> Any:
    lowered = raw.lower()
    if lowered == "null":
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def _match_simple(value: Any, operator: str, expected: Any) -> bool:
    value = _coerce_empty(value)
    expected = _coerce_empty(expected)
    if operator == "eq":
        return value == expected
    if operator == "neq":
        return value != expected
    if operator == "in":
        return value in (expected or [])
    if operator == "gt":
        return _compare_values(value, expected, ">")
    if operator == "gte":
        return _compare_values(value, expected, ">=")
    if operator == "lt":
        return _compare_values(value, expected, "<")
    if operator == "lte":
        return _compare_values(value, expected, "<=")
    if operator == "is":
        if expected is None:
            return value in (None, "")
        return value == expected
    raise ValueError(f"Unsupported operator: {operator}")


def _match_filter_condition(value: Any, operator: str, expected: Any) -> bool:
    if operator.startswith("not:"):
        return not _match_simple(value, operator.split(":", 1)[1], expected)
    return _match_simple(value, operator, expected)


def _match_or_clause(row: Dict[str, Any], clause: str) -> bool:
    parts = clause.split(".", 2)
    if len(parts) != 3:
        return False
    field, operator, raw_value = parts
    expected = _parse_condition_value(raw_value)
    return _match_simple(row.get(field), operator, expected)


def _sortable_value(value: Any) -> Tuple[int, Any]:
    value = _coerce_empty(value)
    if value is None:
        return (1, "")
    return (0, value)


def _compare_values(left: Any, right: Any, operator: str) -> bool:
    left = _coerce_empty(left)
    right = _coerce_empty(right)
    if left is None or right is None:
        return False
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    raise ValueError(f"Unsupported operator: {operator}")


def _select_relation_fields(related: Optional[Dict[str, Any]], fields: List[str]) -> Optional[Dict[str, Any]]:
    if not related:
        return None
    if not fields:
        return {key: value for key, value in related.items() if not key.startswith("_")}
    return {field: related.get(field) for field in fields}


def get_database():
    global _client
    if _client is None:
        _client = GlMcpClient(GL_MCP_URL, GL_MCP_TOKEN)
    return _client
