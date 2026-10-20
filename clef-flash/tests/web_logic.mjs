import assert from "node:assert/strict";
// Run with: node tests/web_logic.mjs  (checks the page logic without a browser)
const base = new URL("../web/js/", import.meta.url).href;
const { Tracker } = await import(base + "tracker.js");
const { Rules } = await import(base + "rules.js");
const { gridSize, Pacer } = await import(base + "capture.js");
const { validateQuestions } = await import(base + "schema.js");
const { PRESETS } = await import(base + "presets.js");

// presets are all valid and stay small
for (const p of PRESETS) assert.deepEqual(validateQuestions(p.questions), [], p.id);

// grid sizing matches the server's (values from the Python tests)
assert.deepEqual(gridSize(1280, 720, 352), [352, 192]);
assert.deepEqual(gridSize(1280, 720, 640), [640, 352]);
assert.deepEqual(gridSize(100, 100, 352), [256, 256]);

const questions = {
  act: { type: "choice", criteria: { phone: null, typing: null } },
  yes: { type: "noul" },
  lvl: { type: "score", criteria: ["a", "b", "c"] },
};
const tracker = new Tracker();
tracker.reset(questions);
const answer = (phone, yes, lvl) => ({
  act: { type: "choice", choice: phone > 0.5 ? "phone" : "typing", probabilities: { phone, typing: 1 - phone } },
  yes: { type: "noul", noul: yes },
  lvl: { type: "score", probabilities: { 0: lvl[0], 1: lvl[1], 2: lvl[2] } },
});

// smoothing: alpha 0.5 moves halfway
tracker.setSmoothing(0.5);
tracker.ingest(answer(0.2, 0.9, [1, 0, 0]), 0);
tracker.ingest(answer(1.0, 0.1, [0, 0, 1]), 100);
assert.ok(Math.abs(tracker.view("act").probs.phone - 0.6) < 1e-9);
assert.equal(tracker.view("yes").key, "true"); // 0.5 -> still yes (>= 0.5)
assert.ok(Math.abs(tracker.view("lvl").expected - 1) < 1e-9);
tracker.setSmoothing(1);

// triggers: hold, once per episode, cooldown
const fired = [];
const rules = new Rules({ list: null, onFire: (rule, text) => fired.push([rule.question, text]) });
rules.setQuestions(questions);
rules.rules = [
  { id: "r1", enabled: true, question: "act", option: "phone", threshold: 0.7, hold: 1, cooldown: 0, actions: {} },
  { id: "r2", enabled: true, question: "lvl", option: "at_least", threshold: 1.5, hold: 0, cooldown: 10, actions: {} },
];
const step = (t, phone, lvl) => { tracker.ingest(answer(phone, 0.5, lvl), t); rules.evaluate(tracker, t); };
step(1000, 0.9, [0, 0, 1]);            // phone true starts; lvl high -> r2 fires instantly
assert.deepEqual(fired.map((f) => f[0]), ["lvl"]);
step(1500, 0.9, [0, 0, 1]);            // held 0.5 s: not yet
assert.equal(fired.length, 1);
step(2100, 0.9, [0, 0, 1]);            // held 1.1 s: fires
assert.deepEqual(fired.map((f) => f[0]), ["lvl", "act"]);
step(3000, 0.9, [0, 0, 1]);            // same episode: no refire
assert.equal(fired.length, 2);
step(3500, 0.1, [1, 0, 0]);            // both conditions break
step(4000, 0.9, [0, 0, 1]);            // new episode: act must hold again, lvl in cooldown (10 s)
step(5100, 0.9, [0, 0, 1]);
assert.deepEqual(fired.map((f) => f[0]), ["lvl", "act", "act"]);
step(9000, 0.1, [1, 0, 0]); step(12000, 0.1, [0, 0, 1]);  // lvl cooldown over, new episode
assert.equal(fired.at(-1)[0], "lvl");
assert.match(fired[1][1], /act is phone \(≥ 70%\)/);

// pacer: never more than one frame waiting; schedules the next just before the expected end
let sent = 0;
const pacer = new Pacer(async () => { sent++; return true; });
globalThis.performance ??= { now: () => Date.now() };
pacer.start();
await new Promise((r) => setTimeout(r, 30));
assert.equal(sent, 1);                 // first frame
await new Promise((r) => setTimeout(r, 60));
assert.equal(sent, 1);                 // waiting for "started": nothing else is sent
pacer.started(100);                    // model expects 100 ms
await new Promise((r) => setTimeout(r, 40));
assert.equal(sent, 1);                 // not yet: capture lands ~ (100 - lead) ms after start
await new Promise((r) => setTimeout(r, 80));
assert.equal(sent, 2);                 // queued just before the model frees up
pacer.finished();                      // result for frame 1 while frame 2 waits: no extra send
await new Promise((r) => setTimeout(r, 30));
assert.equal(sent, 2);
pacer.started(null); await new Promise((r) => setTimeout(r, 20));
assert.equal(sent, 3);
pacer.stop();
console.log("all logic checks passed");
