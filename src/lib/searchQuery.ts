/**
 * Einfacher Suchoperatoren-Parser für FlatWiki.
 *
 * Unterstützte Syntax:
 *   hund katze          → beide Terme müssen vorkommen (AND, Standard)
 *   hund OR katze       → mindestens ein Term muss vorkommen
 *   -hund               → Term darf NICHT vorkommen
 *   NOT hund            → wie -hund
 *   tag:haustier        → inline Tag-Filter (AND-verknüpft)
 *   "exakte phrase"     → als einzelner Begriff behandelt
 */

export interface ParsedQuery {
  /** Alle müssen matchen (AND). Bei leerem Array zählt optional als Bedingung. */
  required: string[];
  /** Mindestens einer muss matchen (OR). Nur aktiv wenn optional.length > 0. */
  optional: string[];
  /** Kein Ergebnis darf einen dieser Terme enthalten (NOT). */
  excluded: string[];
  /** Inline-Tag-Filter – alle Tags müssen gesetzt sein. */
  tags: string[];
}

/**
 * Tokenisiert einen Raw-Query-String in Wörter/Phrasen
 * und respektiert dabei doppelte Anführungszeichen.
 */
const tokenize = (raw: string): string[] => {
  const tokens: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const token = (match[1] ?? match[2] ?? "").trim();
    if (token) tokens.push(token);
  }
  return tokens;
};

/**
 * Parst einen Query-String in strukturierte Suchterme.
 * Gibt immer ein valides ParsedQuery-Objekt zurück.
 */
export const parseSearchQuery = (raw: string): ParsedQuery => {
  const result: ParsedQuery = { required: [], optional: [], excluded: [], tags: [] };
  if (!raw.trim()) return result;

  const tokens = tokenize(raw.trim());
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i] as string;
    i++;

    // NOT-Operator: nächstes Token ausschließen
    if (token.toUpperCase() === "NOT") {
      const next = tokens[i];
      if (next) {
        i++;
        const term = next.toLowerCase();
        if (term && !result.excluded.includes(term)) result.excluded.push(term);
      }
      continue;
    }

    // OR-Operator: vorheriges required → optional, nächstes → optional
    if (token.toUpperCase() === "OR") {
      // Letztes required-Element zu optional verschieben
      if (result.required.length > 0) {
        const prev = result.required.pop() as string;
        if (!result.optional.includes(prev)) result.optional.push(prev);
      }
      const next = tokens[i];
      if (next) {
        i++;
        const term = next.toLowerCase();
        if (term && !result.optional.includes(term)) result.optional.push(term);
      }
      continue;
    }

    // AND-Operator: explizit – nächstes Token als required
    if (token.toUpperCase() === "AND") {
      const next = tokens[i];
      if (next) {
        i++;
        const term = next.toLowerCase();
        if (term && !result.required.includes(term)) result.required.push(term);
      }
      continue;
    }

    // tag:-Präfix: inline Tag-Filter
    if (token.toLowerCase().startsWith("tag:")) {
      const tag = token.slice(4).toLowerCase().trim();
      if (tag && !result.tags.includes(tag)) result.tags.push(tag);
      continue;
    }

    // Negation mit Minuszeichen: -term
    if (token.startsWith("-") && token.length > 1) {
      const term = token.slice(1).toLowerCase();
      if (term && !result.excluded.includes(term)) result.excluded.push(term);
      continue;
    }

    // Standard: required (AND)
    const term = token.toLowerCase();
    if (term && !result.required.includes(term)) result.required.push(term);
  }

  return result;
};

/**
 * Berechnet einen Score für einen Haystack (Suchtext) anhand eines ParsedQuery.
 * Gibt 0 zurück wenn der Eintrag ausgeschlossen werden soll.
 *
 * @param haystack  Zu durchsuchender Text (bereits lowercase)
 * @param tags      Tags des Eintrags (bereits lowercase)
 * @param parsed    Geparster Query
 * @param baseScore Basis-Score den der Aufrufer bereits berechnet hat
 */
export const applyQueryFilter = (
  haystack: string,
  tags: string[],
  parsed: ParsedQuery,
  baseScore: number
): number => {
  // Ausgeschlossene Terme → Ergebnis komplett entfernen
  for (const exc of parsed.excluded) {
    if (haystack.includes(exc)) return 0;
  }

  // Inline-Tag-Filter: alle müssen vorhanden sein
  for (const tag of parsed.tags) {
    if (!tags.includes(tag)) return 0;
  }

  // OR-Modus: mindestens ein optionaler Term muss matchen
  if (parsed.optional.length > 0) {
    const anyOptional = parsed.optional.some((term) => haystack.includes(term));
    if (!anyOptional) return 0;
  }

  // AND-Modus: alle required Terms müssen matchen
  if (parsed.required.length > 0) {
    const allRequired = parsed.required.every((term) => haystack.includes(term));
    if (!allRequired) return 0;
  }

  // Bonus-Score für Operator-Treffer
  let bonus = 0;
  for (const term of [...parsed.required, ...parsed.optional]) {
    if (haystack.includes(term)) bonus += 1;
  }

  return baseScore + bonus;
};

/**
 * Gibt den "einfachen" Suchstring zurück, der für den Index-Lookup verwendet wird.
 * Bei OR/NOT/tag: wird der erste required-Term oder der erste optional-Term genutzt.
 * Ohne Terme: leerer String.
 */
export const getPrimarySearchTerm = (parsed: ParsedQuery): string => {
  return parsed.required[0] ?? parsed.optional[0] ?? "";
};
