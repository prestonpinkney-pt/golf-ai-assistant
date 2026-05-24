/**
 * Approved Primetime pricing strings used by SMS/booking tooling.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  compactPricingSmsForBayQuestion,
  lessonPricingSentence,
  PRIMETIME_LESSON_USD,
  PRIMETIME_SIMULATOR_GROUP_HOURLY_USD,
  PRIMETIME_SIMULATOR_SOL_HOURLY_USD,
} from "./pricing";

describe("Primetime SMS pricing helpers", () => {
  test("compact bay reply includes solo + group off-peak/peak totals", () => {
    const s = compactPricingSmsForBayQuestion();
    assert.match(s, new RegExp(String(PRIMETIME_SIMULATOR_SOL_HOURLY_USD.off_peak_weekday)));
    assert.match(s, new RegExp(String(PRIMETIME_SIMULATOR_SOL_HOURLY_USD.peak_weekend)));
    assert.match(s, new RegExp(String(PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.off_peak_weekday)));
    assert.match(s, new RegExp(String(PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.peak_weekend)));
  });

  test("lesson sentence bundles adult junior session prices", () => {
    const s = lessonPricingSentence();
    assert.match(s, new RegExp(String(PRIMETIME_LESSON_USD.adult_30_session)));
    assert.match(s, new RegExp(String(PRIMETIME_LESSON_USD.adult_60_session)));
    assert.match(s, new RegExp(String(PRIMETIME_LESSON_USD.junior_60_session)));
  });
});
