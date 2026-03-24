import os
from dotenv import load_dotenv

load_dotenv()


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

GL_MCP_URL = os.getenv("GL_MCP_URL", "").strip()
GL_MCP_TOKEN = os.getenv("GL_MCP_TOKEN", "").strip()
DATA_BACKEND = (os.getenv("DATA_BACKEND") or ("gl" if GL_MCP_URL and GL_MCP_TOKEN else "supabase")).strip().lower()

if DATA_BACKEND == "gl":
    SUPABASE_URL = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
else:
    SUPABASE_URL = _required_env("SUPABASE_URL")
    SUPABASE_KEY = _required_env("SUPABASE_KEY")

SUPABASE_DB_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or SUPABASE_KEY
JWT_SECRET = _required_env("JWT_SECRET")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24
