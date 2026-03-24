from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
import bcrypt
from lib.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRATION_HOURS
import secrets


def hash_password(password: str) -> str:
    pw = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    pw = plain.encode("utf-8")[:72]
    try:
        return bcrypt.checkpw(pw, hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(
    user_id: str,
    username: str,
    is_admin: bool,
    team_id: str | None = None,
    subteam_name: str | None = None,
) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRATION_HOURS)
    payload = {
        "sub": user_id,
        "username": username,
        "is_admin": is_admin,
        "exp": expire,
    }
    if team_id is not None:
        payload["team_id"] = team_id
    if subteam_name is not None:
        payload["subteam_name"] = subteam_name
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return None


def generate_device_token() -> str:
    return secrets.token_urlsafe(64)
