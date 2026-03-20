import base64
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from jose import jwt as jose_jwt


GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

DEFAULT_SHEET_ID = "14cZE3ycFtqUOhLRXipmtWkIeF5KeSsmcC2Huyikcbso"
DEFAULT_SHEET_GID = "0"
DEFAULT_SHEET_RANGE = "B:Y"
DEFAULT_SERVICE_ACCOUNT_FILE = "/Users/sonminjun/Downloads/linkflow-490708-bae80089e93e.json"

CLIENT_FIXED_FIELDS = [
    {"key": "name", "label": "거래처명"},
    {"key": "owner_name", "label": "경리팀 담당자"},
    {"key": "company_contact_name", "label": "기업 내부 담당자"},
    {"key": "phone", "label": "기업 담당 연락처"},
    {"key": "email", "label": "기업 담당 이메일"},
    {"key": "last_contact_at", "label": "최근 접촉일"},
    {"key": "next_action_title", "label": "다음 액션 제목"},
    {"key": "next_action_at", "label": "다음 액션 예정일"},
    {"key": "client_code", "label": "코드"},
    {"key": "business_number", "label": "사업자번호"},
    {"key": "ceo_name", "label": "대표"},
    {"key": "gyeongli_id", "label": "경리나라 아이디"},
    {"key": "gyeongli_password", "label": "경리나라 비밀번호"},
    {"key": "memo", "label": "메모"},
]

_RAW_END_DATE = "__sheet_end_date"

_KNOWN_HEADER_MAP = {
    "코드": "client_code",
    "거래처명": "name",
    "경리팀담당자": "owner_name",
    "기업내부담당자": "company_contact_name",
    "기업담당연락처": "phone",
    "기업담당이메일": "email",
    "최근접촉일": "last_contact_at",
    "다음액션제목": "next_action_title",
    "다음액션예정일": "next_action_at",
    "사업자번호": "business_number",
    "대표": "ceo_name",
    "경리나라아이디": "gyeongli_id",
    "경리나라비밀번호": "gyeongli_password",
    "메모": "memo",
    "종료일": _RAW_END_DATE,
}

CLIENT_SYNC_STATE: Dict[str, Any] = {
    "last_success_at": None,
    "last_attempt_at": None,
    "last_error": None,
    "sheet_title": None,
    "sheet_range": None,
    "extra_fields": [],
}


