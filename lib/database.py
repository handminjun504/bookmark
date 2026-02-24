import httpx
from lib.config import SUPABASE_URL, SUPABASE_KEY


def _pg_value(val):
    """Convert Python value to PostgREST filter string."""
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    return str(val)


class SupabaseTable:
    """Lightweight Supabase PostgREST client using httpx (no heavy SDK)."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.rest_url = f"{self.base_url}/rest/v1"
        self.headers = {
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    def table(self, name: str):
        return QueryBuilder(self.rest_url, self.headers, name)


class QueryResult:
    def __init__(self, data):
        self.data = data


class QueryBuilder:
    def __init__(self, rest_url, headers, table):
        self._url = f"{rest_url}/{table}"
        self._headers = dict(headers)
        self._params = []
        self._method = "GET"
        self._body = None

    def select(self, columns="*"):
        self._params.append(("select", columns))
        self._method = "GET"
        return self

    def insert(self, data):
        self._body = data if isinstance(data, list) else data
        self._method = "POST"
        return self

    def update(self, data):
        self._body = data
        self._method = "PATCH"
        return self

    def delete(self):
        self._method = "DELETE"
        return self

    def eq(self, col, val):
        self._params.append((col, f"eq.{_pg_value(val)}"))
        return self

    def neq(self, col, val):
        self._params.append((col, f"neq.{_pg_value(val)}"))
        return self

    def gt(self, col, val):
        self._params.append((col, f"gt.{_pg_value(val)}"))
        return self

    def gte(self, col, val):
        self._params.append((col, f"gte.{_pg_value(val)}"))
        return self

    def lt(self, col, val):
        self._params.append((col, f"lt.{_pg_value(val)}"))
        return self

    def lte(self, col, val):
        self._params.append((col, f"lte.{_pg_value(val)}"))
        return self

    def is_(self, col, val):
        self._params.append((col, f"is.{_pg_value(val)}"))
        return self

    def order(self, col, desc=False):
        direction = "desc" if desc else "asc"
        for i, (k, v) in enumerate(self._params):
            if k == "order":
                self._params[i] = ("order", f"{v},{col}.{direction}")
                return self
        self._params.append(("order", f"{col}.{direction}"))
        return self

    def limit(self, count):
        self._headers["Range"] = f"0-{count - 1}"
        return self

    def execute(self):
        params = self._params
        with httpx.Client(timeout=15) as client:
            if self._method == "GET":
                r = client.get(self._url, headers=self._headers, params=params)
            elif self._method == "POST":
                r = client.post(self._url, headers=self._headers, params=params, json=self._body)
            elif self._method == "PATCH":
                r = client.patch(self._url, headers=self._headers, params=params, json=self._body)
            elif self._method == "DELETE":
                r = client.delete(self._url, headers=self._headers, params=params)
            else:
                raise ValueError(f"Unknown method: {self._method}")

        if r.status_code >= 400:
            raise Exception(f"Supabase error {r.status_code}: {r.text}")

        try:
            data = r.json()
        except Exception:
            data = []

        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            data = [data] if data else []

        return QueryResult(data)


_client = None


def get_supabase():
    global _client
    if _client is None:
        _client = SupabaseTable(SUPABASE_URL, SUPABASE_KEY)
    return _client
