// A Cloudflare Worker in front of a Twilio number.
//
// Twilio posts the call here. The Worker refuses anything Twilio did not sign,
// asks ElevenLabs for the TwiML that connects the caller to the voice agent,
// and if ElevenLabs does not answer in time, dials a human instead. The caller
// never hears silence because the agent is down.
//
// Audio never passes through this Worker: Twilio streams it straight to
// ElevenLabs once the TwiML is returned. What is logged is the call SID and
// which way the call went, nothing the caller said.

const REGISTER_CALL = "https://api.elevenlabs.io/v1/convai/twilio/register-call";
const AGENT_TIMEOUT_MS = 3000;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST only - this is a Twilio voice webhook\n", { status: 405 });
    }

    const body = await request.text();
    const params = Object.fromEntries(new URLSearchParams(body));
    const url = env.PUBLIC_URL || request.url;
    const signature = request.headers.get("X-Twilio-Signature") || "";

    // Twilio's 2026 trial accounts fetch the webhook through an unsigned
    // client, so a trial call can never pass the check below. A secret path
    // (/demo/<DEMO_PATH_TOKEN>) lets a trial call through for a demo. It is
    // off unless the secret is set, and weaker than a signature: anyone who
    // learns the URL can use it. Production traffic uses the signed route.
    const demo = isDemoPath(env.DEMO_PATH_TOKEN, new URL(request.url).pathname);
    if (demo) {
      console.log(JSON.stringify({ call: params.CallSid || null, route: "demo path, unsigned" }));
    } else if (!signature || !(await isSignedByTwilio(env.TWILIO_AUTH_TOKEN, url, params, signature))) {
      // Why it was refused and for which URL: the one line that explains a
      // proxy rewriting the host or scheme. No parameters, no signature.
      console.log(JSON.stringify({ call: params.CallSid || null, route: "refused",
        reason: signature ? "bad signature" : "no signature", url }));
      return new Response("forbidden\n", { status: 403 });
    }

    const agent = await askAgent(env, params);
    console.log(JSON.stringify({ call: params.CallSid, route: agent.twiml ? "agent" : "fallback",
      reason: agent.reason }));
    return twiml(agent.twiml || fallback(env.FALLBACK_PHONE));
  },
};

// Twilio's scheme: HMAC-SHA1 over the full URL followed by every POST
// parameter, sorted by name, as name+value with no separators; base64.
export async function isSignedByTwilio(authToken, url, params, signature) {
  if (!authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sameString(expected, signature);
}

export function isDemoPath(token, pathname) {
  return Boolean(token) && token.length >= 24 && sameString(pathname, `/demo/${token}`);
}

// Compare without leaking how many leading characters matched.
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// { twiml } that hands the call to the agent, or { twiml: null, reason } when
// the agent cannot take it. The reason is logged, so "the fallback fired" can
// be told apart as a timeout, an HTTP error or an answer that was not TwiML.
export async function askAgent(env, params) {
  const outbound = (params.Direction || "").startsWith("outbound");
  try {
    const response = await fetch(REGISTER_CALL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
      body: JSON.stringify({
        agent_id: env.ELEVENLABS_AGENT_ID,
        from_number: params.From,
        to_number: params.To,
        direction: outbound ? "outbound" : "inbound",
      }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    if (!response.ok) return { twiml: null, reason: `agent http ${response.status}` };
    // The API returns the TwiML as a JSON-encoded string on some versions and
    // as raw XML on others; accept both, reject anything else.
    let text = await response.text();
    if (text.startsWith('"')) text = JSON.parse(text);
    return text.includes("<Response")
      ? { twiml: text, reason: "ok" }
      : { twiml: null, reason: "agent answer is not TwiML" };
  } catch (error) {
    return { twiml: null, reason: error?.name === "TimeoutError" ? "agent timeout" : "agent unreachable" };
  }
}

export function fallback(phone) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say>Connecting you to a person.</Say><Dial>${escapeXml(phone || "")}</Dial></Response>`;
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function twiml(xml) {
  return new Response(xml, { headers: { "Content-Type": "text/xml" } });
}