def serialize_client_row(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    data = dict(row or {})
    data["status"] = data.get("status") or "active"
    data["source_active"] = bool(data.get("source_active", True))
    data["hidden_local"] = bool(data.get("hidden_local", False))
    data["sheet_extra_fields"] = (
        data.get("sheet_extra_fields")
        if isinstance(data.get("sheet_extra_fields"), dict)
        else {}
    )
    return data


def get_client_schema_snapshot(rows: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    extra_fields = CLIENT_SYNC_STATE.get("extra_fields") or []
    if not extra_fields and rows:
        names = set()
        for row in rows:
            extras = row.get("sheet_extra_fields") or {}
            if isinstance(extras, dict):
                names.update(str(key) for key in extras.keys() if str(key).strip())
        extra_fields = sorted(names)

    last_synced_at = CLIENT_SYNC_STATE.get("last_success_at")
    if not last_synced_at and rows:
        timestamps = [row.get("last_synced_at") for row in rows if row.get("last_synced_at")]
        if timestamps:
            last_synced_at = max(timestamps)

    return {
        "fixed_fields": CLIENT_FIXED_FIELDS,
        "extra_fields": [{"key": name, "label": name} for name in extra_fields],
        "last_synced_at": last_synced_at,
        "last_error": CLIENT_SYNC_STATE.get("last_error"),
        "sheet_title": CLIENT_SYNC_STATE.get("sheet_title"),
        "sheet_range": CLIENT_SYNC_STATE.get("sheet_range"),
    }


def sync_clients_from_sheet(
    db,
    encrypt_password=None,
    service_account_json: Optional[str] = None,
) -> Dict[str, Any]:
    CLIENT_SYNC_STATE["last_attempt_at"] = datetime.now(timezone.utc).isoformat()
    sheet = _fetch_sheet_rows(service_account_json=service_account_json)
    headers = sheet["headers"]
    rows = sheet["rows"]

    parsed_rows = []
    seen_codes = {}
    skipped = []

    for row in rows:
        parsed = _parse_sheet_row(headers, row["values"], row["row_number"])
        code = parsed.get("client_code")
        if not code:
            skipped.append(
                {
                    "row_number": row["row_number"],
                    "reason": "코드 없음",
                    "name": parsed.get("name") or "",
                }
            )
            continue
        normalized_code = _normalize_key(code)
        if normalized_code in seen_codes:
            first_row = seen_codes[normalized_code]
            raise HTTPException(
                status_code=400,
                detail=f"시트에 중복된 거래처 코드가 있습니다: {code} (행 {first_row}, {row['row_number']})",
            )
        seen_codes[normalized_code] = row["row_number"]
        parsed_rows.append(parsed)

    existing_rows = [serialize_client_row(row) for row in db.table("clients").select("*").execute().data]
    existing_by_code = {
        _normalize_key(row.get("client_code")): row
        for row in existing_rows
        if str(row.get("client_code") or "").strip()
    }
    used_existing_ids = set()
    timestamp = datetime.now(timezone.utc).isoformat()

    inserted = 0
    updated = 0
    deactivated = 0

    for parsed in parsed_rows:
        code = _normalize_key(parsed["client_code"])
        current = existing_by_code.get(code)
        if not current:
            current = _match_legacy_client(existing_rows, parsed, used_existing_ids)

        payload = _build_client_payload(parsed, timestamp, encrypt_password=encrypt_password)
        if current:
            used_existing_ids.add(current["id"])
            result = db.table("clients").update(payload).eq("id", current["id"]).execute()
            if result.data:
                existing_by_code[code] = serialize_client_row(result.data[0])
            updated += 1
        else:
            insert_payload = {
                **payload,
                "status": "active",
                "hidden_local": False,
            }
            result = db.table("clients").insert(insert_payload).execute()
            if result.data:
                created = serialize_client_row(result.data[0])
                existing_by_code[code] = created
                used_existing_ids.add(created["id"])
            inserted += 1

    active_codes = {_normalize_key(item["client_code"]) for item in parsed_rows}
    for row in existing_rows:
        code = _normalize_key(row.get("client_code"))
        if not code:
            continue
        if code in active_codes:
            continue
        if row.get("source_active") is False:
            continue
        db.table("clients").update(
            {
                "source_active": False,
                "last_synced_at": timestamp,
            }
        ).eq("id", row["id"]).execute()
        deactivated += 1

    CLIENT_SYNC_STATE.update(
        {
            "last_success_at": timestamp,
            "last_error": None,
            "sheet_title": sheet["title"],
            "sheet_range": sheet["range_label"],
            "extra_fields": sheet["extra_fields"],
        }
    )

    return {
        "inserted": inserted,
        "updated": updated,
        "deactivated": deactivated,
        "skipped": len(skipped),
        "skipped_rows": skipped,
        "last_synced_at": timestamp,
        "sheet_title": sheet["title"],
        "sheet_range": sheet["range_label"],
        "extra_fields": sheet["extra_fields"],
    }


def _fetch_sheet_rows(service_account_json: Optional[str] = None) -> Dict[str, Any]:
    access_token = _get_google_access_token(service_account_json=service_account_json)
    sheet_id = os.getenv("GOOGLE_SHEET_ID", DEFAULT_SHEET_ID).strip() or DEFAULT_SHEET_ID
    gid = int((os.getenv("GOOGLE_SHEET_GID", DEFAULT_SHEET_GID) or DEFAULT_SHEET_GID).strip())
    cell_range = (os.getenv("GOOGLE_SHEET_RANGE", DEFAULT_SHEET_RANGE) or DEFAULT_SHEET_RANGE).strip()

    headers = {"Authorization": f"Bearer {access_token}"}

    with httpx.Client(timeout=20) as client:
        meta_response = client.get(
            f"{GOOGLE_SHEETS_API}/{sheet_id}",
            headers=headers,
            params={"fields": "sheets(properties(sheetId,title))"},
        )
        if meta_response.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"Google Sheets 메타데이터 조회 실패: {meta_response.text}",
            )
        sheets = meta_response.json().get("sheets") or []
        title = None
        for item in sheets:
            props = item.get("properties") or {}
            if int(props.get("sheetId", -1)) == gid:
                title = props.get("title")
                break
        if not title:
            raise HTTPException(status_code=404, detail=f"Google Sheet gid={gid} 시트를 찾지 못했습니다")

        target_range = f"{title}!{cell_range}"
        values_response = client.get(
            f"{GOOGLE_SHEETS_API}/{sheet_id}/values/{quote(target_range, safe='!:')}",
            headers=headers,
        )
        if values_response.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"Google Sheets 값 조회 실패: {values_response.text}",
            )
        values = (values_response.json() or {}).get("values") or []

    if not values:
        return {
            "title": title,
            "range_label": target_range,
            "headers": [],
            "rows": [],
            "extra_fields": [],
        }

    raw_headers = values[0]
    headers = []
    extra_fields = []
    seen_extra = set()
    for index, header in enumerate(raw_headers, start=2):
        label = str(header or "").strip() or f"추가 열 {index}"
        headers.append(label)
        field_key = _KNOWN_HEADER_MAP.get(_normalize_header(label))
        if field_key is None:
            if label not in seen_extra:
                extra_fields.append(label)
                seen_extra.add(label)

    return {
        "title": title,
        "range_label": target_range,
        "headers": headers,
        "rows": [
            {
                "row_number": row_index,
                "values": row,
            }
            for row_index, row in enumerate(values[1:], start=2)
        ],
        "extra_fields": extra_fields,
    }


