export const ANALYSIS_ARTIFACTS = Object.freeze([
  {
    key: "batchmate_data",
    url: "https://raw.githubusercontent.com/kliggins12/batchmate/master/batchmate_data.json"
  },
  {
    key: "tight_tickets",
    url: "https://raw.githubusercontent.com/kliggins12/batchmate/master/tight_tickets.json"
  }
]);

export function validateAnalysisArtifact(key, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(key + " must contain a JSON object.");
  }
  if (typeof payload.generated !== "string" || !payload.generated.trim()) {
    throw new Error(key + " is missing its generated timestamp.");
  }

  if (key === "batchmate_data") {
    if (!Array.isArray(payload.games) || payload.games.length !== 12) {
      throw new Error("batchmate_data must contain all 12 generated game/session summaries.");
    }
    const names = new Set();
    for (const game of payload.games) {
      if (!game || typeof game.name !== "string" || !game.name.trim() || !Array.isArray(game.top)) {
        throw new Error("batchmate_data contains an incomplete game summary.");
      }
      if (names.has(game.name)) throw new Error("batchmate_data contains a duplicate game summary: " + game.name + ".");
      names.add(game.name);
    }
    return {
      key,
      generatedAt: payload.generated,
      itemCount: payload.games.length,
      detailCount: payload.games.reduce((sum, game) => sum + game.top.length, 0)
    };
  }

  if (key === "tight_tickets") {
    if (!Array.isArray(payload.tickets) || payload.tickets.length === 0) {
      throw new Error("tight_tickets must contain generated ticket records.");
    }
    if (!Array.isArray(payload.latest_draws) || payload.latest_draws.length !== 17) {
      throw new Error("tight_tickets must contain the latest results for all 17 source feeds.");
    }
    const streams = new Set();
    for (const draw of payload.latest_draws) {
      if (!draw || typeof draw.game !== "string" || typeof draw.date !== "string" ||
          typeof draw.numbers !== "string") {
        throw new Error("tight_tickets contains an incomplete latest drawing.");
      }
      const keyValue = draw.game + "|" + String(draw.session || "");
      if (streams.has(keyValue)) throw new Error("tight_tickets contains a duplicate latest drawing stream: " + keyValue + ".");
      streams.add(keyValue);
    }
    for (const ticket of payload.tickets) {
      if (!ticket || typeof ticket.game !== "string" || typeof ticket.ticket !== "string") {
        throw new Error("tight_tickets contains an incomplete ticket record.");
      }
    }
    return {
      key,
      generatedAt: payload.generated,
      itemCount: payload.tickets.length,
      detailCount: payload.latest_draws.length
    };
  }

  throw new Error("Unsupported analysis artifact key: " + key + ".");
}
