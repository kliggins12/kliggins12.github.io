const DATA_API = "https://kamika.tail085272.ts.net";
const EXPECTED_STREAMS = [
  "All or Nothing|morning", "All or Nothing|day", "All or Nothing|evening", "All or Nothing|night",
  "Pick 3|morning", "Pick 3|day", "Pick 3|evening", "Pick 3|night",
  "Daily 4|morning", "Daily 4|day", "Daily 4|evening", "Daily 4|night",
  "Cash Five|daily", "Texas Two Step|draw", "Lotto Texas|draw", "Powerball|draw", "Mega Millions|draw"
];

export function parseDrawNumbers(draw) {
  if (!draw || typeof draw !== "object") return [];
  const value = draw.numbers_json !== undefined ? draw.numbers_json : draw.numbers;
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isSafeInteger);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isSafeInteger);
  } catch {
    // Some older API responses may return comma-separated display values.
  }
  return value.split(/[\s,]+/).map(Number).filter(Number.isSafeInteger);
}

export function formatDraw(draw) {
  const numbers = parseDrawNumbers(draw);
  const game = String(draw && draw.game || "");
  if (game === "Pick 3" || game === "Daily 4") return numbers.map(String).join("");
  return numbers.join(", ");
}

export function compareDraws(previous, current) {
  const left = parseDrawNumbers(previous);
  const right = parseDrawNumbers(current);
  const digitGame = ["Pick 3", "Daily 4"].includes(String(previous && previous.game || ""));
  if (digitGame) {
    const changedPositions = [];
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
      if (left[i] !== right[i]) {
        changedPositions.push({
          position: i + 1,
          from: left[i] === undefined ? "—" : left[i],
          to: right[i] === undefined ? "—" : right[i]
        });
      }
    }
    return { changedPositions, shared: [], added: [], removed: [] };
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    changedPositions: [],
    shared: left.filter((value) => rightSet.has(value)),
    added: right.filter((value) => !leftSet.has(value)),
    removed: left.filter((value) => !rightSet.has(value))
  };
}

export function summarizeFrequency(draws) {
  const counts = new Map();
  let observations = 0;
  for (const draw of draws || []) {
    for (const number of parseDrawNumbers(draw)) {
      counts.set(number, (counts.get(number) || 0) + 1);
      observations++;
    }
  }
  return [...counts.entries()]
    .map(([number, count]) => ({ number, count }))
    .sort((a, b) => b.count - a.count || a.number - b.number)
    .map((item) => ({ ...item, share: observations ? item.count / observations : 0 }));
}

export function hasCompletePrimaryHistory(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.streams)) return false;
  if (payload.streamCount !== EXPECTED_STREAMS.length || payload.streams.length !== EXPECTED_STREAMS.length) return false;
  const keys = new Set(payload.streams.map((item) => String(item.game) + "|" + String(item.session)));
  return EXPECTED_STREAMS.every((key) => keys.has(key)) &&
    payload.streams.every((item) => Number(item.draw_count) > 0);
}

export function sortDrawsChronologically(draws) {
  return [...(draws || [])].sort((a, b) =>
    String(a.draw_date).localeCompare(String(b.draw_date)) ||
    String(a.source_filename || a.source_file || "").localeCompare(String(b.source_filename || b.source_file || ""))
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("The drawing service returned an unreadable response."); }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || ("Drawing service returned HTTP " + response.status + "."));
  }
  return payload;
}

function show(view) {
  document.querySelectorAll(".panelview").forEach((panel) => panel.classList.toggle("active", panel.id === view));
  document.querySelectorAll("nav button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const label = {
    overview: "Drawing Overview",
    walkthrough: "Chronological Walkthrough",
    journal: "Drawing Journal",
    shapes: "Number Review",
    transitions: "Changes Over Time",
    assumptions: "Number Ideas",
    imports: "Past Drawings"
  };
  const heading = document.getElementById("pageTitle");
  if (heading) heading.textContent = label[view] || label.overview;
  if (history.replaceState) history.replaceState(null, "", "#" + view);
}

function renderTable(headers, rows) {
  return "<table><thead><tr>" + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") +
    "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
}