def _get_google_access_token(service_account_json: Optional[str] = None) -> str:
    account = _load_google_service_account(service_account_json=service_account_json)
    now = datetime.now(timezone.utc)
    payload = {
        "iss": account["client_email"],
        "scope": GOOGLE_SHEETS_SCOPE,
        "aud": GOOGLE_TOKEN_URL,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=55)).timestamp()),
    }
    headers = {}
    if account.get("private_key_id"):
        headers["kid"] = account["private_key_id"]

    assertion = jose_jwt.encode(
        payload,
        account["private_key"],
        algorithm="RS256",
        headers=headers or None,
    )

    response = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        timeout=20,
    )
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Google 인증 토큰 발급 실패: {response.text}",
        )
    token = (response.json() or {}).get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail="Google 인증 토큰이 비어 있습니다")
    return token


def _load_google_service_account(service_account_json: Optional[str] = None) -> Dict[str, Any]:
    file_env = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_FILE", "").strip()
    inline_env = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()

    candidates: List[str] = []
    if service_account_json:
        candidates.append(service_account_json.strip())
    if file_env:
        candidates.append(_read_service_account_file(file_env, env_name="GOOGLE_SERVICE_ACCOUNT_JSON_FILE"))
    elif os.path.isfile(DEFAULT_SERVICE_ACCOUNT_FILE):
        candidates.append(_read_service_account_file(DEFAULT_SERVICE_ACCOUNT_FILE, env_name=None))

    if inline_env:
        candidates.append(inline_env)

    if not candidates:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_SERVICE_ACCOUNT_JSON_FILE 또는 GOOGLE_SERVICE_ACCOUNT_JSON 이 설정되지 않았습니다",
        )

    for raw in candidates:
        raw_candidates = [raw]
        if "\\n" in raw:
            raw_candidates.append(raw.replace("\\n", "\n"))
        if not raw.startswith("{"):
            for decoder in (base64.b64decode, base64.urlsafe_b64decode):
                try:
                    decoded = decoder(raw.encode("utf-8")).decode("utf-8")
                    raw_candidates.extend([decoded, decoded.replace("\\n", "\n")])
                except Exception:
                    continue

        for candidate in raw_candidates:
            try:
                account = json.loads(candidate)
            except Exception:
                continue
            private_key = str(account.get("private_key") or "").replace("\\n", "\n")
            client_email = str(account.get("client_email") or "").strip()
            if private_key and client_email:
                account["private_key"] = private_key
                return account

    raise HTTPException(
        status_code=503,
        detail="GOOGLE_SERVICE_ACCOUNT_JSON_FILE 또는 GOOGLE_SERVICE_ACCOUNT_JSON 형식을 해석하지 못했습니다",
    )


def _read_service_account_file(path: str, env_name: Optional[str]) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except FileNotFoundError as exc:
        if env_name:
            raise HTTPException(
                status_code=503,
                detail=f"{env_name} 경로의 서비스 계정 파일을 찾지 못했습니다: {path}",
            ) from exc
        raise
    except OSError as exc:
        if env_name:
            raise HTTPException(
                status_code=503,
                detail=f"{env_name} 경로의 서비스 계정 파일을 읽지 못했습니다: {path}",
            ) from exc
        raise


def _parse_sheet_row(headers: List[str], values: List[Any], row_number: int) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "sheet_row_number": row_number,
        "sheet_extra_fields": {},
        "source_active": True,
    }

    for index, header in enumerate(headers):
        raw_value = values[index] if index < len(values) else ""
        normalized = _normalize_cell(raw_value)
        target_field = _KNOWN_HEADER_MAP.get(_normalize_header(header))

        if target_field == _RAW_END_DATE:
            row["source_active"] = not bool(normalized)
            continue

        if target_field is None:
            if normalized:
                row["sheet_extra_fields"][header] = normalized
            continue

        if target_field in {"last_contact_at", "next_action_at"}:
            parsed_date = _normalize_sheet_date(raw_value)
            if parsed_date:
                row[target_field] = parsed_date
            elif normalized:
                row["sheet_extra_fields"][f"{header} 원본"] = normalized
            continue

        row[target_field] = normalized or None

    row["client_code"] = _normalize_client_code(row.get("client_code"))
    row["name"] = _normalize_cell(row.get("name")) or None
    row["owner_name"] = _normalize_cell(row.get("owner_name")) or None
    row["company_contact_name"] = _normalize_cell(row.get("company_contact_name")) or None
    row["phone"] = _normalize_cell(row.get("phone")) or None
    row["email"] = _normalize_cell(row.get("email")) or None
    row["memo"] = _normalize_cell(row.get("memo")) or None
    row["gyeongli_id"] = _normalize_cell(row.get("gyeongli_id")) or None
    row["gyeongli_password"] = _normalize_cell(row.get("gyeongli_password")) or None
    row["business_number"] = _normalize_cell(row.get("business_number")) or None
    row["ceo_name"] = _normalize_cell(row.get("ceo_name")) or None
    row["next_action_title"] = _normalize_cell(row.get("next_action_title")) or None
    return row


