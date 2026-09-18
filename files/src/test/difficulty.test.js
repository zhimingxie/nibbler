"use strict";

// Lightweight, dependency-free checks for the "difficulty" feature (see modules/difficulty.js,
// modules/engineconfig_io.js, and the effective_search_limit()/set_difficulty() glue in
// renderer/95_hub.js).
//
// Nibbler has no existing test framework or CI test step, so this uses only Node's built-in
// "assert" module and can be run directly with:
//
//     node test/difficulty.test.js
//
// (run from the files/src directory, or anywhere - the paths below are relative to this file).
//
// hub.js itself is tightly coupled to the DOM/Electron renderer globals and isn't practical to
// unit test directly, so the actual decision logic it relies on (effective_search_params) lives in
// the dependency-free modules/difficulty.js module and is exercised here instead. Manual, in-app
// verification steps for the parts that can't be covered this way are listed at the bottom of this
// file and in the PR description.

const assert = require("assert");

const difficulty = require("../modules/difficulty");
const engineconfig_io = require("../modules/engineconfig_io");		// Safe to require outside Electron - see try/catch around exports.filepath.

let passed = 0;

function test(name, fn) {
	fn();
	passed++;
	console.log(`ok - ${name}`);
}

// -----------------------------------------------------------------------------------------------
// Preset mapping / units (ms, matching "go movetime <ms>" in engine.js)...

test("presets have the documented ms budgets", () => {
	assert.strictEqual(difficulty.PRESETS.easy.ms, 100);
	assert.strictEqual(difficulty.PRESETS.medium.ms, 500);
	assert.strictEqual(difficulty.PRESETS.hard.ms, 2000);
});

test("sanitize() maps unknown/missing values to custom", () => {
	assert.strictEqual(difficulty.sanitize(undefined), "custom");
	assert.strictEqual(difficulty.sanitize(null), "custom");
	assert.strictEqual(difficulty.sanitize("nonsense"), "custom");
	assert.strictEqual(difficulty.sanitize("hard"), "hard");
});

// -----------------------------------------------------------------------------------------------
// Persistence / backward compatibility with old engines.json entries...

test("newentry() defaults to custom (i.e. unchanged legacy behaviour)", () => {
	let entry = engineconfig_io.newentry();
	assert.strictEqual(entry.difficulty, "custom");
});

test("fix() migrates an old-style entry (no difficulty field) to custom, without touching other fields", () => {
	let cfg = {
		"/path/to/stockfish": {
			args: ["--old-flag"],
			options: {Threads: 4, Hash: 512},
			search_nodes: 500000,
			search_nodes_special: 10000000,
			limit_by_time: true,
			// no "difficulty" field at all - simulates a pre-existing engines.json
		},
	};
	engineconfig_io.fix(cfg);
	let entry = cfg["/path/to/stockfish"];
	assert.strictEqual(entry.difficulty, "custom");
	assert.strictEqual(entry.search_nodes, 500000);
	assert.strictEqual(entry.search_nodes_special, 10000000);
	assert.strictEqual(entry.limit_by_time, true);
	assert.deepStrictEqual(entry.options, {Threads: 4, Hash: 512});
});

test("fix() rejects a garbage difficulty value back to custom", () => {
	let cfg = {"/some/engine": {difficulty: "impossible"}};
	engineconfig_io.fix(cfg);
	assert.strictEqual(cfg["/some/engine"].difficulty, "custom");
});

test("fix() preserves an already-valid difficulty value", () => {
	let cfg = {"/some/engine": {difficulty: "hard"}};
	engineconfig_io.fix(cfg);
	assert.strictEqual(cfg["/some/engine"].difficulty, "hard");
});

// -----------------------------------------------------------------------------------------------
// Custom fallback / engine switching: each engineconfig entry carries its own independent choice...

test("effective_search_params: custom keeps the caller's manual fallback limit untouched", () => {
	let cfg = {difficulty: "custom", limit_by_time: false};
	let result = difficulty.effective_search_params("play_white", cfg, /* fallback_limit */ 250000, /* fallback_by_time */ false);
	assert.deepStrictEqual(result, {limit: 250000, by_time: false});
});

test("effective_search_params: easy/medium/hard override to their documented ms budgets, as a time limit", () => {
	let cfgEasy   = {difficulty: "easy"};
	let cfgMedium = {difficulty: "medium"};
	let cfgHard   = {difficulty: "hard"};

	assert.deepStrictEqual(difficulty.effective_search_params("play_white", cfgEasy,   999, false), {limit: 100,  by_time: true});
	assert.deepStrictEqual(difficulty.effective_search_params("play_black", cfgMedium, 999, false), {limit: 500,  by_time: true});
	assert.deepStrictEqual(difficulty.effective_search_params("play_white", cfgHard,   999, false), {limit: 2000, by_time: true});
});

test("effective_search_params: switching engines/entries is independent (no cross-contamination)", () => {
	let stockfish_cfg = {difficulty: "hard"};
	let other_cfg      = {difficulty: "custom"};

	assert.deepStrictEqual(difficulty.effective_search_params("play_white", stockfish_cfg, 12345, false), {limit: 2000, by_time: true});
	assert.deepStrictEqual(difficulty.effective_search_params("play_white", other_cfg,      12345, false), {limit: 12345, by_time: false});
});

test("effective_search_params: no engine/config selected is handled gracefully (falls back, doesn't throw)", () => {
	assert.doesNotThrow(() => {
		let result = difficulty.effective_search_params("play_white", null, 42, true);
		assert.deepStrictEqual(result, {limit: 42, by_time: true});
	});
});

// -----------------------------------------------------------------------------------------------
// Isolation: analysis / self-play / auto-eval must NEVER be affected by the difficulty setting...

test("effective_search_params: analysis, self-play, and auto/back-analysis ignore difficulty entirely", () => {
	let cfg = {difficulty: "easy"};		// Even with a preset selected...
	for (let behaviour of ["halt", "analysis_free", "analysis_locked", "self_play", "auto_analysis", "back_analysis"]) {
		let result = difficulty.effective_search_params(behaviour, cfg, 777777, false);
		assert.deepStrictEqual(result, {limit: 777777, by_time: false}, `behaviour "${behaviour}" should not be affected by difficulty`);
	}
});

console.log(`\n${passed} test(s) passed.`);

// -----------------------------------------------------------------------------------------------
// Manual verification (not automated - requires a running Electron GUI with Stockfish loaded):
//
//   1. Load Stockfish, pick Easy/Medium/Hard from the new "Difficulty" dropdown, then
//      Play > Play this colour. Confirm the engine replies quickly (roughly matching the
//      chosen ms budget) and that the dropdown's value survives an app restart.
//   2. With a difficulty preset selected, start "Start self-play" and separately trigger
//      auto-analysis; confirm both still honour the existing Engine > Limit settings, i.e. the
//      difficulty preset is NOT applied to them.
//   3. Switch to a different engine, confirm the dropdown shows that engine's own remembered
//      difficulty (or "Custom" the first time), independent of the previous engine's choice.
//   4. Change difficulty while the engine is already thinking on your behalf; confirm no
//      duplicate "bestmove" / desynced state occurs (status box should not show "desync").
