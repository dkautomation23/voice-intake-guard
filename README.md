# voice-intake-guard

A Cloudflare Worker that sits between a Twilio phone number and an ElevenLabs
voice agent. It lets through only requests Twilio signed, hands the call to the
agent, and when the agent does not answer in 3 seconds it dials a human
instead. The caller never gets silence because the AI side is down.

```
caller ──> Twilio number ──POST (signed)──> Worker ──register-call──> ElevenLabs
                                              │  403 if the signature is wrong
                                              │  <Connect><Stream> if the agent answers
                                              └─ <Dial>human</Dial> if it errors, times out,
                                                 or answers with something that is not TwiML
```

Audio never passes through the Worker: once it returns the TwiML, Twilio
streams the call straight to ElevenLabs. The Worker logs the call SID and which
way the call went, never what was said.

Built and tested on 25.09.2026. Everything below marked **live** was run
against the deployed Worker, real Twilio and real ElevenLabs; the output is in
[`evidence/`](evidence).

## What is verified, and how

| Claim | How | Result |
|---|---|---|
| Unsigned or forged requests are refused | `curl` against the live Worker | **live** 403 / 403 — [`evidence/curl.txt`](evidence/curl.txt) |
| A correctly signed request reaches the agent | `curl` with an HMAC-SHA1 signature made from the real auth token | **live** 200, ElevenLabs returned `<Connect><Stream>` |
| Agent down → a person is dialled | agent id pointed at an agent that does not exist | **live** 200, `<Dial>`, log reason `agent http 404` |
| Agent slow → a person is dialled | ElevenLabs call never answers | test: gives up at 3 s, well inside Twilio's 15 s webhook limit |
| Agent answers with junk → a person is dialled | 200 with a body that is not TwiML | test |
| Audio is not stored | `record_voice: false` set, then **read back** from the API | **live** — [`evidence/agent-readback.txt`](evidence/agent-readback.txt) |
| No secret in the repository | secret scan before publishing | 0 findings |

```bash
node --test          # 12 tests, no network, no accounts
```

The signature tests compute the expected value with Node's own `crypto`
module, independently of the Worker's WebCrypto code, so the two
implementations have to agree.

## What broke

**1. The agent connected and sounded like noise, with no error anywhere.**
An agent created through the API defaults to `pcm_16000` audio. Twilio speaks
8 kHz μ-law only. Nothing fails loudly: register-call returns 200, the stream
opens, the caller hears static. Fixed by setting `ulaw_8000` for both input
and output at creation ([`scripts/setup_agent.py`](scripts/setup_agent.py)) and
reading it back.

**2. The guard refused Twilio itself.**
The first live call played "could not reach your web server". The Worker log
showed why: Twilio's 2026 trial accounts fetch the webhook with
`Java-http-client/25.0.2` and **no `X-Twilio-Signature` header**. The Worker
answered 403, exactly as designed — an unsigned request is indistinguishable
from anyone else's. See
[`evidence/worker-log-trial-calls.txt`](evidence/worker-log-trial-calls.txt).
I did not weaken the signed route. For the trial demo there is a separate
`/demo/<secret>` path, off unless `DEMO_PATH_TOKEN` is set, 24+ characters,
compared in constant time, and logged as `demo path, unsigned` so it can never
be mistaken for signed traffic. Delete the secret and the path is gone.

**3. On the trial account the voice stream never opens.**
Through the demo path the Worker got 200 from ElevenLabs and returned
`<Connect><Stream>`; ElevenLabs registered the conversation — and it stayed in
`initiated` with zero seconds. Twilio's trial plays its own notice and hangs
up without opening the media stream. On the same account the trial number is
also not visible in the `IncomingPhoneNumbers` API, and verification calls,
geo permissions and the alerts API all return "not available on a Trial
account" (codes 10002, 21404, 20003). So the one thing not shown live here is
a spoken conversation over the phone; everything up to the stream is.

**4. "No stored audio" is not "no stored data".**
With audio saving off, ElevenLabs still keeps transcripts forever by default
(`retention_days: -1`). Set to 1 day here and read back. Worth saying out loud
to a client who asked for the first and assumed the second.

## Design choices

- **The URL that is signed is fixed.** `PUBLIC_URL` overrides `request.url`.
  Twilio signs the exact URL it called; rebuilding it from `Host` or
  `X-Forwarded-*` behind a proxy is the most common way signature checks break
  in production.
- **3-second timeout on ElevenLabs.** Twilio gives a voice webhook 15 seconds
  including connection setup
  ([Twilio docs](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides)).
  Three leaves room for the fallback to answer and for a slow TLS handshake.
- **Our own `<Dial>` instead of the agent's transfer.** Calls registered with
  `register-call` cannot be transferred by ElevenLabs, which does not hold the
  Twilio credentials
  ([ElevenLabs docs](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call)).
  So the human path lives in the Worker.
- **Every fallback says why.** The log reason is one of `agent timeout`,
  `agent http <status>`, `agent answer is not TwiML`, `agent unreachable` —
  so "the fallback fired" can be traced to its cause without guessing.
- **Second layer.** Set the number's *Voice fallback URL* to a TwiML Bin that
  dials the same human. If the Worker itself is down, Twilio still reaches a
  person. (Not configurable on the trial number, see *What broke* 3.)

## Install

1. Twilio: a number with Voice; note the Account SID and Auth Token.
2. ElevenLabs: an API key with access to agents.
3. Create the agent (audio off, μ-law, read back):
   ```bash
   ELEVENLABS_API_KEY=... python scripts/setup_agent.py
   ```
4. Deploy and set secrets — none of them is in this repository:
   ```bash
   npx wrangler deploy
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put ELEVENLABS_API_KEY
   npx wrangler secret put ELEVENLABS_AGENT_ID
   npx wrangler secret put FALLBACK_PHONE        # +<country><number>
   ```
5. In Twilio, point the number's voice webhook (POST) at the Worker URL, and
   its *Voice fallback URL* at a TwiML Bin:
   ```xml
   <Response><Dial>+YOUR_NUMBER</Dial></Response>
   ```
6. Check: `curl -X POST <worker-url> -d CallSid=x` must return 403.

## Files

| Path | What |
|---|---|
| `src/worker.js` | the Worker, ~120 lines, no dependencies |
| `test/worker.test.mjs` | 12 tests: signature, fallback reasons, demo path |
| `scripts/setup_agent.py` | creates the agent and reads its privacy and audio settings back |
| `scripts/twilio_api.py` | small Twilio REST helper used during setup |
| `evidence/` | output of the live runs quoted above |

## License

MIT
