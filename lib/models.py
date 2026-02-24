from pydantic import BaseModel
from typing import Optional


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


class BookmarkUpdate(BaseModel):
    title: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[str] = None
    service_type: Optional[str] = None
    health_check_url: Optional[str] = None
    icon_url: Optional[str] = None


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


class SettingsUpdate(BaseModel):
    pin_code: Optional[str] = None
    lock_enabled: Optional[bool] = None
    lock_timeout: Optional[int] = None
    display_name: Optional[str] = None


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


class EventUpdate(BaseModel):
    title: Optional[str] = None
    start_date: Optional[str] = None
    start_time: Optional[str] = None
    end_date: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    remind_minutes: Optional[int] = None


class MemoCreate(BaseModel):
    title: str = ""
    content: str = ""
    color: str = "#FFFFFF"


class MemoUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    is_pinned: Optional[bool] = None
