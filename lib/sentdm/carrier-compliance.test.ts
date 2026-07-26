import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectCarrierComplianceKind,
  isCarrierHelpKeyword,
  isCarrierStartKeyword,
  isCarrierStopKeyword,
  normalizeCarrierKeywordMessage,
} from "./carrier-compliance";

describe("carrier compliance keywords", () => {
  test("STOP / END / CANCEL / UNSUBSCRIBE map to stop branch (handled before AI)", () => {
    assert.equal(detectCarrierComplianceKind("STOP"), "stop");
    assert.equal(detectCarrierComplianceKind("end"), "stop");
    assert.equal(detectCarrierComplianceKind("CANCEL"), "stop");
    assert.equal(detectCarrierComplianceKind("unsubscribe"), "stop");
    assert.ok(isCarrierStopKeyword(normalizeCarrierKeywordMessage("STOP")));
  });

  test("HELP / INFO map to help branch (handled before AI)", () => {
    assert.equal(detectCarrierComplianceKind("HELP"), "help");
    assert.equal(detectCarrierComplianceKind("info"), "help");
    assert.ok(isCarrierHelpKeyword(normalizeCarrierKeywordMessage("INFO")));
  });

  test("START / UNSTOP / SUBSCRIBE map to start branch (handled before AI)", () => {
    assert.equal(detectCarrierComplianceKind("START"), "start");
    assert.equal(detectCarrierComplianceKind("unstop"), "start");
    assert.equal(detectCarrierComplianceKind("SUBSCRIBE"), "start");
    assert.ok(isCarrierStartKeyword(normalizeCarrierKeywordMessage("START")));
  });

  test("normal conversation text does not trigger compliance shortcuts", () => {
    assert.equal(detectCarrierComplianceKind("Do you offer memberships?"), null);
    assert.equal(isCarrierStopKeyword("please stop asking"), false);
    assert.equal(isCarrierStartKeyword("please start my lesson"), false);
  });
});
