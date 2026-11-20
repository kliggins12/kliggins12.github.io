import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = async (path) => readFile(fileURLToPath(new URL(path, root)), "utf8");

test("Batchmate homepage inline scripts parse and use Turso with published fallback", async () => {
  const html = await read("index.html");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0, "Expected at least one inline script in index.html");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new Script(source, { filename: "index.html:inline-" + index }));
  });
  assert.match(html, /\/api\/primary\/analysis/);
  assert.match(html, /\/api\/primary\/draws\/latest/);
  assert.match(html, /batchmate_data\.json/);
  assert.match(html, /tight_tickets\.json/);
});

test("NumberLab loads its module and includes data-backed result panels", async () => {
  const html = await read("numberlab.html");
  const app = await read("numberlab-app.mjs");
  assert.match(html, /type="module" src="numberlab-app\.mjs"/);
  for (const id of ["journalResults", "shapeResults", "transitionResults", "assumptionResults", "pick3BoardPreview"]) {
    assert.ok(html.includes('id="' + id + '"'), "Missing NumberLab panel: " + id);
  }
  assert.match(app, /api\/primary\/draws\/summary/);
  assert.match(app, /api\/session-draws\/summary/);
  assert.match(app, /hasCompletePrimaryHistory/);
  assert.match(app, /not predictions/i);
});
