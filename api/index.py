import sys
import os
import json
import socket
import ipaddress
import traceback
from datetime import datetime, timezone, date, timedelta
from urllib.parse import urlparse
from dateutil.relativedelta import relativedelta
from holidayskr import is_holiday as kr_is_holiday, year_holidays as kr_year_holidays

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx

from lib.database import get_supabase
from lib.auth import (
    hash_password,
    verify_password,
    create_token,
    verify_token,
    generate_device_token,
)
from lib.models import (
    LoginRequest,
    AutoLoginRequest,
    BookmarkCreate,
    BookmarkUpdate,
    ReorderRequest,
    CategoryCreate,
    CategoryUpdate,
    UserCreate,
    SettingsUpdate,
    UserPreferencesUpdate,
    SetupRequest,
    PasswordChange,
    EventCreate,
    EventUpdate,
    MemoCreate,
    MemoUpdate,
    TeamCreate,
    TeamUpdate,
    ClientCreate,
    ClientUpdate,
    ClientReorderRequest,
    ShortcutCreate,
    ShortcutUpdate,
)

app = FastAPI()

_ALLOWED_ORIGINS = [
    origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",") if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"[ERROR] {request.url}: {exc}\n{tb}", file=sys.stderr, flush=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


@app.get("/api/ping")
async def ping():
    return {"status": "ok"}


# ?? Dependencies ??


async def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ")[1]
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload


