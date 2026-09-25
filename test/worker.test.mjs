// Run: node --test
// The signature is computed here with Node's own crypto module, independently
// of the Worker's WebCrypto code, so the two have to agree for a test to pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { isSignedByTwilio } from "../src/worker.js";

const URL_ = "https://voice.example.workers.dev/";
const env = {
  TWILIO_AUTH_TOKEN: "test-token",
  ELEVENLABS_API_KEY: "k",
  ELEVENLABS_AGENT_ID: "agent_1",
  FALLBACK_PHONE: "+359888000000",
};
const params = { CallSid: "CA1", From: "+359888111111", To: "+15550001111", Direction: "inbound" };

function sign(p, url = URL_, token = env.TWILIO_AUTH_TOKEN) {
  const data = url + Object.keys(p).sort().map((k) => k + p[k]).join("");
  return createHmac("sha1", token).update(data).digest("base64");
}

function call(p, signature) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (signature) headers["X-Twilio-Signature"] = signature;
  return worker.fetch(new Request(URL_, { method: "POST", headers, body: new URLSearchParams(p) }), env);
}

function agentReplies(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = real; };
}

test("no signature is refused with 403", async () => {
  assert.equal((await call(params)).status, 403);
});

test("a signature made with the wrong token is refused", async () => {
  assert.equal((await call(params, sign(params, URL_, "other-token"))).status, 403);
});

test("a tampered parameter breaks the signature", async () => {
  const sig = sign(params);
  assert.equal((await call({ ...params, To: "+15559999999" }, sig)).status, 403);
});

test("WebCrypto and Node crypto agree on the signature", async () => {
  assert.ok(await isSignedByTwilio(env.TWILIO_AUTH_TOKEN, URL_, params, sign(params)));
});

test("a signed call goes to the agent", async () => {
  const restore = agentReplies(async () =>
    new Response(JSON.stringify("<Response><Connect><Stream url=\"wss://x\"/></Connect></Response>")));
  try {
    const res = await call(params, sign(params));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<Connect>/);
  } finally { restore(); }
});

test("agent error sends the caller to a person", async () => {
  const restore = agentReplies(async () => new Response("down", { status: 503 }));
  try {
    const body = await (await call(params, sign(params))).text();
    assert.match(body, /<Dial>\+359888000000<\/Dial>/);
  } finally { restore(); }
});

test("agent that never answers sends the caller to a person", async () => {
  const restore = agentReplies((_, init) => new Promise((_, reject) =>
    init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  try {
    const started = Date.now();
    const body = await (await call(params, sign(params))).text();
    assert.match(body, /<Dial>/);
    assert.ok(Date.now() - started < 4000, "gave up within the timeout");
  } finally { restore(); }
});

test("a non-TwiML answer from the agent is not trusted", async () => {
  const restore = agentReplies(async () => new Response('{"detail":"ok"}'));
  try {
    assert.match(await (await call(params, sign(params))).text(), /<Dial>/);
  } finally { restore(); }
});

test("the demo path is closed unless its secret is set", async () => {
  const req = new Request(URL_ + "demo/", { method: "POST", body: new URLSearchParams(params) });
  assert.equal((await worker.fetch(req, env)).status, 403);
});

test("the demo path needs the exact secret", async () => {
  const token = "x".repeat(32);
  const wrong = new Request(URL_ + "demo/" + "y".repeat(32), { method: "POST", body: new URLSearchParams(params) });
  assert.equal((await worker.fetch(wrong, { ...env, DEMO_PATH_TOKEN: token })).status, 403);
  const restore = agentReplies(async () => new Response("<Response><Connect/></Response>"));
  try {
    const right = new Request(URL_ + "demo/" + token, { method: "POST", body: new URLSearchParams(params) });
    assert.equal((await worker.fetch(right, { ...env, DEMO_PATH_TOKEN: token })).status, 200);
  } finally { restore(); }
});

test("a short demo secret is refused outright", async () => {
  const req = new Request(URL_ + "demo/abc", { method: "POST", body: new URLSearchParams(params) });
  assert.equal((await worker.fetch(req, { ...env, DEMO_PATH_TOKEN: "abc" })).status, 403);
});

test("GET is not a webhook", async () => {
  assert.equal((await worker.fetch(new Request(URL_), env)).status, 405);
});
