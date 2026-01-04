#!/usr/bin/env python3
"""
PESU timetable scraper utilities.

This module imports and runs the Flask application.
"""

from app import app

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
