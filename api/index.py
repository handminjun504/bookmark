import sys
import os
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException, Depends, Header
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
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    data = {
        "user_id": user["sub"],
        "title": req.title,
        "url": req.url,
        "description": req.description,
        "category_id": req.category_id if req.category_id else None,
        "service_type": req.service_type,
        "health_check_url": req.health_check_url,
        "icon_url": req.icon_url,
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
