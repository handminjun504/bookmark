import sys
import os
import traceback
from datetime import datetime, timezone, date, timedelta
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
    SetupRequest,
    PasswordChange,
    EventCreate,
    EventUpdate,
    MemoCreate,
    MemoUpdate,
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"[ERROR] {request.url}: {exc}\n{tb}", file=sys.stderr, flush=True)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal error: {str(exc)}"},
    )


@app.get("/api/ping")
async def ping():
    return {"status": "ok", "supabase_url": os.getenv("SUPABASE_URL", "NOT SET")[:30]}


# ── Dependencies ──


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


# ── Setup (first-time admin creation) ──


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


# ── Auth ──


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
        },
    }


# ── Bookmarks ──


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
    }
    result = db.table("bookmarks").insert(data).execute()
    return result.data[0]


@app.put("/api/bookmarks/{bookmark_id}")
async def update_bookmark(
    bookmark_id: str, req: BookmarkUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "is_shared" in data and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Only admins can change shared status")

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


# ── Categories ──


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


# ── Embed Check ──


@app.get("/api/check-embeddable")
async def check_embeddable(url: str, user=Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(
            timeout=3.0, follow_redirects=True, verify=False
        ) as client:
            resp = await client.head(url)
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


# ── Health Check ──


@app.get("/api/health/{bookmark_id}")
async def check_health(bookmark_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    result = (
        db.table("bookmarks")
        .select("health_check_url, url")
        .eq("id", bookmark_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Bookmark not found")

    bm = result.data[0]
    check_url = bm.get("health_check_url") or bm["url"]

    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            resp = await client.get(check_url)
            status = "online" if resp.status_code < 500 else "error"
            return {"status": status, "code": resp.status_code}
    except Exception:
        return {"status": "offline", "code": None}


@app.post("/api/health/batch")
async def batch_health_check(req: dict, user=Depends(get_current_user)):
    import asyncio

    urls = req.get("urls", {})
    results = {}

    async def _check(bid: str, url: str):
        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as c:
                resp = await c.get(url)
                status = "online" if resp.status_code < 500 else "error"
                results[bid] = {"status": status, "code": resp.status_code}
        except Exception:
            results[bid] = {"status": "offline", "code": None}

    await asyncio.gather(*[_check(bid, url) for bid, url in urls.items()])
    return results


# ── User Settings ──


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


# ── Admin ──


@app.get("/api/admin/users")
async def list_users(admin=Depends(get_admin_user)):
    db = get_supabase()
    result = (
        db.table("users")
        .select("id, username, display_name, is_admin, created_at")
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

    result = (
        db.table("users")
        .insert(
            {
                "username": req.username,
                "password_hash": hash_password(req.password),
                "display_name": req.display_name,
            }
        )
        .execute()
    )
    return {"id": result.data[0]["id"], "username": req.username, "display_name": req.display_name}


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
    new_password = req.get("new_password", "0000")
    db.table("users").update({"password_hash": hash_password(new_password)}).eq(
        "id", user_id
    ).execute()
    return {"message": "Password reset", "new_password": new_password}


# ── Events (Calendar) ──


def _adjust_to_weekday(d):
    """주말(토/일) 또는 한국 공휴일이면 직전 평일로 이동"""
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

    single = (
        db.table("events")
        .select("*")
        .eq("user_id", user["sub"])
        .gte("start_date", start_str)
        .lt("start_date", end_str)
        .order("start_date")
        .order("start_time")
        .execute()
    )

    recurring = (
        db.table("events")
        .select("*")
        .eq("user_id", user["sub"])
        .lt("start_date", end_str)
        .execute()
    )
    recurring_only = [e for e in recurring.data if e.get("recurrence_type")]

    non_recurring = [e for e in single.data if not e.get("recurrence_type")]
    all_events = _expand_recurring(recurring_only, view_start, view_end)
    for ev in non_recurring:
        if not any(x["id"] == ev["id"] and x["start_date"] == ev["start_date"] for x in all_events):
            all_events.append(ev)

    all_events.sort(key=lambda e: (e["start_date"], e.get("start_time") or ""))
    return all_events


@app.post("/api/events")
async def create_event(req: EventCreate, user=Depends(get_current_user)):
    db = get_supabase()
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
    }
    result = db.table("events").insert(data).execute()
    return result.data[0]


@app.put("/api/events/{event_id}")
async def update_event(
    event_id: str, req: EventUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = (
        db.table("events")
        .update(data)
        .eq("id", event_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Event not found")
    return result.data[0]


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
async def toggle_event_done(event_id: str, user=Depends(get_current_user)):
    db = get_supabase()
    current = (
        db.table("events")
        .select("is_done")
        .eq("id", event_id)
        .eq("user_id", user["sub"])
        .execute()
    )
    if not current.data:
        raise HTTPException(status_code=404, detail="Event not found")
    new_val = not current.data[0]["is_done"]
    result = (
        db.table("events")
        .update({"is_done": new_val})
        .eq("id", event_id)
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
        .gte("start_date", monday.isoformat())
        .lte("start_date", sunday.isoformat())
        .order("start_date")
        .order("start_time")
        .execute()
    )
    return result.data


# ── Memos ──


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
    data = {
        "user_id": user["sub"],
        "title": req.title,
        "content": req.content,
        "color": req.color,
    }
    result = db.table("memos").insert(data).execute()
    return result.data[0]


@app.put("/api/memos/{memo_id}")
async def update_memo(
    memo_id: str, req: MemoUpdate, user=Depends(get_current_user)
):
    db = get_supabase()
    data = {k: v for k, v in req.model_dump().items() if v is not None}
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
