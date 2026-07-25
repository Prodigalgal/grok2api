"""Convert an xAI SSO cookie to OAuth tokens through the legacy device flow."""
from __future__ import annotations

import os
import time
from typing import Any


ISSUER = "https://auth.x.ai"
CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
DEFAULT_SCOPES = (
    "openid profile email offline_access grok-cli:access api:access "
    "conversations:read conversations:write workspaces:read workspaces:write"
)


def _grok_headers() -> dict[str, str]:
    return {
        "x-grok-client-version": os.environ.get("GROK2API_GROK_CLIENT_VERSION", "0.2.112").strip() or "0.2.112",
        "x-grok-client-surface": "cli",
    }


def exchange_sso_for_token(
    sso: str,
    *,
    proxy: str = "",
    session: Any | None = None,
    attempts: int = 6,
) -> dict[str, Any]:
    """Use a curl_cffi browser session to approve an OAuth device request."""
    cookie = str(sso or "").strip()
    if not cookie:
        raise ValueError("SSO cookie is required")
    if session is None:
        from curl_cffi import requests

        kwargs: dict[str, Any] = {"impersonate": "chrome131"}
        if proxy:
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        session = requests.Session(**kwargs)
    for name in ("sso", "sso-rw"):
        for domain in (".x.ai", "accounts.x.ai"):
            session.cookies.set(name, cookie, domain=domain)

    timeout = max(10.0, float(os.environ.get("GROK2API_SSO_HTTP_TIMEOUT", "30") or 30))
    home = session.get("https://accounts.x.ai/", timeout=timeout, allow_redirects=True)
    if "sign-in" in str(home.url or "") or "sign-up" in str(home.url or ""):
        raise RuntimeError("protocol SSO cookie was rejected")
    scopes = os.environ.get("GROK2API_OIDC_SCOPES", DEFAULT_SCOPES).strip()
    max_attempts = max(1, min(12, int(attempts)))
    last_error = "device flow did not start"
    for attempt in range(1, max_attempts + 1):
        try:
            device = session.post(
                f"{ISSUER}/oauth2/device/code",
                data={"client_id": CLIENT_ID, "scope": scopes, "referrer": "grok-build"},
                headers={"content-type": "application/x-www-form-urlencoded", **_grok_headers()},
                timeout=timeout,
            )
            payload = _object_json(device)
            device_code = str(payload.get("device_code") or "")
            user_code = str(payload.get("user_code") or "")
            verification_url = str(
                payload.get("verification_uri_complete")
                or payload.get("verification_uri")
                or ""
            )
            if not getattr(device, "ok", False) or not device_code or not user_code or not verification_url:
                raise RuntimeError(_response_error(device, payload, "device code rejected"))

            session.get(verification_url, timeout=timeout, allow_redirects=True)
            verification = session.post(
                f"{ISSUER}/oauth2/device/verify",
                data={"user_code": user_code},
                headers={"content-type": "application/x-www-form-urlencoded"},
                timeout=timeout,
                allow_redirects=True,
            )
            if not getattr(verification, "ok", False) or "consent" not in str(verification.url or ""):
                raise RuntimeError(_response_error(verification, {}, "device verification rejected"))

            approval = session.post(
                f"{ISSUER}/oauth2/device/approve",
                data={
                    "user_code": user_code,
                    "action": "allow",
                    "principal_type": "User",
                    "principal_id": "",
                },
                headers={"content-type": "application/x-www-form-urlencoded"},
                timeout=timeout,
                allow_redirects=True,
            )
            if not getattr(approval, "ok", False) or "done" not in str(approval.url or ""):
                raise RuntimeError(_response_error(approval, {}, "device approval rejected"))

            token = _poll_token(
                session,
                device_code,
                interval=float(payload.get("interval") or 1),
                timeout=timeout,
            )
            if token:
                return token
            last_error = "device token polling timed out"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            if not _retryable(last_error) or attempt >= max_attempts:
                break
        if "invalid_grant" in last_error.lower():
            time.sleep(min(60.0, 15.0 * attempt))
        else:
            time.sleep(min(20.0, 1.5 * (1.6 ** (attempt - 1))))
    raise RuntimeError(f"legacy SSO device flow failed: {last_error}")


def _poll_token(session: Any, device_code: str, *, interval: float, timeout: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + max(30.0, float(os.environ.get("GROK2API_SSO_POLL_TIMEOUT", "60") or 60))
    delay = max(0.5, min(2.0, interval))
    while time.monotonic() < deadline:
        response = session.post(
            f"{ISSUER}/oauth2/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
            },
            headers={"content-type": "application/x-www-form-urlencoded", **_grok_headers()},
            timeout=timeout,
        )
        payload = _object_json(response)
        if getattr(response, "ok", False) and str(payload.get("access_token") or ""):
            return payload
        error = str(payload.get("error") or "")
        if error == "slow_down":
            delay = min(10.0, delay + 1.0)
        elif error != "authorization_pending":
            raise RuntimeError(_response_error(response, payload, "device token rejected"))
        time.sleep(delay)
    return None


def _object_json(response: Any) -> dict[str, Any]:
    try:
        value = response.json()
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _response_error(response: Any, payload: dict[str, Any], fallback: str) -> str:
    error = str(payload.get("error") or payload.get("error_description") or "").strip()
    status = int(getattr(response, "status_code", 0) or 0)
    return f"{fallback}: {error or f'HTTP {status}'}"


def _retryable(message: str) -> bool:
    value = message.lower()
    return any(term in value for term in ("429", "rate", "slow_down", "invalid_grant", "timeout", "temporar", "network"))
