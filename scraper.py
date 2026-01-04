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
        soup = BeautifulSoup(html_content, "html.parser")
        csrf_input = soup.find("input", {"name": "_csrf"})

        if not csrf_input or not csrf_input.get("value"):  # type: ignore
            raise AuthenticationError("CSRF token not found in response")

        return csrf_input.get("value")  # type: ignore

    def login(self) -> None:
        logger.debug("Initiating authentication")

        try:
            # Get login page and extract CSRF token
            login_page_url = f"{self.BASE_URL}/"
            response = self.session.get(login_page_url)
            response.raise_for_status()

            csrf_token = self._extract_csrf_token(response.text)

            # Prepare and submit login credentials
            login_url = f"{self.BASE_URL}/j_spring_security_check"
            login_payload = {
                "j_username": self.username,
                "j_password": self.password,
                "_csrf": csrf_token,
            }

            login_response = self.session.post(login_url, data=login_payload)
            login_response.raise_for_status()

            # Validate successful authentication
            self._validate_authentication()

            logger.debug("Authentication successful")

            # Prepare profile context and obtain a ready-to-use CSRF token
            profile_url = f"{self.BASE_URL}/s/studentProfilePESU"
            profile_response = self.session.get(profile_url)
            profile_response.raise_for_status()
            csrf_token = self._extract_csrf_token(profile_response.text)
            self.csrf_token = csrf_token

        except requests.RequestException as e:
            raise AuthenticationError(f"Network error during authentication: {e}")
        except Exception as e:
            raise AuthenticationError(f"Authentication failed: {e}")

    def _validate_authentication(self) -> None:
        profile_url = f"{self.BASE_URL}/s/studentProfilePESU"

        try:
            # Check if we can access protected profile page without redirect
            profile_response = self.session.get(profile_url, allow_redirects=False)

            # If we get a redirect, authentication failed
            if profile_response.status_code in (302, 301):
                redirect_location = profile_response.headers.get("Location")
                if redirect_location:
                    raise AuthenticationError(
                        "Authentication failed: Invalid credentials"
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

    def _prepare_profile_context(self) -> str:
        """Warm up profile context on the server and return a CSRF token for AJAX requests."""
        profile_url = f"{self.BASE_URL}/s/studentProfilePESU"

        # Try to fetch either the HTML token or cookie-based token
        r = self.session.get(profile_url, allow_redirects=True, timeout=15)
        r.raise_for_status()

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

        # Make a single best-effort preparatory request to warm session state
        try:
            self.session.get(
                f"{self.BASE_URL}/a/studentProfilePESU/getStudentSemestersPESU",
                params={"_": int(time.time() * 1000)},
                headers=headers,
                timeout=15,
            )
        except Exception:
            logger.debug("Semesters fetch failed during warm up; continuing anyway")

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
        # warm-up context and ensure CSRF token present
        scraper.csrf_token = scraper._prepare_profile_context()
        return scraper
    except Exception:
        scraper.logout()
        raise
