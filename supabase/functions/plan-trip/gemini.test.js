import test from "node:test";
import assert from "node:assert/strict";
import { interactionSources, interactionText, matchPlaceSource, mergeSources } from "./gemini.js";

const response = {
  steps: [{
    type: "model_output",
    content: [{
      type: "text",
      text: "Grounded answer",
      annotations: [
        { type: "url_citation", title: "Official museum", url: "https://museum.example/visit" },
        { type: "place_citation", name: "İstanbul Modern", url: "https://maps.google.com/example" }
      ]
    }]
  }]
};

test("extracts grounded model text", () => {
  assert.equal(interactionText(response), "Grounded answer");
});

test("extracts only the requested citation type", () => {
  assert.deepEqual(interactionSources(response, "place_citation"), [{
    title: "İstanbul Modern",
    url: "https://maps.google.com/example",
    provider: "Google Maps"
  }]);
});

test("matches a localized stop to its Google Maps source", () => {
  const source = interactionSources(response, "place_citation")[0];
  assert.equal(matchPlaceSource({ title: "Istanbul Modern Sanat Müzesi", mapSourceName: "İstanbul Modern" }, [source]), source);
});

test("deduplicates sources by URL", () => {
  assert.equal(mergeSources(
    [{ title: "One", url: "https://example.com/a", provider: "Search" }],
    [{ title: "Two", url: "https://example.com/a", provider: "Maps" }]
  ).length, 1);
});
