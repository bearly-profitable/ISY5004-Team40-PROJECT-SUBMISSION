"""Who is calling: a signed-in Lumina user or an anonymous browser.

Signed-in requests carry the Supabase access token (``Authorization: Bearer``).
We verify it by asking Supabase Auth who it belongs to, which works for both
the legacy HS256 secret and the newer asymmetric signing keys, and cache the
answer briefly so a gallery session doesn't hit Supabase on every click.

Owner ids:
    "user:<supabase uuid>"   signed in
    "<X-Client-Id>"          anonymous (unprefixed, so the preferences stored
                             before accounts existed keep working)
"""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import HTTPException

_CACHE_SECONDS = 300
_cache: dict[str, tuple[str, float]] = {}
_cache_lock = threading.Lock()

# Anonymous ids are random strings minted by the browser (crypto.randomUUID).
# The charset excludes ":", so nobody can pose as "user:<uuid>" without a
# token that Supabase actually vouches for.
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def valid_client_id(client_id: Optional[str]) -> bool:
    return bool(client_id) and bool(_CLIENT_ID_RE.match(client_id))


def _config() -> tuple[str, str]:
    # Read per call: server.py loads .env after importing this module.
    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.getenv("SUPABASE_ANON_KEY") or "").strip()
    return url, key


def enabled() -> bool:
    return all(_config())


@dataclass(frozen=True)
class Owner:
    id: str
    user_id: Optional[str] = None  # Supabase uuid when signed in

    @property
    def signed_in(self) -> bool:
        return self.user_id is not None


def _verify(token: str) -> str:
    """Supabase user id for this access token, or 401."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(token)
        if hit and hit[1] > now:
            return hit[0]
    url, key = _config()
    try:
        resp = httpx.get(
            f"{url}/auth/v1/user",
            headers={"apikey": key, "Authorization": f"Bearer {token}"},
            timeout=8.0,
        )
    except httpx.HTTPError as exc:
        print(f"[Lumina] Supabase Auth unreachable: {exc}")
        raise HTTPException(status_code=503, detail="Could not verify your login right now.") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Your login has expired. Please sign in again.")
    user_id = str(resp.json().get("id") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid login token.")
    with _cache_lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[token] = (user_id, now + _CACHE_SECONDS)
    return user_id


def resolve_owner(
    authorization: Optional[str], client_id: Optional[str], required: bool = True,
) -> Optional[Owner]:
    """``required=False`` returns None for a caller with neither a login nor a
    client id (older clients, scripts), who then only sees ownerless data."""
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    # Without Supabase configured on this server, logins can't be checked, so
    # everyone is treated as anonymous rather than locked out.
    if token and enabled():
        user_id = _verify(token)
        return Owner(id=f"user:{user_id}", user_id=user_id)
    cid = (client_id or "").strip()
    if not cid and not required:
        return None
    if not cid:
        raise HTTPException(status_code=400, detail="X-Client-Id header is required.")
    if not valid_client_id(cid):
        raise HTTPException(status_code=400, detail="Invalid X-Client-Id header.")
    return Owner(id=cid)
