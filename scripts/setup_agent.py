"""Create the ElevenLabs voice agent with audio saving off, then read the
setting back from the API instead of trusting what was sent.

    ELEVENLABS_API_KEY=... python scripts/setup_agent.py

Prints the agent id and the privacy block exactly as the API returns it.
"""
import json
import os
import sys
import urllib.request

API = "https://api.elevenlabs.io/v1/convai"
KEY = os.environ["ELEVENLABS_API_KEY"]

PROMPT = (
    "You answer the phone for a small service business. Find out who is calling, "
    "what they need and the best number to reach them on, in under a minute. "
    "Do not promise prices or appointments; say a person will call back. "
    "If the caller asks for a human, say you are transferring them and stop."
)


def request(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("xi-api-key", KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"{method} {path} -> {error.code}: {error.read().decode()[:600]}")


def main():
    agent_id = os.environ.get("ELEVENLABS_AGENT_ID")
    if not agent_id:
        created = request("POST", "/agents/create", {
            "name": "voice-intake-guard demo",
            "conversation_config": {
                "agent": {
                    "first_message": "Thanks for calling. Who am I speaking with?",
                    "language": "en",
                    "prompt": {"prompt": PROMPT},
                },
                # Twilio streams 8 kHz mu-law. The API default is pcm_16000,
                # which connects fine and then sounds like noise.
                "tts": {"agent_output_audio_format": "ulaw_8000"},
                "asr": {"user_input_audio_format": "ulaw_8000"},
            },
            "platform_settings": {"privacy": {"record_voice": False}},
        })
        agent_id = created["agent_id"]
    else:
        request("PATCH", f"/agents/{agent_id}",
                {"platform_settings": {"privacy": {"record_voice": False}}})

    privacy = request("GET", f"/agents/{agent_id}")["platform_settings"]["privacy"]
    print("agent_id:", agent_id)
    print("privacy as read back:", json.dumps(privacy, indent=2))
    if privacy.get("record_voice") is not False:
        sys.exit("record_voice is not false - audio would be stored")
    print("OK: record_voice is false")


if __name__ == "__main__":
    main()