function dateLabel(draw) {
  return String(draw.draw_date || "—");
}

const state = {
  mode: null,
  streams: [],
  historyRows: [],
  cursor: null,
  selected: null,
  loading: false
};

function updateStorageNotice(mode, message) {
  const label = document.getElementById("storageNoticeStatus");
  const title = document.getElementById("storageNoticeTitle");
  const body = document.getElementById("storageNoticeText");
  if (label) label.textContent = mode === "primary" ? "Local SQLite" : mode === "legacy" ? "Limited history" : "Service unavailable";
  if (title) title.textContent = mode === "primary"
    ? "Full drawing history is available."
    : mode === "legacy"
      ? "The full database migration is not complete yet."
      : "Drawing history is temporarily unavailable.";
  if (body) body.textContent = message;
}

function renderStreamSummary(payload) {
  const streamSelect = document.getElementById("streamSelect");
  const out = document.getElementById("csvResults");
  const count = Number(payload.drawCount || 0);
  const recordCount = document.getElementById("recordCount");
  if (recordCount) recordCount.textContent = count.toLocaleString();
  if (streamSelect) {
    const previousSelection = streamSelect.value;
    streamSelect.innerHTML = state.streams.map((stream) => {
      const key = stream.game + "|" + stream.session;
      const label = stream.game + " · " + stream.session + " (" + Number(stream.draw_count).toLocaleString() + ")";
      return '<option value="' + escapeHtml(key) + '">' + escapeHtml(label) + "</option>";
    }).join("");
    if (previousSelection && state.streams.some((stream) => stream.game + "|" + stream.session === previousSelection)) {
      streamSelect.value = previousSelection;
    }
  }
  if (out) {
    const rows = state.streams.map((stream) =>
      "<tr><td>" + escapeHtml(stream.game) + "</td><td>" + escapeHtml(stream.session) +
      "</td><td>" + Number(stream.draw_count).toLocaleString() + "</td><td>" +
      escapeHtml(stream.first_draw_date) + "</td><td>" + escapeHtml(stream.last_draw_date) + "</td></tr>"
    );
    out.innerHTML = renderTable(["Game", "Drawing time", "Drawings", "First date", "Latest date"], rows);
  }
  const loadButton = document.getElementById("loadHistoryBtn");
  if (loadButton) loadButton.disabled = state.streams.length === 0;
  const status = document.getElementById("csvStatus");
  if (status) status.textContent = "Ready · " + count.toLocaleString() + " drawings across " + state.streams.length + " feeds";
}

async function loadSummary() {
  const status = document.getElementById("csvStatus");
  const out = document.getElementById("csvResults");
  if (status) status.textContent = "Checking drawing history…";
  try {
    const primary = await fetchJson(DATA_API + "/api/primary/draws/summary");
    if (hasCompletePrimaryHistory(primary)) {
      state.mode = "primary";
      state.streams = primary.streams;
      state.historyRows = [];
      state.cursor = null;
      updateStorageNotice("primary", "The 17 verified game feeds are being read from the local SQLite database over your private Tailscale network. Only devices connected to your tailnet can access this database.");
      renderStreamSummary(primary);
      return;
    }
  } catch (error) {
    // Until the all-game database cutover, the previous session-history API remains available.
  }

  try {
    const legacy = await fetchJson(DATA_API + "/api/session-draws/summary");
    if (!Array.isArray(legacy.streams) || legacy.streams.length === 0) {
      throw new Error("No verified drawing feeds are available.");
    }
    state.mode = "legacy";
    state.streams = legacy.streams;
    state.historyRows = [];
    state.cursor = null;
    updateStorageNotice("legacy", "NumberLab is using the existing 12 Pick 3, Daily 4, and All or Nothing session feeds. The remaining game histories and metadata have not yet completed the Turso migration. This limited view is not the full all-game database.");
    renderStreamSummary(legacy);
  } catch (error) {
    state.mode = null;
    state.streams = [];
    updateStorageNotice("unavailable", "NumberLab could not reach the local database. Connect this device to your private Tailscale network, then reload the page.");
    if (status) status.textContent = "History unavailable";
    if (out) out.textContent = error.message;
  }
}

