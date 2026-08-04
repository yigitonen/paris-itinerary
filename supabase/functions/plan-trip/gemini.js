function validUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function interactionText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response?.steps || [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function interactionSources(response, annotationType) {
  const sources = new Map();
  for (const step of response?.steps || []) {
    if (step?.type !== "model_output") continue;
    for (const block of step.content || []) {
      for (const annotation of block?.annotations || []) {
        if (annotation?.type !== annotationType) continue;
        const url = validUrl(annotation.url);
        if (!url) continue;
        const fallback = new URL(url).hostname.replace(/^www\./, "");
        const title = String(annotation.name || annotation.title || fallback).trim().slice(0, 140);
        sources.set(url, { title, url, provider: annotationType === "place_citation" ? "Google Maps" : "Google Search" });
      }
    }
  }
  return [...sources.values()];
}

export function normalizePlaceName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function placeMatchScore(value, sourceTitle) {
  const expected = normalizePlaceName(value);
  const candidate = normalizePlaceName(sourceTitle);
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 4;
  if (expected.includes(candidate) || candidate.includes(expected)) return 3;
  const words = expected.split(" ").filter((word) => word.length > 2);
  const overlap = words.filter((word) => candidate.includes(word)).length;
  return overlap / Math.max(1, words.length);
}

export function matchPlaceSource(stop, sources) {
  const requestedName = stop?.mapSourceName || stop?.title || stop?.query;
  const ranked = (sources || [])
    .map((source) => ({ source, score: Math.max(
      placeMatchScore(requestedName, source.title),
      placeMatchScore(stop?.title, source.title),
      placeMatchScore(stop?.query, source.title)
    ) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 0.6 ? ranked[0].source : null;
}

export function mergeSources(...groups) {
  const sources = new Map();
  groups.flat().forEach((source) => {
    const url = validUrl(source?.url);
    if (!url) return;
    sources.set(url, {
      title: String(source.title || new URL(url).hostname.replace(/^www\./, "")).slice(0, 140),
      url,
      provider: String(source.provider || "Web").slice(0, 40)
    });
  });
  return [...sources.values()];
}