async def get_admin_user(user=Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


CLIENT_STATUSES = {"active", "pending", "paused", "closed"}
USER_PREFERENCES_DEFAULTS = {
    "client_view_state": {},
    "client_custom_view": None,
    "url_notes": {},
}


def _explicit_model_data(model):
    return {field: getattr(model, field) for field in model.model_fields_set}


def _normalize_client_status(status: str) -> str:
    normalized = (status or "active").strip().lower()
    if normalized not in CLIENT_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid client status")
    return normalized


def _require_client_exists(client_id: str):
    db = get_supabase()
    client = db.table("clients").select("id").eq("id", client_id).execute()
    if not client.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return client.data[0]


def _serialize_client_row(row, include_password: bool = False):
    data = dict(row)
    data["status"] = data.get("status") or "active"
    if include_password:
        data["gyeongli_pw"] = _decrypt(data.get("gyeongli_pw_encrypted") or "")
    data.pop("gyeongli_pw_encrypted", None)
    return data


def _get_next_client_sort_order():
    db = get_supabase()
    result = db.table("clients").select("sort_order").order("sort_order", desc=True).limit(1).execute()
    if not result.data:
        return 0
    current = result.data[0].get("sort_order")
    return int(current or 0) + 1


def _serialize_user_preferences(row=None):
    source = row or {}
    return {
        "client_view_state": source.get("client_view_state")
        if isinstance(source.get("client_view_state"), dict)
        else {},
        "client_custom_view": source.get("client_custom_view")
        if isinstance(source.get("client_custom_view"), dict)
        else None,
        "url_notes": source.get("url_notes")
        if isinstance(source.get("url_notes"), dict)
        else {},
    }


def _get_user_preferences(user_id: str):
    db = get_supabase()
    result = (
        db.table("user_preferences")
        .select("client_view_state, client_custom_view, url_notes")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return _serialize_user_preferences(USER_PREFERENCES_DEFAULTS)
    return _serialize_user_preferences(result.data[0])


def _save_user_preferences(user_id: str, payload: dict):
    db = get_supabase()
    existing = (
        db.table("user_preferences")
        .select("user_id")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )

    data = {
        **payload,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    if existing.data:
        result = (
            db.table("user_preferences")
            .update(data)
            .eq("user_id", user_id)
            .execute()
        )
    else:
        result = db.table("user_preferences").insert(
            {
                "user_id": user_id,
                **USER_PREFERENCES_DEFAULTS,
                **data,
            }
        ).execute()

    if not result.data:
        return _get_user_preferences(user_id)
    return _serialize_user_preferences(result.data[0])


def _timeline_timestamp(row, *fields):
    for field in fields:
        value = row.get(field)
        if value:
            return value
    start_date = row.get("start_date")
    if start_date:
        start_time = row.get("start_time") or "00:00:00"
        if len(start_time) == 5:
            start_time = f"{start_time}:00"
        return f"{start_date}T{start_time}"
    return ""


def _is_disallowed_outbound_host(hostname: str) -> bool:
    if not hostname:
        return True

    host = hostname.strip().lower().rstrip(".")
    if host == "localhost":
        return True

    try:
        ips = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        except Exception:
            return True

        ips = []
        for info in infos:
            ip_str = info[4][0]
            try:
                ips.append(ipaddress.ip_address(ip_str))
            except ValueError:
                continue

        if not ips:
            return True

    for ip_obj in ips:
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            return True

    return False


def _validate_outbound_url(raw_url: str) -> str:
    parsed = urlparse((raw_url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http/https URLs are allowed")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if _is_disallowed_outbound_host(parsed.hostname):
        raise HTTPException(status_code=400, detail="Blocked target host")
    return parsed.geturl()


# ?? Setup (first-time admin creation) ??


@app.post("/api/setup")
async def setup(req: SetupRequest):
    db = get_supabase()
    result = db.table("users").select("id").eq("is_admin", True).execute()
    if result.data:
        raise HTTPException(status_code=400, detail="Admin already exists")

    user = (
        db.table("users")
        .insert(
            {
                "username": req.username,
                "password_hash": hash_password(req.password),
                "display_name": req.display_name,
                "is_admin": True,
            }
        )
        .execute()
    )
    return {"message": "Admin created", "user_id": user.data[0]["id"]}


# ?? Auth ??


@app.post("/api/auth/login")
async def login(req: LoginRequest):
    db = get_supabase()
    result = db.table("users").select("*").eq("username", req.username).execute()

    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user = result.data[0]
    if not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_token(user["id"], user["username"], user["is_admin"])

    response = {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "is_admin": user["is_admin"],
            "lock_enabled": user["lock_enabled"],
            "lock_timeout": user["lock_timeout"],
            "pin_code": user["pin_code"],
            "team_id": user.get("team_id"),
        },
    }

    if req.remember_device:
        device_token = generate_device_token()
        db.table("trusted_devices").insert(
            {
                "user_id": user["id"],
                "device_token": device_token,
                "device_name": req.device_name or "Unknown Device",
            }
        ).execute()
        response["device_token"] = device_token

    return response


@app.post("/api/auth/auto-login")
async def auto_login(req: AutoLoginRequest):
    db = get_supabase()
    result = (
        db.table("trusted_devices")
        .select("*, users(*)")
        .eq("device_token", req.device_token)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=401, detail="Device not recognized")

    device = result.data[0]
    user = device["users"]

    db.table("trusted_devices").update(
        {"last_used": datetime.now(timezone.utc).isoformat()}
    ).eq("id", device["id"]).execute()

    token = create_token(user["id"], user["username"], user["is_admin"])

    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "is_admin": user["is_admin"],
            "lock_enabled": user["lock_enabled"],
            "lock_timeout": user["lock_timeout"],
            "pin_code": user["pin_code"],
            "team_id": user.get("team_id"),
        },
    }


# ?? Bookmarks ??


@app.get("/api/bookmarks")
async def get_bookmarks(user=Depends(get_current_user)):
    db = get_supabase()
    uid = user["sub"]

    own = (
        db.table("bookmarks")
        .select("*, categories(name, icon)")
        .eq("user_id", uid)
        .order("sort_order")
        .execute()
    )

    shared = (
        db.table("bookmarks")
        .select("*, categories(name, icon)")
        .eq("is_shared", True)
        .neq("user_id", uid)
        .order("sort_order")
        .execute()
    )

    return {"own": own.data, "shared": shared.data}


@app.post("/api/bookmarks")
async def create_bookmark(req: BookmarkCreate, user=Depends(get_current_user)):
    db = get_supabase()
    if req.is_shared and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can create shared bookmarks")
    if req.client_id:
        _require_client_exists(req.client_id)
    data = {
        "user_id": user["sub"],
        "title": req.title,
        "url": req.url,
        "description": req.description,
        "category_id": req.category_id if req.category_id else None,
        "service_type": req.service_type,
        "health_check_url": req.health_check_url,
        "icon_url": req.icon_url,
        "is_shared": req.is_shared,
        "open_mode": req.open_mode,
        "is_pinned": req.is_pinned,
        "client_id": req.client_id,
    }
    result = db.table("bookmarks").insert(data).execute()
    return result.data[0]


@app.put("/api/bookmarks/{bookmark_id}")
async def update_bookmark(
    bookmark_id: str, req: BookmarkUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = _explicit_model_data(req)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "is_shared" in data and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can change shared status")
    if data.get("client_id"):
        _require_client_exists(data["client_id"])

    result = (
        db.table("bookmarks")
        .update(data)
        .eq("id", bookmark_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return result.data[0]


@app.delete("/api/bookmarks/{bookmark_id}")
async def delete_bookmark(bookmark_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("bookmarks")
        .delete()
        .eq("id", bookmark_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"message": "Deleted"}


@app.patch("/api/bookmarks/{bookmark_id}/pin")
async def toggle_pin_bookmark(bookmark_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    existing = (
        db.table("bookmarks")
        .select("is_pinned")
        .eq("id", bookmark_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    new_val = not existing.data[0].get("is_pinned", False)
    result = (
        db.table("bookmarks")
        .update({"is_pinned": new_val})
        .eq("id", bookmark_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    return result.data[0]


@app.patch("/api/bookmarks/reorder")
async def reorder_bookmarks(req: ReorderRequest, user=Depends(get_current_user)):
    db = get_supabase()
    for item in req.items:
        db.table("bookmarks").update({"sort_order": item["sort_order"]}).eq(
            "id", item["id"]
        ).eq("user_id", user["sub"]).execute()
    return {"message": "Reordered"}


# ?? Categories ??


@app.get("/api/categories")
async def get_categories(user=Depends(get_current_user)):
    db = get_supabase()
    own = (
        db.table("categories")
        .select("*")
        .eq("user_id", user["sub"])
        .order("sort_order")
        .execute()
    )
    shared = (
        db.table("categories")
        .select("*")
        .eq("is_shared", True)
        .neq("user_id", user["sub"])
        .order("sort_order")
        .execute()
    )
    return {"own": own.data, "shared": shared.data}


@app.post("/api/categories")
async def create_category(req: CategoryCreate, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("categories")
        .insert(
            {
                "user_id": user["sub"],
                "name": req.name,
                "icon": req.icon,
            }
        )
        .execute()
    )
    return result.data[0]


@app.put("/api/categories/{category_id}")
async def update_category(
    category_id: str, req: CategoryUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    result = (
        db.table("categories")
        .update(data)
        .eq("id", category_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Category not found")
    return result.data[0]


@app.delete("/api/categories/{category_id}")
async def delete_category(category_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("categories")
        .delete()
        .eq("id", category_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Category not found")
    return {"message": "Deleted"}


# ?? Embed Check ??


@app.get("/api/check-embeddable")
async def check_embeddable(url: str, user=Depends(get_current_user)):
    safe_url = _validate_outbound_url(url)
    try:
        async with httpx.AsyncClient(timeout=3.0, follow_redirects=True) as client:
            resp = await client.head(safe_url)
            if resp.status_code in (405, 501):
                resp = await client.get(safe_url)
            xfo = resp.headers.get("x-frame-options", "").lower().strip()
            csp = resp.headers.get("content-security-policy", "").lower()

            if xfo in ("deny", "sameorigin"):
                return {"embeddable": False, "reason": "x-frame-options"}

            if "frame-ancestors" in csp:
                if "'none'" in csp or "'self'" in csp:
                    return {"embeddable": False, "reason": "csp"}

            return {"embeddable": True}
    except Exception:
        return {"embeddable": False, "reason": "unreachable"}


# ?? Health Check ??


@app.get("/api/health/{bookmark_id}")
async def check_health(bookmark_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("bookmarks")
        .select("health_check_url, url")
        .eq("id", bookmark_id)
        .or_(f"user_id.eq.{user['sub']},is_shared.eq.true")
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Bookmark not found")

    bm = result.data[0]
    check_url = bm.get("health_check_url") or bm["url"]

    try:
        safe_url = _validate_outbound_url(check_url)
    except HTTPException:
        return {"status": "blocked", "code": None}

    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            resp = await client.get(safe_url)
            status = "online" if resp.status_code < 500 else "error"
            return {"status": status, "code": resp.status_code}
    except Exception:
        return {"status": "offline", "code": None}


@app.post("/api/health/batch")
async def batch_health_check(req: dict, user=Depends(get_current_user)):
    import asyncio

    raw_urls = req.get("urls", {})
    if not isinstance(raw_urls, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    bookmark_ids = list(raw_urls.keys())[:200]
    results = {}
    if not bookmark_ids:
        return results

    db = get_supabase()
    accessible = (
        db.table("bookmarks")
        .select("id, health_check_url, url")
        .or_(f"user_id.eq.{user['sub']},is_shared.eq.true")
        .execute()
    )
    allowed_map = {row["id"]: row for row in accessible.data}

    targets = {}
    for bookmark_id in bookmark_ids:
        row = allowed_map.get(bookmark_id)
        if not row:
            results[bookmark_id] = {"status": "forbidden", "code": None}
            continue

        check_url = row.get("health_check_url") or row.get("url") or ""
        try:
            targets[bookmark_id] = _validate_outbound_url(check_url)
        except HTTPException:
            results[bookmark_id] = {"status": "blocked", "code": None}

    async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
        async def _check(bookmark_id: str, url: str):
            try:
                resp = await client.get(url)
                status = "online" if resp.status_code < 500 else "error"
                results[bookmark_id] = {"status": status, "code": resp.status_code}
            except Exception:
                results[bookmark_id] = {"status": "offline", "code": None}

        await asyncio.gather(*[_check(bid, url) for bid, url in targets.items()])

    return results


# ?? User Settings ??


@app.get("/api/user/settings")
async def get_settings(user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("users")
        .select("display_name, lock_enabled, lock_timeout, pin_code")
        .eq("id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]


@app.put("/api/user/settings")
async def update_settings(req: SettingsUpdate, user=Depends(get_current_user)):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = db.table("users").update(data).eq("id", user["sub"]).execute()
    return result.data[0]


@app.get("/api/user/preferences")
async def get_user_preferences(user=Depends(get_current_user)):
    return _get_user_preferences(user["sub"])


@app.put("/api/user/preferences")
async def update_user_preferences(req: UserPreferencesUpdate, user=Depends(get_current_user)):
    raw = _explicit_model_data(req)
    if not raw:
        raise HTTPException(status_code=400, detail="No fields to update")

    data = {}
    if "client_view_state" in raw:
        data["client_view_state"] = raw["client_view_state"] or {}
    if "client_custom_view" in raw:
        data["client_custom_view"] = raw["client_custom_view"]
    if "url_notes" in raw:
        data["url_notes"] = raw["url_notes"] or {}

    return _save_user_preferences(user["sub"], data)


@app.put("/api/user/password")
async def change_password(req: PasswordChange, user=Depends(get_current_user)):
    db = get_supabase()
    user_data = (
        db.table("users").select("password_hash").eq("id", user["sub"]).execute()
    )
    if not verify_password(req.current_password, user_data.data[0]["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    db.table("users").update({"password_hash": hash_password(req.new_password)}).eq(
        "id", user["sub"]
    ).execute()
    return {"message": "Password changed"}


# ?? Admin ??


@app.get("/api/admin/users")
async def list_users(admin=Depends(get_admin_user)):
    db = get_supabase()
    result = (
        db.table("users")
        .select("id, username, display_name, is_admin, team_id, created_at")
        .order("created_at")
        .execute()
    )
    return result.data


@app.post("/api/admin/users")
async def create_user(req: UserCreate, admin=Depends(get_admin_user)):
    db = get_supabase()
    existing = db.table("users").select("id").eq("username", req.username).execute()
    if existing.data:
        raise HTTPException(status_code=400, detail="Username already exists")

    data = {
        "username": req.username,
        "password_hash": hash_password(req.password),
        "display_name": req.display_name,
    }
    if req.team_id:
        data["team_id"] = req.team_id

    result = db.table("users").insert(data).execute()
    return {
        "id": result.data[0]["id"],
        "username": req.username,
        "display_name": req.display_name,
        "team_id": result.data[0].get("team_id"),
    }


@app.delete("/api/admin/users/{user_id}")
async def delete_user(user_id: str, admin=Depends(get_admin_user)):
    db = get_supabase()
    if user_id == admin["sub"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    db.table("users").delete().eq("id", user_id).execute()
    return {"message": "User deleted"}


@app.post("/api/admin/users/{user_id}/reset-password")
async def reset_password(user_id: str, req: dict, admin=Depends(get_admin_user)):
    db = get_supabase()
    new_password = str(req.get("new_password") or "").strip()
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    result = db.table("users").update({"password_hash": hash_password(new_password)}).eq(
        "id", user_id
    ).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")

    return {"message": "Password reset"}


# ?? Events (Calendar) ??

_DONE_SEP = "\n__LFDONE__"


def _parse_completed_dates(desc):
    """Parse completed dates metadata from the description field."""
    if not desc or _DONE_SEP not in desc:
        return (desc, set())
    parts = desc.split(_DONE_SEP, 1)
    clean_desc = parts[0] if parts[0] else None
    try:
        dates = set(json.loads(parts[1]))
    except Exception:
        dates = set()
    return (clean_desc, dates)


def _encode_completed_dates(desc, dates_set):
    """Encode completed dates into the description field."""
    clean = desc or ""
    if not dates_set:
        return clean if clean else None
    return clean + _DONE_SEP + json.dumps(sorted(dates_set))


def _adjust_to_weekday(d):
    """二쇰쭚(???? ?먮뒗 ?쒓뎅 怨듯쑕?쇱씠硫?吏곸쟾 ?됱씪濡??대룞"""
    while d.weekday() >= 5 or kr_is_holiday(d.isoformat()):
        d -= timedelta(days=1)
    return d


def _expand_recurring(events_data, view_start: date, view_end: date):
    """Expand recurring events into individual date instances within the view range."""
    expanded = []
    for ev in events_data:
        rtype = ev.get("recurrence_type")
        if not rtype:
            expanded.append(ev)
            continue

        raw_desc = ev.get("description")
        clean_desc, completed = _parse_completed_dates(raw_desc)

        base = date.fromisoformat(ev["start_date"])
        r_end = date.fromisoformat(ev["recurrence_end"]) if ev.get("recurrence_end") else view_end
        r_end = min(r_end, view_end)
        interval = ev.get("recurrence_interval") or 1
        skip_weekend = ev.get("skip_weekend", False)
        rec_day = ev.get("recurrence_day")

        if rtype == "monthly" and rec_day:
            import calendar as cal_mod
            cur_year, cur_month = base.year, base.month
            while True:
                max_day = cal_mod.monthrange(cur_year, cur_month)[1]
                day = min(rec_day, max_day)
                current = date(cur_year, cur_month, day)
                if current > r_end:
                    break
                if current >= view_start:
                    display_date = _adjust_to_weekday(current) if skip_weekend else current
                    if display_date >= view_start and display_date <= r_end:
                        instance = dict(ev)
                        instance["start_date"] = display_date.isoformat()
                        instance["description"] = clean_desc
                        instance["is_done"] = display_date.isoformat() in completed
                        instance["_recurring"] = True
                        expanded.append(instance)
                cur_month += interval
                if cur_month > 12:
                    cur_year += (cur_month - 1) // 12
                    cur_month = (cur_month - 1) % 12 + 1
        else:
            current = base
            while current <= r_end:
                display_date = _adjust_to_weekday(current) if skip_weekend else current
                if display_date >= view_start and display_date <= r_end:
                    instance = dict(ev)
                    instance["start_date"] = display_date.isoformat()
                    instance["description"] = clean_desc
                    instance["is_done"] = display_date.isoformat() in completed
                    instance["_recurring"] = True
                    expanded.append(instance)

                if rtype == "daily":
                    current += timedelta(days=interval)
                elif rtype == "weekly":
                    current += timedelta(weeks=interval)
                elif rtype == "monthly":
                    current += relativedelta(months=interval)
                elif rtype == "yearly":
                    current += relativedelta(years=interval)
                else:
                    break

    expanded.sort(key=lambda e: (e["start_date"], e.get("start_time") or ""))
    return expanded


@app.get("/api/holidays")
async def get_holidays(year: int):
    holidays = kr_year_holidays(str(year))
    return [{"date": h[0].isoformat(), "name": h[1]} for h in holidays]


@app.get("/api/events")
async def get_events(year: int, month: int, user=Depends(get_current_user)):
    db = get_supabase()
    view_start = date(year, month, 1)
    if month == 12:
        view_end = date(year + 1, 1, 1)
    else:
        view_end = date(year, month + 1, 1)

    start_str = view_start.isoformat()
    end_str = view_end.isoformat()

    result = (
        db.table("events")
        .select("*")
        .eq("user_id", user["sub"])
        .lt("start_date", end_str)
        .or_(f"start_date.gte.{start_str},recurrence_type.neq.null")
        .order("start_date")
        .order("start_time")
        .execute()
    )

    recurring_only = [e for e in result.data if e.get("recurrence_type")]
    non_recurring = [e for e in result.data if not e.get("recurrence_type")]

    all_events = _expand_recurring(recurring_only, view_start, view_end)
    seen_ids = {(x["id"], x["start_date"]) for x in all_events}
    for ev in non_recurring:
        if (ev["id"], ev["start_date"]) not in seen_ids:
            all_events.append(ev)

    all_events.sort(key=lambda e: (e["start_date"], e.get("start_time") or ""))
    return all_events


@app.post("/api/events")
async def create_event(req: EventCreate, user=Depends(get_current_user)):
    db = get_supabase()
    if req.client_id:
        _require_client_exists(req.client_id)
    data = {
        "user_id": user["sub"],
        "title": req.title,
        "start_date": req.start_date,
        "start_time": req.start_time,
        "end_date": req.end_date,
        "description": req.description,
        "color": req.color,
        "remind_minutes": req.remind_minutes,
        "recurrence_type": req.recurrence_type,
        "recurrence_end": req.recurrence_end,
        "recurrence_interval": req.recurrence_interval,
        "recurrence_day": req.recurrence_day,
        "is_task": req.is_task,
        "skip_weekend": req.skip_weekend,
        "client_id": req.client_id,
    }
    result = db.table("events").insert(data).execute()
    return result.data[0]


@app.put("/api/events/{event_id}")
async def update_event(
    event_id: str, req: EventUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = _explicit_model_data(req)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "client_id" in data and data["client_id"]:
        _require_client_exists(data["client_id"])

    if "description" in data and (req.recurrence_type or data.get("recurrence_type")):
        existing = (
            db.table("events")
            .select("description")
            .eq("id", event_id)
            .eq("user_id", user["sub"])
            .execute()
        )
        if existing.data:
            _, old_completed = _parse_completed_dates(
                existing.data[0].get("description")
            )
            if old_completed:
                data["description"] = _encode_completed_dates(
                    data.get("description"), old_completed
                )

    result = (
        db.table("events")
        .update(data)
        .eq("id", event_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Event not found")
    resp = dict(result.data[0])
    clean_desc, _ = _parse_completed_dates(resp.get("description"))
    resp["description"] = clean_desc
    return resp


@app.delete("/api/events/{event_id}")
async def delete_event(event_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("events")
        .delete()
        .eq("id", event_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"message": "Deleted"}


@app.patch("/api/events/{event_id}/done")
async def toggle_event_done(
    event_id: str, target_date: str = None, user=Depends(get_current_user)
):
    db = get_supabase()
    current = (
        db.table("events")
        .select("is_done,recurrence_type,description")
        .eq("id", event_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not current.data:
        raise HTTPException(status_code=404, detail="Event not found")

    row = current.data[0]
    if row.get("recurrence_type") and target_date:
        clean_desc, completed = _parse_completed_dates(row.get("description"))
        if target_date in completed:
            completed.discard(target_date)
        else:
            completed.add(target_date)
        new_desc = _encode_completed_dates(clean_desc, completed)
        result = (
            db.table("events")
            .update({"description": new_desc})
            .eq("id", event_id)
            .eq("user_id", user["sub"])
            .execute()
        )
        resp = dict(result.data[0])
        resp["is_done"] = target_date in completed
        resp["description"] = clean_desc
        return resp
    else:
        new_val = not row["is_done"]
        result = (
            db.table("events")
            .update({"is_done": new_val})
            .eq("id", event_id)
            .eq("user_id", user["sub"])
            .execute()
        )
        return result.data[0]


@app.get("/api/events/week")
async def get_week_tasks(date_str: str = None, user=Depends(get_current_user)):
    db = get_supabase()
    if date_str:
        ref = date.fromisoformat(date_str)
    else:
        ref = date.today()

    monday = ref - timedelta(days=ref.weekday())
    sunday = monday + timedelta(days=6)

    result = (
        db.table("events")
        .select("*")
        .eq("user_id", user["sub"])
        .eq("is_task", True)
        .lte("start_date", sunday.isoformat())
        .or_(f"start_date.gte.{monday.isoformat()},recurrence_type.neq.null")
        .order("start_date")
        .order("start_time")
        .execute()
    )

    recurring = [e for e in result.data if e.get("recurrence_type")]
    non_recurring = [
        e for e in result.data
        if not e.get("recurrence_type")
        and e["start_date"] >= monday.isoformat()
    ]

    expanded = _expand_recurring(recurring, monday, sunday + timedelta(days=1))
    week_tasks = [
        e for e in expanded
        if monday.isoformat() <= e["start_date"] <= sunday.isoformat()
    ]

    seen = {(e["id"], e["start_date"]) for e in week_tasks}
    for ev in non_recurring:
        if (ev["id"], ev["start_date"]) not in seen:
            week_tasks.append(ev)

    week_tasks.sort(key=lambda e: (e["start_date"], e.get("start_time") or ""))
    return week_tasks


# ?? Teams (Admin) ??


@app.get("/api/admin/teams")
async def list_teams(admin=Depends(get_admin_user)):
    db = get_supabase()
    result = db.table("teams").select("*").order("created_at").execute()
    return result.data


@app.post("/api/admin/teams")
async def create_team(req: TeamCreate, admin=Depends(get_admin_user)):
    db = get_supabase()
    data = {"name": req.name}
    if req.description:
        data["description"] = req.description
    result = db.table("teams").insert(data).execute()
    return result.data[0]


@app.put("/api/admin/teams/{team_id}")
async def update_team(team_id: str, req: TeamUpdate, admin=Depends(get_admin_user)):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = db.table("teams").update(data).eq("id", team_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Team not found")
    return result.data[0]


@app.delete("/api/admin/teams/{team_id}")
async def delete_team(team_id: str, admin=Depends(get_admin_user)):
    db = get_supabase()
    result = db.table("teams").delete().eq("id", team_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Team not found")
    return {"message": "Deleted"}


@app.patch("/api/admin/users/{user_id}/team")
async def assign_user_team(user_id: str, req: dict, admin=Depends(get_admin_user)):
    db = get_supabase()
    team_id = req.get("team_id")

    if team_id:
        team = db.table("teams").select("id").eq("id", team_id).execute()
        if not team.data:
            raise HTTPException(status_code=404, detail="Team not found")

    updated = db.table("users").update({"team_id": team_id}).eq("id", user_id).execute()
    if not updated.data:
        raise HTTPException(status_code=404, detail="User not found")

    return {"message": "Team assigned"}


# ?? Clients (嫄곕옒泥? ??


def _get_fernet():
    from cryptography.fernet import Fernet
    import base64, hashlib

    key = os.getenv("ENCRYPTION_KEY")
    if not key:
        jwt_secret = os.getenv("JWT_SECRET")
        if not jwt_secret:
            raise RuntimeError("Missing JWT_SECRET for encryption key derivation")
        derived = hashlib.sha256(jwt_secret.encode()).digest()
        key = base64.urlsafe_b64encode(derived).decode()
    return Fernet(key.encode() if isinstance(key, str) else key)


def _encrypt(text: str) -> str:
    if not text:
        return ""
    return _get_fernet().encrypt(text.encode()).decode()


def _decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _get_fernet().decrypt(token.encode()).decode()
    except Exception:
        return ""


@app.get("/api/clients")
async def list_clients(user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("clients")
        .select("*")
        .order("sort_order")
        .order("name")
        .execute()
    )
    return [_serialize_client_row(row) for row in result.data]


@app.get("/api/clients/{client_id}")
async def get_client(client_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("clients")
        .select("*")
        .eq("id", client_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return _serialize_client_row(result.data[0], include_password=True)


@app.post("/api/clients")
async def create_client(req: ClientCreate, user=Depends(get_current_user)):
    db = get_supabase()
    status = _normalize_client_status(req.status)
    data = {
        "name": req.name,
        "status": status,
        "owner_name": req.owner_name or None,
        "phone": req.phone or None,
        "email": req.email or None,
        "gyeongli_id": req.gyeongli_id or "",
        "gyeongli_pw_encrypted": _encrypt(req.gyeongli_pw or ""),
        "memo": req.memo or "",
        "last_contact_at": req.last_contact_at,
        "next_action_title": req.next_action_title or None,
        "next_action_at": req.next_action_at,
        "sort_order": req.sort_order if req.sort_order is not None else _get_next_client_sort_order(),
    }
    result = db.table("clients").insert(data).execute()
    return _serialize_client_row(result.data[0])


@app.put("/api/clients/{client_id}")
async def update_client(
    client_id: str, req: ClientUpdate, user=Depends(get_current_user)
):
    _require_client_exists(client_id)
    db = get_supabase()
    raw = _explicit_model_data(req)
    data = {}
    if "name" in raw:
        data["name"] = raw["name"]
    if "status" in raw:
        data["status"] = _normalize_client_status(raw["status"])
    if "owner_name" in raw:
        data["owner_name"] = raw["owner_name"] or None
    if "phone" in raw:
        data["phone"] = raw["phone"] or None
    if "email" in raw:
        data["email"] = raw["email"] or None
    if "gyeongli_id" in raw:
        data["gyeongli_id"] = raw["gyeongli_id"] or ""
    if "gyeongli_pw" in raw:
        data["gyeongli_pw_encrypted"] = _encrypt(raw["gyeongli_pw"] or "")
    if "memo" in raw:
        data["memo"] = raw["memo"] or ""
    if "last_contact_at" in raw:
        data["last_contact_at"] = raw["last_contact_at"]
    if "next_action_title" in raw:
        data["next_action_title"] = raw["next_action_title"] or None
    if "next_action_at" in raw:
        data["next_action_at"] = raw["next_action_at"]
    if "sort_order" in raw:
        data["sort_order"] = raw["sort_order"]
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = (
        db.table("clients")
        .update(data)
        .eq("id", client_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return _serialize_client_row(result.data[0])


@app.patch("/api/clients/reorder")
async def reorder_clients(req: ClientReorderRequest, user=Depends(get_current_user)):
    db = get_supabase()
    for item in req.items:
        db.table("clients").update({"sort_order": item["sort_order"]}).eq(
            "id", item["id"]
        ).execute()
    return {"message": "Reordered"}


@app.delete("/api/clients/{client_id}")
async def delete_client(client_id: str, user=Depends(get_current_user)):
    _require_client_exists(client_id)
    db = get_supabase()
    db.table("bookmarks").update({"client_id": None}).eq("client_id", client_id).execute()
    db.table("events").update({"client_id": None}).eq("client_id", client_id).execute()
    db.table("memos").update({"client_id": None}).eq("client_id", client_id).execute()
    try:
        db.table("client_shortcuts").delete().eq("client_id", client_id).execute()
    except Exception:
        pass
    result = (
        db.table("clients")
        .delete()
        .eq("id", client_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return {"message": "Deleted"}


@app.get("/api/clients/{client_id}/timeline")
async def get_client_timeline(client_id: str, user=Depends(get_current_user)):
    _require_client_exists(client_id)
    db = get_supabase()
    uid = user["sub"]

    own_bookmarks = (
        db.table("bookmarks")
        .select("*")
        .eq("client_id", client_id)
        .eq("user_id", uid)
        .order("created_at", desc=True)
        .execute()
    )
    shared_bookmarks = (
        db.table("bookmarks")
        .select("*")
        .eq("client_id", client_id)
        .eq("is_shared", True)
        .neq("user_id", uid)
        .order("created_at", desc=True)
        .execute()
    )
    events = (
        db.table("events")
        .select("*")
        .eq("client_id", client_id)
        .eq("user_id", uid)
        .order("start_date", desc=True)
        .order("start_time", desc=True)
        .execute()
    )
    memos = (
        db.table("memos")
        .select("*")
        .eq("client_id", client_id)
        .eq("user_id", uid)
        .order("updated_at", desc=True)
        .execute()
    )

    items = []
    for bookmark in [*own_bookmarks.data, *shared_bookmarks.data]:
        updated_at = _timeline_timestamp(bookmark, "updated_at", "created_at")
        items.append(
            {
                "id": f"bookmark:{bookmark['id']}",
                "entity_type": "bookmark",
                "action": "created",
                "label": "북마크 등록",
                "title": bookmark.get("title") or "북마크",
                "description": bookmark.get("url") or "",
                "occurred_at": updated_at,
                "related_id": bookmark["id"],
                "is_shared": bool(bookmark.get("is_shared")),
            }
        )

    for memo in memos.data:
        created_at = memo.get("created_at")
        updated_at = memo.get("updated_at") or created_at
        is_updated = bool(created_at and updated_at and created_at != updated_at)
        items.append(
            {
                "id": f"memo:{memo['id']}",
                "entity_type": "memo",
                "action": "updated" if is_updated else "created",
                "label": "메모 수정" if is_updated else "메모 작성",
                "title": memo.get("title") or "메모",
                "description": memo.get("content") or "",
                "occurred_at": updated_at or created_at or "",
                "related_id": memo["id"],
            }
        )

    for event in events.data:
        occurred_at = _timeline_timestamp(event, "updated_at", "created_at")
        items.append(
            {
                "id": f"event:{event['id']}",
                "entity_type": "event",
                "action": "completed" if event.get("is_done") else "created",
                "label": "업무 완료"
                if event.get("is_done") and event.get("is_task")
                else "일정 생성",
                "title": event.get("title") or "일정",
                "description": event.get("description") or "",
                "occurred_at": occurred_at,
                "related_id": event["id"],
                "start_date": event.get("start_date"),
                "start_time": event.get("start_time"),
                "is_task": bool(event.get("is_task")),
                "is_done": bool(event.get("is_done")),
            }
        )

    items.sort(key=lambda item: item.get("occurred_at") or "", reverse=True)
    return items[:100]


@app.get("/api/clients/{client_id}/events")
async def get_client_events(client_id: str, user=Depends(get_current_user)):
    _require_client_exists(client_id)
    db = get_supabase()
    result = (
        db.table("events")
        .select("*")
        .eq("client_id", client_id)
        .eq("user_id", user["sub"])
        .order("start_date", desc=True)
        .execute()
    )
    return result.data


# ?? Client Shortcuts ??


@app.get("/api/clients/{client_id}/shortcuts")
async def list_shortcuts(client_id: str, user=Depends(get_current_user)):
    _require_client_exists(client_id)
    db = get_supabase()
    result = (
        db.table("client_shortcuts")
        .select("*")
        .eq("client_id", client_id)
        .order("sort_order")
        .execute()
    )
    return result.data


@app.post("/api/clients/{client_id}/shortcuts")
async def create_shortcut(
    client_id: str, req: ShortcutCreate, user=Depends(get_current_user)
):
    _require_client_exists(client_id)
    db = get_supabase()
    data = {
        "client_id": client_id,
        "title": req.title,
        "url": req.url,
        "icon": req.icon,
        "sort_order": req.sort_order,
    }
    result = db.table("client_shortcuts").insert(data).execute()
    return result.data[0]


@app.put("/api/clients/{client_id}/shortcuts/{shortcut_id}")
async def update_shortcut(
    client_id: str,
    shortcut_id: str,
    req: ShortcutUpdate,
    user=Depends(get_current_user),
):
    _require_client_exists(client_id)
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = (
        db.table("client_shortcuts")
        .update(data)
        .eq("id", shortcut_id)
        .eq("client_id", client_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Shortcut not found")
    return result.data[0]


@app.delete("/api/clients/{client_id}/shortcuts/{shortcut_id}")
async def delete_shortcut(
    client_id: str, shortcut_id: str, user=Depends(get_current_user)
):
    _require_client_exists(client_id)
    db = get_supabase()
    result = (
        db.table("client_shortcuts")
        .delete()
        .eq("id", shortcut_id)
        .eq("client_id", client_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Shortcut not found")
    return {"message": "Deleted"}


# ?? Memos ??


@app.get("/api/memos")
async def get_memos(user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("memos")
        .select("*")
        .eq("user_id", user["sub"])
        .order("is_pinned", desc=True)
        .order("updated_at", desc=True)
        .execute()
    )
    return result.data


@app.post("/api/memos")
async def create_memo(req: MemoCreate, user=Depends(get_current_user)):
    db = get_supabase()
    if req.client_id:
        _require_client_exists(req.client_id)
    data = {
        "user_id": user["sub"],
        "title": req.title,
        "content": req.content,
        "color": req.color,
        "client_id": req.client_id,
    }
    result = db.table("memos").insert(data).execute()
    return result.data[0]


@app.put("/api/memos/{memo_id}")
async def update_memo(
    memo_id: str, req: MemoUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = _explicit_model_data(req)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    if data.get("client_id"):
        _require_client_exists(data["client_id"])
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = (
        db.table("memos")
        .update(data)
        .eq("id", memo_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Memo not found")
    return result.data[0]


@app.delete("/api/memos/{memo_id}")
async def delete_memo(memo_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("memos")
        .delete()
        .eq("id", memo_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Memo not found")
    return {"message": "Deleted"}


@app.patch("/api/memos/{memo_id}/pin")
async def toggle_pin_memo(memo_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    current = (
        db.table("memos")
        .select("is_pinned")
        .eq("id", memo_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not current.data:
        raise HTTPException(status_code=404, detail="Memo not found")
    new_val = not current.data[0]["is_pinned"]
    result = (
        db.table("memos")
        .update({"is_pinned": new_val})
        .eq("id", memo_id)
        .execute()
    )
    return result.data[0]
