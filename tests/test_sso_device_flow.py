from __future__ import annotations

import unittest
from unittest.mock import patch

from grok2api.upstream.sso_device_flow import exchange_sso_for_token


class _Cookies:
    def __init__(self) -> None:
        self.values: list[tuple[str, str, str]] = []

    def set(self, name: str, value: str, *, domain: str) -> None:
        self.values.append((name, value, domain))


class _Response:
    def __init__(self, url: str, payload: dict | None = None, *, ok: bool = True) -> None:
        self.url = url
        self._payload = payload or {}
        self.ok = ok
        self.status_code = 200 if ok else 400

    def json(self) -> dict:
        return self._payload


class _Session:
    def __init__(self, *, fail_first_token: bool = False) -> None:
        self.cookies = _Cookies()
        self.fail_first_token = fail_first_token
        self.token_calls = 0
        self.device_request: dict = {}
        self.token_request: dict = {}

    def get(self, url: str, **_kwargs) -> _Response:
        if url == "https://accounts.x.ai/":
            return _Response(url)
        return _Response(url)

    def post(self, url: str, **kwargs) -> _Response:
        if url.endswith("/device/code"):
            self.device_request = kwargs
            return _Response(url, {
                "device_code": "device-secret",
                "user_code": "AB-CD",
                "verification_uri_complete": "https://auth.x.ai/verify?code=AB-CD",
                "interval": 1,
            })
        if url.endswith("/device/verify"):
            return _Response("https://auth.x.ai/oauth2/device/consent")
        if url.endswith("/device/approve"):
            return _Response("https://auth.x.ai/oauth2/device/done")
        if url.endswith("/oauth2/token"):
            self.token_request = kwargs
            self.token_calls += 1
            if self.fail_first_token and self.token_calls == 1:
                return _Response(url, {"error": "invalid_grant"}, ok=False)
            return _Response(url, {"access_token": "access-secret", "refresh_token": "refresh-secret"})
        raise AssertionError(f"unexpected POST {url}")


class SsoDeviceFlowTests(unittest.TestCase):
    def test_exchanges_sso_with_browser_session(self) -> None:
        session = _Session()
        token = exchange_sso_for_token("sso-secret", session=session)
        self.assertEqual(token["access_token"], "access-secret")
        self.assertIn(("sso", "sso-secret", ".x.ai"), session.cookies.values)
        self.assertIn(("sso-rw", "sso-secret", "accounts.x.ai"), session.cookies.values)
        self.assertEqual(session.device_request["data"]["referrer"], "grok-build")
        self.assertIn("workspaces:read", session.device_request["data"]["scope"])
        self.assertEqual(session.device_request["headers"]["x-grok-client-surface"], "cli")
        self.assertTrue(session.device_request["headers"]["x-grok-client-version"])
        self.assertEqual(session.token_request["headers"]["x-grok-client-surface"], "cli")

    @patch("grok2api.upstream.sso_device_flow.time.sleep", return_value=None)
    def test_restarts_device_flow_after_propagation_invalid_grant(self, _sleep) -> None:
        session = _Session(fail_first_token=True)
        token = exchange_sso_for_token("sso-secret", session=session)
        self.assertEqual(token["access_token"], "access-secret")
        self.assertEqual(session.token_calls, 2)


if __name__ == "__main__":
    unittest.main()
