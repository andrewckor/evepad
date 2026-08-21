import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionPathOf, toolPathOf, schedulePathOf } from "./eve-paths.ts";

test("own connections live at the top level", () => {
  assert.equal(connectionPathOf("github"), "agent/connections/github.ts");
});

test("extension connections are namespaced under their extension", () => {
  assert.equal(
    connectionPathOf("shopify__orders"),
    "agent/extensions/shopify/connections/orders.ts",
  );
});

test("tools and schedules have fixed homes", () => {
  assert.equal(toolPathOf("weather"), "agent/tools/weather.ts");
  assert.equal(schedulePathOf("morning"), "agent/schedules/morning.ts");
});
