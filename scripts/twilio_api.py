"""Tiny Twilio REST helper for the setup steps. Standard library only.

Credentials come from the environment (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
never from this repository.
"""
import base64
import json
import os
import urllib.parse
import urllib.request

SID = os.environ["TWILIO_ACCOUNT_SID"]
TOKEN = os.environ["TWILIO_AUTH_TOKEN"]
API = f"https://api.twilio.com/2010-04-01/Accounts/{SID}"


def call(method, url, data=None):
    if not url.startswith("http"):
        url = API + url
    body = urllib.parse.urlencode(data).encode() if data else None
    request = urllib.request.Request(url, data=body, method=method)
    auth = base64.b64encode(f"{SID}:{TOKEN}".encode()).decode()
    request.add_header("Authorization", "Basic " + auth)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {url} -> {error.code}: {error.read().decode()[:400]}")


def get(url):
    return call("GET", url)


def post(url, data):
    return call("POST", url, data)
