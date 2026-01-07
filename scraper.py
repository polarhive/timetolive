"""
PESU timetable scraper utilities.

This module contains the authentication and CSRF handling logic.
"""

from __future__ import annotations

import logging

# Use root logger so messages flow to Flask's console via root configuration
logger = logging.getLogger()
import time
import json
import re
from datetime import datetime
from typing import Optional

import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

# Optional: load .env.local first (if present), then fall back to .env
try:
    from dotenv import load_dotenv, find_dotenv  # type: ignore

    local_dotenv = find_dotenv(".env.local")
    if local_dotenv:
        load_dotenv(local_dotenv, override=False)
        logger.debug("Loaded environment from .env.local")
    else:
        # fallback to default .env if present
        default_dotenv = find_dotenv(".env")
        if default_dotenv:
            load_dotenv(default_dotenv, override=False)
            logger.debug("Loaded environment from .env")
except Exception:
    # dotenv is optional; ignore if not installed
    pass

from parser import AuthenticationError, TimetableScrapingError, build_schedule


class PESUTimetableScraper:
    BASE_URL = "https://www.pesuacademy.com/Academy"

    def __init__(self, username: str, password: str) -> None:
        self.session = requests.Session()
        # Provide browser-like defaults so the site responds with the same CSRF & cookies
        self.session.headers.update(
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }
        )
        self.username = username
        self.password = password
        self.csrf_token: Optional[str] = None

    def _extract_csrf_token(self, html_content: str) -> str:
        """
        Extract CSRF token from several possible locations:
        - <input name="_csrf" value="...">
        - <meta name="_csrf" content="..."> or common meta tokens
        - inline JS patterns or UUID-like tokens
        """
        soup = BeautifulSoup(html_content, "html.parser")

        # 1) standard hidden input
        csrf_input = soup.find("input", {"name": "_csrf"})
        if csrf_input and csrf_input.get("value"):
            return csrf_input.get("value")  # type: ignore

        # 2) meta tags
        for meta_name in ("_csrf", "csrf-token", "csrf"):
            m = soup.find("meta", {"name": meta_name})
            if m and m.get("content"):
                return m.get("content")  # type: ignore

        # 3) JS inline assignment e.g. _csrf = 'uuid' or "_csrf":"uuid"
        m = re.search(
            r"_csrf['\"]?\s*[:=]\s*['\"]([0-9a-fA-F-]{8,})['\"]", html_content
        )
        if m:
            return m.group(1)

        # 4) fallback: any UUID in page (common CSRF format observed)
        m2 = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            html_content,
            re.I,
        )
        if m2:
            return m2.group(1)

        raise AuthenticationError("CSRF token not found in response")

    def login(self) -> None:
        logger.debug("Initiating authentication")

        try:
            # GET initial page (login landing) and gather cookies + form
            login_page_url = f"{self.BASE_URL}/"
            r0 = self.session.get(login_page_url, allow_redirects=True, timeout=15)
            r0.raise_for_status()

            soup = BeautifulSoup(r0.text, "html.parser")
            # Find the login form (heuristic: form containing j_username or username field)
            form = None
            for f in soup.find_all("form"):
                if f.find("input", {"name": "j_username"}) or f.find(
                    "input", {"name": "username"}
                ):
                    form = f
                    break

            action = None
            if form and form.get("action"):
                action = form.get("action")
            else:
                action = "/j_spring_security_check"

            if action.startswith("http"):
                login_url = action
            else:
                login_url = urljoin(self.BASE_URL + "/", action.lstrip("/"))

            # Gather form hidden inputs (preserve any extra required fields)
            form_inputs = {}
            if form:
                for inp in form.find_all("input"):
                    name = inp.get("name")
                    if not name:
                        continue
                    if name in ("j_username", "j_password"):
                        continue
                    form_inputs[name] = inp.get("value", "")

            # Determine CSRF to use for login (form value > page token > cookie > existing)
            form_csrf = form_inputs.get("_csrf")
            page_csrf = None
            try:
                page_csrf = self._extract_csrf_token(r0.text)
            except AuthenticationError:
                page_csrf = None

            if form_csrf:
                csrf_token = form_csrf
                csrf_source = "form"
            elif page_csrf:
                csrf_token = page_csrf
                csrf_source = "html"
            else:
                # cookie-based fallback
                csrf_token = self.session.cookies.get(
                    "XSRF-TOKEN"
                ) or self.session.cookies.get("CSRF-TOKEN")
                csrf_source = "cookie" if csrf_token else None

            if not csrf_token:
                raise AuthenticationError(
                    "Missing CSRF token (no form, html token or cookie)"
                )

            login_payload = {
                **form_inputs,
                "_csrf": csrf_token,
                "j_username": self.username,
                "j_password": self.password,
            }

            headers = {
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://www.pesuacademy.com",
                "Referer": r0.url,
                "Sec-GPC": "1",
            }

            logger.debug(f"Posting to {login_url} with csrf source={csrf_source}")
            resp = self.session.post(
                login_url,
                data=login_payload,
                headers=headers,
                allow_redirects=True,
                timeout=15,
            )

            logger.debug(
                f"Login POST status={getattr(resp, 'status_code', None)} url={getattr(resp, 'url', None)}"
            )
            logger.debug(
                f"Session cookies after login: {self.session.cookies.get_dict()}"
            )

            # Heuristic: server sometimes redirects to http landing (which returns 404); if final url uses http, try https equivalent
            final_resp = resp
            try:
                if getattr(resp, "url", "").startswith("http://"):
                    alt = "https://" + resp.url.split("://", 1)[1]
                    logger.debug(f"Retrying landing URL with https: {alt}")
                    landing_resp = self.session.get(
                        alt, allow_redirects=True, timeout=15
                    )
                    logger.debug(
                        f"Landing fetch status: {getattr(landing_resp, 'status_code', None)} url={getattr(landing_resp, 'url', None)}"
                    )
                    if landing_resp.status_code < 400:
                        final_resp = landing_resp
            except Exception:
                pass

            # Basic detection of failed login via presence of login form or error messages
            final_body = (final_resp.text or "").lower()
            if (
                "j_username" in final_body
                or "j_spring_security_check" in final_body
                or ("invalid" in final_body and "login" in final_body)
            ):
                raise AuthenticationError(
                    "Authentication failed: login page or error detected after POST"
                )

            # Prepare profile context and obtain a ready-to-use CSRF token (reuse final response to avoid extra GET)
            try:
                csrf_after = self._prepare_profile_context(initial_response=final_resp)
            except AuthenticationError:
                # Fall back to cookie if preparation failed
                csrf_after = self.session.cookies.get(
                    "XSRF-TOKEN"
                ) or self.session.cookies.get("CSRF-TOKEN")

            self.csrf_token = csrf_after

            logger.info("Authentication successful")

        except requests.RequestException as e:
            raise AuthenticationError(f"Network error during authentication: {e}")
        except Exception as e:
            raise AuthenticationError(f"Authentication failed: {e}")

    def _validate_authentication(self) -> None:
        profile_url = f"{self.BASE_URL}/s/studentProfilePESU"
        try:
            profile_response = self.session.get(
                profile_url, allow_redirects=True, timeout=15
            )
            logger.debug(
                f"Validate profile fetch status={profile_response.status_code} url={profile_response.url}"
            )

            if profile_response.status_code == 200:
                body = profile_response.text.lower()
                # Heuristics for successful login
                if (
                    "studentprofile" in body
                    or "logout" in body
                    or "/a/0" in profile_response.url
                ):
                    return
                # Detect login form indicating failed auth
                if re.search(r'name=["\']j_username["\']', body):
                    raise AuthenticationError(
                        "Authentication failed: login form detected after login"
                    )
                raise AuthenticationError(
                    "Authentication failed: unexpected profile response"
                )
            elif profile_response.status_code in (301, 302):
                raise AuthenticationError("Authentication failed: redirected to login")
            else:
                raise AuthenticationError(
                    f"Authentication failed: HTTP {profile_response.status_code}"
                )

        except requests.RequestException as e:
            raise AuthenticationError(f"Failed to validate authentication: {e}")

    def logout(self) -> None:
        try:
            logout_url = f"{self.BASE_URL}/logout"
            self.session.get(logout_url)
            logger.debug("Session terminated successfully")
        except requests.RequestException as e:
            logger.warning(f"Error during logout: {e}")

    def _prepare_profile_context(
        self, initial_response: Optional[requests.Response] = None
    ) -> str:
        """
        Perform the minimal sequence of requests that prepare the student profile context on the server.
        If `initial_response` is provided (e.g., the final response after login), it will be reused to
        extract CSRF and avoid an extra profile GET. Returns the CSRF token to use for subsequent AJAX requests.
        """
        profile_url = f"{self.BASE_URL}/s/studentProfilePESU"

        # Reuse provided response to avoid an extra network call
        if initial_response is not None:
            r = initial_response
        else:
            try:
                r = self.session.get(profile_url, allow_redirects=True, timeout=15)
                r.raise_for_status()
            except requests.exceptions.HTTPError as e:
                cookies = self.session.cookies.get_dict()
                if "JSESSIONID" in cookies or "SESSION" in cookies:
                    logger.debug(
                        "Fetching profile returned error but session cookie present; retrying once"
                    )
                    r = self.session.get(profile_url, allow_redirects=True, timeout=15)
                    r.raise_for_status()
                else:
                    raise

        # Prefer HTML token found on the page, then cookie
        try:
            html_csrf = self._extract_csrf_token(r.text)
        except AuthenticationError:
            html_csrf = None

        cookie_csrf = self.session.cookies.get(
            "XSRF-TOKEN"
        ) or self.session.cookies.get("CSRF-TOKEN")

        if html_csrf:
            csrf_token = html_csrf
        elif cookie_csrf:
            csrf_token = cookie_csrf
        else:
            raise AuthenticationError(
                "Missing CSRF token before fetching profile; expected an HTML or cookie-based token."
            )

        # Prepare headers for AJAX-like requests
        headers = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": csrf_token,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": profile_url,
        }

        # Make a single best-effort preparatory request (semesters); avoid the heavier admin endpoint to reduce requests
        try:
            r_sem = self.session.get(
                f"{self.BASE_URL}/a/studentProfilePESU/getStudentSemestersPESU",
                params={"_": int(time.time() * 1000)},
                headers=headers,
                timeout=15,
            )
            r_sem.raise_for_status()
        except Exception:
            logger.debug("Semesters fetch failed; continuing anyway")

        return csrf_token

    def fetch_timetable(
        self,
        menu_id: int = 669,
        controller_mode: int = 6415,
        action_type: int = 5,
        id: int = 0,
        selectedData: int = 0,
    ) -> dict:
        """Fetch timetable from the studentProfilePESUAdmin endpoint and parse it.

        Returns a dict with metadata and a list of days, each containing ordered
        time slots and cells (subjects + faculties).
        """
        # Ensure we have a usable CSRF token
        if not self.csrf_token:
            self.csrf_token = self._prepare_profile_context()

        params = {
            "menuId": menu_id,
            "url": "studentProfilePESUAdmin",
            "controllerMode": controller_mode,
            "actionType": action_type,
            "id": id,
            "selectedData": selectedData,
            "_": int(time.time() * 1000),
        }

        headers = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": self.csrf_token,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": f"{self.BASE_URL}/s/studentProfilePESU",
        }

        try:
            resp = self.session.get(
                f"{self.BASE_URL}/s/studentProfilePESUAdmin",
                params=params,
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            raise TimetableScrapingError(f"Failed to fetch timetable: {e}")

        soup = BeautifulSoup(resp.text, "html.parser")

        # Extract simple metadata (Batch, Class Name, Department, Section, Room)
        meta = {}
        for span in soup.find_all("span", {"class": "lbl-title-light"}):
            label = span.get_text(strip=True).rstrip(":")
            value = ""
            if span.next_sibling:
                # sibling may be a NavigableString containing the value
                value = str(span.next_sibling).strip()
            meta[label] = value

        # Collect all inline script text for variable extraction
        script_text = "\n".join(
            script.string for script in soup.find_all("script") if script.string
        )

        def _extract_js_json(varname: str):
            m = re.search(rf"var\s+{re.escape(varname)}\s*=\s*([\s\S]*?);", script_text)
            if not m:
                raise TimetableScrapingError(f"Could not find JS variable: {varname}")
            js_text = m.group(1)
            try:
                return json.loads(js_text)
            except json.JSONDecodeError as e:
                raise TimetableScrapingError(
                    f"Failed to parse {varname} as JSON: {e}\nsnippet: {js_text[:200]}"
                )

        # Parse the JS variables we observed in the example HTML
        try:
            template_details = _extract_js_json("timeTableTemplateDetailsJson")
            days = _extract_js_json("days")
            tt_json = _extract_js_json("timeTableJson")
        except TimetableScrapingError:
            raise
        except Exception as e:
            raise TimetableScrapingError(f"Unexpected parse error: {e}")

        return build_schedule(meta, template_details, days, tt_json)


def fetch_student_timetable(username: str, password: str) -> PESUTimetableScraper:
    """Convenience helper: log in and return a ready-to-use scraper instance."""
    scraper = PESUTimetableScraper(username, password)
    try:
        scraper.login()
        try:
            scraper.csrf_token = scraper._prepare_profile_context()
        except Exception:
            logger.debug(
                "Failed to prepare profile context after login; returning scraper which will prepare later"
            )
        return scraper
    except Exception:
        scraper.logout()
        raise
