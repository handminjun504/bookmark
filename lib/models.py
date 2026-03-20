from pydantic import BaseModel
from typing import Any, Dict, Optional


class LoginRequest(BaseModel):
    username: str
    password: str
    remember_device: bool = False
    device_name: str = ""


class AutoLoginRequest(BaseModel):
    device_token: str


class BookmarkCreate(BaseModel):
    title: str
    url: str
    description: str = ""
    category_id: Optional[str] = None
    service_type: str = "web"
    health_check_url: Optional[str] = None
    icon_url: Optional[str] = None
    is_shared: bool = False
    open_mode: str = "auto"
    is_pinned: bool = False
    client_id: Optional[str] = None


class BookmarkUpdate(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[str] = None
    service_type: Optional[str] = None
    health_check_url: Optional[str] = None
    icon_url: Optional[str] = None
    is_shared: Optional[bool] = None
    open_mode: Optional[str] = None
    is_pinned: Optional[bool] = None
    client_id: Optional[str] = None


class ReorderRequest(BaseModel):
    items: list


class CategoryCreate(BaseModel):
    name: str
    icon: str = "\U0001f4c1"


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: str
    display_name: str
    team_id: Optional[str] = None
    subteam_name: Optional[str] = None


class SettingsUpdate(BaseModel):
    pin_code: Optional[str] = None
    lock_enabled: Optional[bool] = None
    lock_timeout: Optional[int] = None
    display_name: Optional[str] = None


class UserPreferencesUpdate(BaseModel):
    client_view_state: Optional[Dict[str, Any]] = None
    client_custom_view: Optional[Dict[str, Any]] = None
    url_notes: Optional[Dict[str, str]] = None


class SetupRequest(BaseModel):
    username: str
    password: str
    display_name: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class EventCreate(BaseModel):
    title: str
    start_date: str
    start_time: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    color: str = "#4DA8DA"
    remind_minutes: Optional[int] = None
    recurrence_type: Optional[str] = None
    recurrence_end: Optional[str] = None
    recurrence_interval: int = 1
    recurrence_day: Optional[int] = None
    recurrence_weekdays: Optional[list[str]] = None
    is_task: bool = False
    skip_weekend: bool = False
    calendar_type: Optional[str] = None
    share_with_team: Optional[bool] = None
    client_id: Optional[str] = None


class EventUpdate(BaseModel):
    title: Optional[str] = None
    start_date: Optional[str] = None
    start_time: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    remind_minutes: Optional[int] = None
    recurrence_type: Optional[str] = None
    recurrence_end: Optional[str] = None
    recurrence_interval: Optional[int] = None
    recurrence_day: Optional[int] = None
    recurrence_weekdays: Optional[list[str]] = None
    is_task: Optional[bool] = None
    skip_weekend: Optional[bool] = None
    calendar_type: Optional[str] = None
    share_with_team: Optional[bool] = None
    client_id: Optional[str] = None


class MemoCreate(BaseModel):
    title: str = ""
    content: str = ""
    color: str = "#FFFFFF"
    client_id: Optional[str] = None


class MemoUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    is_pinned: Optional[bool] = None
    client_id: Optional[str] = None


class TeamCreate(BaseModel):
    name: str
    description: Optional[str] = None


class TeamUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class ClientCreate(BaseModel):
    name: str
    status: str = "active"
    client_category: Optional[str] = None
    owner_name: Optional[str] = None
    company_contact_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    memo: Optional[str] = None
    last_contact_at: Optional[str] = None
    next_action_title: Optional[str] = None
    next_action_at: Optional[str] = None
    sort_order: Optional[int] = None
    client_code: Optional[str] = None
    business_number: Optional[str] = None
    ceo_name: Optional[str] = None
    approval_number: Optional[str] = None
    incorporation_registry_date: Optional[str] = None
    fund_corporate_name: Optional[str] = None
    parent_company_name: Optional[str] = None
    gyeongli_id: Optional[str] = None
    gyeongli_pw: Optional[str] = None
    gyeongli_password: Optional[str] = None
    sheet_row_number: Optional[int] = None
    sheet_extra_fields: Optional[Dict[str, Any]] = None
    source_active: Optional[bool] = None
    hidden_local: Optional[bool] = None
    hidden_local_at: Optional[str] = None
    last_synced_at: Optional[str] = None


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    client_category: Optional[str] = None
    owner_name: Optional[str] = None
    company_contact_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    memo: Optional[str] = None
    last_contact_at: Optional[str] = None
    next_action_title: Optional[str] = None
    next_action_at: Optional[str] = None
    sort_order: Optional[int] = None
    client_code: Optional[str] = None
    business_number: Optional[str] = None
    ceo_name: Optional[str] = None
    approval_number: Optional[str] = None
    incorporation_registry_date: Optional[str] = None
    fund_corporate_name: Optional[str] = None
    parent_company_name: Optional[str] = None
    gyeongli_id: Optional[str] = None
    gyeongli_pw: Optional[str] = None
    gyeongli_password: Optional[str] = None
    sheet_row_number: Optional[int] = None
    sheet_extra_fields: Optional[Dict[str, Any]] = None
    source_active: Optional[bool] = None
    hidden_local: Optional[bool] = None
    hidden_local_at: Optional[str] = None
    last_synced_at: Optional[str] = None


class ClientReorderRequest(BaseModel):
    items: list


class ShortcutCreate(BaseModel):
    title: str
    url: str
    icon: str = ""
    sort_order: int = 0


class ShortcutUpdate(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None