function selectedStream() {
  const value = document.getElementById("streamSelect")?.value || "";
  const separator = value.indexOf("|");
  if (separator < 0) return null;
  return { game: value.slice(0, separator), session: value.slice(separator + 1) };
}

async function refreshDrawingHistory() {
  const button = document.getElementById("refreshHistoryBtn");
  const status = document.getElementById("csvStatus");
  const selectedValue = document.getElementById("streamSelect")?.value || "";
  if (!button || button.disabled) return;

  button.disabled = true;
  button.textContent = "Refreshing…";
  if (status) status.textContent = "Checking all 17 official drawing feeds…";

  try {
    const startResponse = await fetch(DATA_API + "/api/primary/refresh", {
      method: "POST", cache: "no-store", headers: { accept: "application/json" }
    });
    let job;
    try { job = await startResponse.json(); }
    catch { throw new Error("The drawing service returned an unreadable refresh response."); }
    if (![202, 409].includes(startResponse.status)) {
      throw new Error(job.error || job.message || ("Refresh could not start (HTTP " + startResponse.status + ")."));
    }
    if (!job.jobId) throw new Error(job.error || "The drawing refresh did not return a job ID.");

    let finished = null;
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const response = await fetchJson(DATA_API + "/api/primary/refresh/status?jobId=" + encodeURIComponent(job.jobId));
      if (response.status === "completed" || response.status === "failed") finished = response;
      else if (status) status.textContent = response.detail || "Checking and updating drawing history…";
    }

    if (finished.status === "failed") {
      throw new Error(finished.error || "The official drawing feeds could not be refreshed. No partial import was applied.");
    }

    const result = finished.result || {};
    const changed = Number(result.new_or_corrected_draws || 0);
    const checked = Number(result.checked || 0);
    await loadSummary();

    const selector = document.getElementById("streamSelect");
    if (selector && selectedValue && Array.from(selector.options).some((option) => option.value === selectedValue)) {
      selector.value = selectedValue;
      state.selected = selectedStream();
      state.historyRows = [];
      state.cursor = null;
      await loadStreamPage(true);
    }

    if (status) status.textContent = changed
      ? "History updated: " + changed.toLocaleString() + " new or corrected drawings across " + checked + " feeds."
      : "History is up to date. All " + checked + " official feeds were checked; no new drawings were found.";
  } catch (error) {
    if (status) status.textContent = "Refresh failed: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Refresh drawing history";
  }
}

async function loadStreamPage(reset) {
  if (!state.mode || state.loading) return;
  const stream = selectedStream();
  if (!stream) return;
  state.selected = stream;
  const status = document.getElementById("csvStatus");
  const historyOut = document.getElementById("historyResults");
  state.loading = true;
  const loadButton = document.getElementById("loadHistoryBtn");
  const moreButton = document.getElementById("loadMoreHistoryBtn");
  if (loadButton) loadButton.disabled = true;
  if (moreButton) moreButton.disabled = true;
  if (status) status.textContent = "Loading drawings…";

  try {
    let payload;
    if (state.mode === "primary") {
      const params = new URLSearchParams({ game: stream.game, session: stream.session, limit: "500" });
      if (!reset && state.cursor) {
        params.set("before", state.cursor.date);
        params.set("beforeSource", state.cursor.source);
      }
      payload = await fetchJson(DATA_API + "/api/primary/draws?" + params.toString());
    } else {
      const params = new URLSearchParams({ game: stream.game, session: stream.session, limit: "500" });
      if (!reset && state.cursor) params.set("after", state.cursor);
      payload = await fetchJson(DATA_API + "/api/session-draws?" + params.toString());
    }

    if (!Array.isArray(payload.draws)) throw new Error("The drawing history response is incomplete.");
    if (reset) state.historyRows = [];
    const existing = new Set(state.historyRows.map((draw) => String(draw.draw_date) + "|" + String(draw.source_filename || draw.source_file || "")));
    for (const draw of payload.draws) {
      const key = String(draw.draw_date) + "|" + String(draw.source_filename || draw.source_file || "");
      if (!existing.has(key)) state.historyRows.push(draw);
    }
    state.historyRows = sortDrawsChronologically(state.historyRows);

    if (state.mode === "primary") {
      state.cursor = payload.nextBefore && payload.nextBeforeSource
        ? { date: payload.nextBefore, source: payload.nextBeforeSource }
        : null;
    } else {
      state.cursor = payload.nextAfter || null;
    }

    renderHistory();
    if (status) status.textContent = "Showing " + state.historyRows.length.toLocaleString() +
      " drawings" + (state.cursor ? " · select “Show more drawings” to continue" : " · all available drawings shown");
    if (historyOut && state.historyRows.length === 0) historyOut.textContent = "No drawings are available for this feed.";
  } catch (error) {
    if (status) status.textContent = "History unavailable";
    if (historyOut) historyOut.textContent = error.message;
  } finally {
    state.loading = false;
    if (loadButton) loadButton.disabled = state.streams.length === 0;
    if (moreButton) moreButton.disabled = !state.cursor;
  }
}

