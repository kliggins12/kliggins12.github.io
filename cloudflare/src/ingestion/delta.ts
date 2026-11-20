export type ParsedDraw = {
  drawDate: string;
  numbers: number[];
};

export type ExistingDraw = {
  draw_date: string;
  numbers_json: string;
  game?: string;
  session?: string;
};

export type DrawIdentity = {
  game: string;
  session: string;
};

/**
 * Return only dates that are new or whose recorded values/classification
 * actually changed. A source CSV hash change alone must not rewrite history.
 */
export function selectChangedDraws(
  draws: readonly ParsedDraw[],
  existing: readonly ExistingDraw[],
  identity?: DrawIdentity
): ParsedDraw[] {
  const byDate = new Map(existing.map((row) => [row.draw_date, row]));

  return draws.filter((draw) => {
    const current = byDate.get(draw.drawDate);
    if (!current) return true;

    if (current.numbers_json !== JSON.stringify(draw.numbers)) return true;

    if (
      identity &&
      (current.game !== identity.game || current.session !== identity.session)
    ) {
      return true;
    }

    return false;
  });
}

/** A byte-identical source file is a no-op and must not start an ingest run. */
export function isSourceHashUnchanged(previousHash: string | null | undefined, currentHash: string): boolean {
  return previousHash === currentHash;
}
