import test from "node:test";
import assert from "node:assert/strict";
import { contentText, mapsSources, matchPlaceSource } from "./gemini.js";

const response = {
  candidates: [{
    content: { parts: [{ text: "Grounded answer" }] },
    groundingMetadata: { groundingChunks: [
      { maps: { title: "İstanbul Modern", uri: "https://maps.google.com/example" } }
    ] }
  }]
};

test("extracts grounded model text", () => {
  assert.equal(contentText(response), "Grounded answer");
});

test("extracts only the requested citation type", () => {
  assert.deepEqual(mapsSources(response), [{
    title: "İstanbul Modern",
    url: "https://maps.google.com/example",
    provider: "Google Maps"
  }]);
});

test("matches a localized stop to its Google Maps source", () => {
  const source = mapsSources(response)[0];
  assert.equal(matchPlaceSource({ title: "Istanbul Modern Sanat Müzesi", mapSourceName: "İstanbul Modern" }, [source]), source);
});

test("does not mark a fuzzy place name as Maps-matched", () => {
  const source = mapsSources(response)[0];
  assert.equal(matchPlaceSource({ title: "Istanbul Modern Sanat Müzesi", mapSourceName: "Istanbul Museum of Modern Art" }, [source]), null);
  assert.equal(matchPlaceSource({ title: "İstanbul Modern" }, [source]), null);
});
