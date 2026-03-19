"""
WSGI entrypoint for production servers.

Example:
    gunicorn wsgi:app --bind 0.0.0.0:5000
"""
from app import app