function renderHistory() {
  const rows = state.historyRows;
  const selected = state.selected || { game: "", session: "" };
  const recent = [...rows].reverse().slice(0, 100);
  const historyOut = document.getElementById("historyResults");
  if (historyOut) {
    historyOut.innerHTML = renderTable(["Date", "Drawn numbers"], recent.map((draw) =>
      "<tr><td>" + escapeHtml(dateLabel(draw)) + "</td><td class='ticket'>" +
      escapeHtml(formatDraw(draw)) + "</td></tr>"
    ));
  }
  const journalOut = document.getElementById("journalResults");
  if (journalOut) {
    journalOut.innerHTML = rows.length
      ? renderTable(["Date", "Game", "Drawing time", "Numbers"], recent.map((draw) =>
        "<tr><td>" + escapeHtml(dateLabel(draw)) + "</td><td>" + escapeHtml(selected.game) +
        "</td><td>" + escapeHtml(selected.session) + "</td><td class='ticket'>" +
        escapeHtml(formatDraw(draw)) + "</td></tr>"
      ))
      : "<div class='notice'>Load a game and drawing time to view its journal.</div>";
  }

  const recordCount = document.getElementById("recordCount");
  const journalCount = document.getElementById("journalCount");
  const transitionCount = document.getElementById("transitionCount");
  if (journalCount) journalCount.textContent = rows.length.toLocaleString();
  if (transitionCount) transitionCount.textContent = Math.max(0, rows.length - 1).toLocaleString();
  if (recordCount && !Number(recordCount.textContent)) recordCount.textContent = rows.length.toLocaleString();

  renderNumberReview(rows, selected);
  renderChanges(rows);
  renderIdeas(rows);
  renderPick3Walkthrough(rows, selected);
}

function renderNumberReview(rows, selected) {
  const host = document.getElementById("shapeResults");
  if (!host) return;
  if (rows.length < 2) {
    host.innerHTML = "<div class='notice'>Load at least two drawings from one game and drawing time to compare them.</div>";
    return;
  }
  const pairs = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const result = compareDraws(previous, current);
    let detail;
    if (result.changedPositions.length) {
      detail = result.changedPositions.map((item) =>
        "P" + item.position + ": " + item.from + " → " + item.to
      ).join(" · ");
    } else {
      detail = "Shared: " + (result.shared.join(", ") || "none") +
        " · Added: " + (result.added.join(", ") || "none") +
        " · Not repeated: " + (result.removed.join(", ") || "none");
    }
    pairs.push("<tr><td>" + escapeHtml(dateLabel(previous)) + "</td><td>" +
      escapeHtml(formatDraw(previous)) + "</td><td>" + escapeHtml(dateLabel(current)) +
      "</td><td>" + escapeHtml(formatDraw(current)) + "</td><td>" + escapeHtml(detail) + "</td></tr>");
  }
  host.innerHTML = "<p class='muted'>" + escapeHtml(selected.game + " · " + selected.session) +
    " — comparison between consecutive drawings in date order.</p>" +
    renderTable(["Earlier date", "Earlier result", "Next date", "Next result", "What changed"], pairs.reverse().slice(0, 80));
}

