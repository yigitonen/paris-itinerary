function validUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function contentText(response) {
  return (response?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => typeof part?.text === "string" ? part.text.trim() : "")
    .filter(Boolean)
    .join("\n\n");
}

export function mapsSources(response) {
  const sources = new Map();
  for (const candidate of response?.candidates || []) {
    for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
      const source = chunk?.maps;
      if (!source) continue;
      const url = validUrl(source.uri);
      if (!url) continue;
      const fallback = new URL(url).hostname.replace(/^www\./, "");
      const title = String(source.title || fallback).trim().slice(0, 140);
      sources.set(url, { title, url, provider: "Google Maps" });
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

export function matchPlaceSource(stop, sources) {
  const requestedName = normalizePlaceName(stop?.mapSourceName);
  if (!requestedName) return null;
  return (sources || []).find((source) => normalizePlaceName(source?.title) === requestedName) || null;
}
