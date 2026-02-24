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
