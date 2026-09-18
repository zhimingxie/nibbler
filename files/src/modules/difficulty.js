"use strict";

// Centralized "difficulty" presets, used only for human-vs-engine play (the "play_white" /
// "play_black" behaviours started via "Play this colour"). These are NOT calibrated Elo levels,
// nor a guarantee of beginner-friendly play - they simply bound how long the engine is allowed to
// think per move. A strong engine (e.g. Stockfish) may still play very well even on "Easy".
//
// Units are milliseconds, matching the UCI "go movetime <ms>" command used by engine.js when a
// search is time-limited (see send_desired() in 90_engine.js). Analysis (free or locked),
// auto-evaluation, back-analysis, and self-play are completely unaffected by this setting; they
// keep using the pre-existing search_nodes / search_nodes_special / limit_by_time config values,
// exactly as they did before this feature existed.

exports.CUSTOM = "custom";

exports.PRESETS = {
	"easy":   {label: "Easy",   ms: 100},
	"medium": {label: "Medium", ms: 500},
	"hard":   {label: "Hard",   ms: 2000},
};

exports.DEFAULT = exports.CUSTOM;			// Backward-compatible default for engines/configs that never chose a difficulty.

// Only these behaviours represent "a human is playing against the engine". Self-play, analysis,
// and auto/back-analysis must never be affected by the difficulty setting.

exports.PLAY_BEHAVIOURS = Object.freeze(["play_white", "play_black"]);

exports.is_valid = (value) => {
	return value === exports.CUSTOM || Object.prototype.hasOwnProperty.call(exports.PRESETS, value);
};

exports.sanitize = (value) => {
	return exports.is_valid(value) ? value : exports.CUSTOM;
};

// Given the current behaviour and an engineconfig entry (cfg), work out the actual search
// parameters that should be used. If the behaviour isn't human-vs-engine play, or the chosen
// difficulty is "custom" (or missing/invalid, e.g. an older engines.json with no such field), the
// caller's normal (manual) fallback limit is returned completely unchanged.

exports.effective_search_params = (behaviour, cfg, fallback_limit, fallback_by_time) => {

	if (!cfg || exports.PLAY_BEHAVIOURS.includes(behaviour) === false) {
		return {limit: fallback_limit, by_time: fallback_by_time};
	}

	let preset = exports.PRESETS[cfg.difficulty];

	if (!preset) {
		return {limit: fallback_limit, by_time: fallback_by_time};
	}

	return {limit: preset.ms, by_time: true};
};