function renderChanges(rows) {
  const host = document.getElementById("transitionResults");
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = "<div class='notice'>Load a drawing history to see observed number frequencies.</div>";
    return;
  }
  const frequencies = summarizeFrequency(rows);
  const top = frequencies.slice(0, 15);
  const tableRows = top.map((item) =>
    "<tr><td class='ticket'>" + escapeHtml(item.number) + "</td><td>" +
    item.count.toLocaleString() + "</td><td>" + (item.share * 100).toFixed(1) + "%</td></tr>"
  );
  host.innerHTML = "<p class='muted'>Frequency across " + rows.length.toLocaleString() +
    " loaded drawings and all values in each result. This describes the selected history only.</p>" +
    renderTable(["Number", "Appearances", "Share of number appearances"], tableRows);
}

function renderIdeas(rows) {
  const host = document.getElementById("assumptionResults");
  const count = document.getElementById("assumptionCount");
  if (!host) return;
  const frequencies = summarizeFrequency(rows).slice(0, 10);
  if (count) count.textContent = frequencies.length.toLocaleString();
  if (!frequencies.length) {
    host.innerHTML = "<div class='notice'>Load a drawing history to display descriptive number counts.</div>";
    return;
  }
  host.innerHTML = "<p class='muted'>These are the most frequently observed values in the currently loaded history. They are not predictions and do not have improved odds in a future drawing.</p>" +
    "<div class='grid'>" + frequencies.map((item) =>
      "<article class='card'><h3>Number</h3><div class='metric'>" + escapeHtml(item.number) +
      "</div><div class='muted'>" + item.count.toLocaleString() + " appearances</div></article>"
    ).join("") + "</div>";
}

function renderPick3Walkthrough(rows, selected) {
  const host = document.getElementById("pick3BoardPreview");
  if (!host) return;
  if (selected.game !== "Pick 3") {
    host.innerHTML = "<div class='notice' style='grid-column:1/-1'>Choose a Pick 3 drawing time to view its recent three-digit results.</div>";
    return;
  }
  const recent = [...rows].reverse().slice(0, 10);
  if (!recent.length) {
    host.innerHTML = "<div class='notice' style='grid-column:1/-1'>Load Pick 3 drawings to begin the chronological view.</div>";
    return;
  }
  const cells = [];
  recent.forEach((draw) => {
    const digits = parseDrawNumbers(draw).slice(0, 3);
    for (let column = 0; column < 3; column++) {
      const digit = digits[column] === undefined ? "—" : digits[column];
      const date = column === 0 ? '<span class="slotref">' + escapeHtml(dateLabel(draw)) + "</span>" : "";
      cells.push('<div class="pick3-slot">' + date + "<strong>" + escapeHtml(digit) + "</strong></div>");
    }
  });
  host.innerHTML = cells.join("");
}

async function initialize() {
  document.querySelectorAll("nav button[data-view]").forEach((button) => {
    button.addEventListener("click", () => show(button.dataset.view));
  });
  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => show(button.dataset.go));
  });
  const initialView = location.hash.slice(1);
  if (["overview", "walkthrough", "journal", "shapes", "transitions", "assumptions", "imports"].includes(initialView)) show(initialView);

  document.getElementById("loadCsvBtn")?.addEventListener("click", loadSummary);
  document.getElementById("refreshHistoryBtn")?.addEventListener("click", refreshDrawingHistory);
  document.getElementById("loadHistoryBtn")?.addEventListener("click", () => loadStreamPage(true));
  document.getElementById("loadMoreHistoryBtn")?.addEventListener("click", () => loadStreamPage(false));
  document.getElementById("streamSelect")?.addEventListener("change", () => {
    state.cursor = null;
    state.historyRows = [];
    state.selected = selectedStream();
    const moreButton = document.getElementById("loadMoreHistoryBtn");
    if (moreButton) moreButton.disabled = true;
    const status = document.getElementById("csvStatus");
    if (status) status.textContent = "Select “Show drawings” to load this game.";
    renderHistory();
  });

  updateStorageNotice("legacy", "Checking whether the complete all-game history has been migrated to Turso.");
  await loadSummary();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { void initialize(); }, { once: true });
  } else {
    void initialize();
  }
}