def _build_client_payload(
    row: Dict[str, Any],
    timestamp: str,
    encrypt_password=None,
) -> Dict[str, Any]:
    payload = {
        "client_code": row.get("client_code"),
        "name": row.get("name") or row.get("gyeongli_id") or "이름 미지정",
        "owner_name": row.get("owner_name"),
        "company_contact_name": row.get("company_contact_name"),
        "phone": row.get("phone"),
        "email": row.get("email"),
        "memo": row.get("memo") or "",
        "last_contact_at": row.get("last_contact_at"),
        "next_action_title": row.get("next_action_title"),
        "next_action_at": row.get("next_action_at"),
        "business_number": row.get("business_number"),
        "ceo_name": row.get("ceo_name"),
        "gyeongli_id": row.get("gyeongli_id"),
        "sheet_row_number": row.get("sheet_row_number"),
        "sheet_extra_fields": row.get("sheet_extra_fields") or {},
        "sort_order": max(int(row.get("sheet_row_number") or 0) - 2, 0),
        "source_active": bool(row.get("source_active", True)),
        "last_synced_at": timestamp,
        "status": "active",
    }
    if encrypt_password:
        payload["gyeongli_pw_encrypted"] = encrypt_password(row.get("gyeongli_password") or "")
    return payload


def _match_legacy_client(
    existing_rows: List[Dict[str, Any]],
    parsed_row: Dict[str, Any],
    used_existing_ids: set,
) -> Optional[Dict[str, Any]]:
    best_match: Optional[Dict[str, Any]] = None
    best_score = 0

    for row in existing_rows:
        if row.get("id") in used_existing_ids:
            continue
        current_code = _normalize_key(row.get("client_code"))
        if current_code and current_code != _normalize_key(parsed_row.get("client_code")):
            continue

        score = 0
        if _normalize_key(row.get("name")) and _normalize_key(row.get("name")) == _normalize_key(parsed_row.get("name")):
            score += 100
        if _normalize_key(row.get("gyeongli_id")) and _normalize_key(row.get("gyeongli_id")) == _normalize_key(parsed_row.get("gyeongli_id")):
            score += 80
        if _extract_legacy_code(row.get("memo")) and _extract_legacy_code(row.get("memo")) == _normalize_key(parsed_row.get("client_code")):
            score += 70
        if _normalize_key(row.get("business_number")) and _normalize_key(row.get("business_number")) == _normalize_key(parsed_row.get("business_number")):
            score += 60
        if _normalize_key(row.get("owner_name")) and _normalize_key(row.get("owner_name")) == _normalize_key(parsed_row.get("owner_name")):
            score += 10

        if score > best_score:
            best_score = score
            best_match = row

    return best_match if best_score >= 70 else None


def _extract_legacy_code(memo: Any) -> str:
    match = re.search(r"코드\s*:\s*([^|]+)", str(memo or ""))
    return _normalize_key(match.group(1) if match else "")


def _normalize_header(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip()


def _normalize_cell(value: Any) -> str:
    text = str(value or "").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _normalize_key(value: Any) -> str:
    return _normalize_cell(value).lower()


def _normalize_client_code(value: Any) -> str:
    return _normalize_cell(value)


def _normalize_sheet_date(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        base_date = datetime(1899, 12, 30)
        normalized = base_date + timedelta(days=float(value))
        return normalized.date().isoformat()

    text = _normalize_cell(value)
    if not text:
        return None

    iso_like = text.replace("년", "-").replace("월", "-").replace("일", "")
    iso_like = iso_like.replace("/", "-").replace(".", "-")
    iso_like = re.sub(r"-+", "-", iso_like).strip("- ")
    try:
        return datetime.fromisoformat(iso_like).date().isoformat()
    except Exception:
        pass

    for pattern in (
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%m-%d-%Y",
        "%Y.%m.%d",
        "%Y. %m. %d.",
        "%Y. %m. %d",
        "%Y/%m/%d",
    ):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except Exception:
            continue
    return None
