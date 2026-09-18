"use strict";

// Dependency-free logic for the "Show hints while playing" feature - i.e. the automatic
// top-three candidate moves shown while a human plays against the engine ("play_white" /
// "play_black" behaviours). The Electron/DOM/process side of it lives in renderer/91_hints.js,
// which merely drives the store below and renders its results.
//
// Nothing here ever causes a move to be played; these results are display-only.
//
// Scores are always converted to White's perspective exactly once, at the moment an info line is
// stored (UCI reports scores from the side-to-move's perspective).

exports.MULTIPV = 3;						// Only ever set on the separate hint engine, never on the playing engine.
exports.BUDGET_MS = 1000;					// A modest per-position budget ("go movetime"), independent of the difficulty presets.
exports.OPTIONS = {						// Conservative resource use; only sent if the engine says it knows the option.
	"Threads": 1,
	"Hash": 16,
	"MultiPV": exports.MULTIPV,
};

exports.MAX_PV_PLIES = 6;					// How much of each principal variation we display.

// ---------------------------------------------------------------------------------------------------------------------
// Parsing...

// Given a raw UCI "info" line, return {rank, depth, score, pv} or null if the line carries no
// usable candidate-move information (e.g. "info string ...", "info currmove ...", or a bound).
// The score is left in the side-to-move's perspective here; conversion happens in receive().

exports.parse_info_line = (line) => {

	if (typeof line !== "string") {
		return null;
	}

	let tokens = line.trim().split(/\s+/);

	if (tokens[0] !== "info" || tokens[1] === "string") {
		return null;
	}

	let rank = 1;							// Engines without MultiPV (or before it's set) send no "multipv" token.
	let depth = null;
	let score = null;
	let pv = null;

	for (let i = 1; i < tokens.length; i++) {

		switch (tokens[i]) {

		case "multipv": {
			let n = parseInt(tokens[i + 1], 10);
			if (Number.isNaN(n) || n < 1) return null;
			rank = n;
			break;
		}

		case "depth": {
			let n = parseInt(tokens[i + 1], 10);
			depth = Number.isNaN(n) ? null : n;
			break;
		}

		case "score": {
			let type = tokens[i + 1];
			let n = parseInt(tokens[i + 2], 10);
			if ((type !== "cp" && type !== "mate") || Number.isNaN(n)) {
				return null;
			}
			score = {type: type, value: n};
			break;
		}

		case "upperbound":
		case "lowerbound":
			return null;					// Never display a value the engine itself says is unreliable.

		case "pv":
			pv = tokens.slice(i + 1).filter(z => z.length > 0);
			i = tokens.length;				// "pv" is always last.
			break;
		}
	}

	if (!score || !Array.isArray(pv) || pv.length === 0) {
		return null;
	}

	return {rank: rank, depth: depth, score: score, pv: pv};
};

// ---------------------------------------------------------------------------------------------------------------------
// Score conversion / formatting...

// Convert a side-to-move score into a White-perspective score. Call this exactly once per score.

exports.white_pov = (score, active) => {
	if (!score) {
		return null;
	}
	let sign = (active === "b") ? -1 : 1;
	return {type: score.type, value: score.value * sign};
};

// Format an already-White-perspective score for display. Positive favours White.

exports.format_score = (score) => {

	if (!score) {
		return "?";
	}

	if (score.type === "mate") {
		if (score.value === 0) {
			return "#";						// Mate on the board (some engines send "mate 0" for a mated position).
		}
		return (score.value > 0) ? `#${score.value}` : `#-${Math.abs(score.value)}`;
	}

	let pawns = score.value / 100;

	if (pawns === 0) {
		return "0.00";
	}

	return (pawns > 0 ? "+" : "\u2212") + Math.abs(pawns).toFixed(2);
};

exports.side_to_move_string = (active) => {
	return (active === "b") ? "Black to move" : "White to move";
};

// ---------------------------------------------------------------------------------------------------------------------
// The store. Results are tied to a "generation" (one per search we start); anything arriving for a
// different generation is late output from an abandoned search and must be discarded.

exports.NewStore = function() {

	let store = Object.create(null);

	store.generation = -1;					// -1 means "no search has ever been started".
	store.active = "w";						// Side to move in the position being analysed.
	store.entries = Object.create(null);	// rank --> {rank, depth, score (White POV), pv}
	store.finished = false;

	store.begin = function(generation, active) {
		this.generation = generation;
		this.active = (active === "b") ? "b" : "w";
		this.entries = Object.create(null);
		this.finished = false;
	};

	store.clear = function() {
		this.generation = -1;
		this.entries = Object.create(null);
		this.finished = false;
	};

	// Returns true iff the line was accepted (i.e. it was current, parseable, and not older info
	// for a rank we already have better info about).

	store.receive = function(generation, line) {

		if (generation !== this.generation || this.generation < 0) {
			return false;
		}

		let o = exports.parse_info_line(line);

		if (!o) {
			return false;
		}

		if (o.rank > exports.MULTIPV) {
			return false;
		}

		let old = this.entries[o.rank];

		if (old && typeof old.depth === "number" && typeof o.depth === "number" && o.depth < old.depth) {
			return false;
		}

		this.entries[o.rank] = {
			rank: o.rank,
			depth: o.depth,
			score: exports.white_pov(o.score, this.active),		// Converted here, exactly once.
			pv: o.pv,
		};

		return true;
	};

	store.finish = function(generation) {
		if (generation === this.generation) {
			this.finished = true;
			return true;
		}
		return false;
	};

	// Up to MULTIPV entries, ordered by the engine's own MultiPV rank, with duplicate first moves
	// removed (some engines re-send a line under a different rank during a search).

	store.list = function() {

		let result = [];
		let seen = Object.create(null);

		for (let rank = 1; rank <= exports.MULTIPV; rank++) {
			let entry = this.entries[rank];
			if (!entry) {
				continue;
			}
			if (seen[entry.pv[0]]) {
				continue;
			}
			seen[entry.pv[0]] = true;
			result.push(entry);
		}

		return result;
	};

	store.depth = function() {
		let shallowest = null;					// The shallowest line is the honest description of the whole set.
		for (let entry of this.list()) {
			if (typeof entry.depth === "number") {
				if (shallowest === null || entry.depth < shallowest) {
					shallowest = entry.depth;
				}
			}
		}
		return shallowest;
	};

	return store;
};
