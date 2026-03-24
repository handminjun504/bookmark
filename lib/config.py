import os
from dotenv import load_dotenv

load_dotenv()


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

DATA_BACKEND = "gl"
GL_MCP_URL = _required_env("GL_MCP_URL").strip()
GL_MCP_TOKEN = _required_env("GL_MCP_TOKEN").strip()
JWT_SECRET = _required_env("JWT_SECRET")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24
