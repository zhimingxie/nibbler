"use strict";

// Dependency-free checks for the "Show hints while playing" feature (see modules/hints.js and
// renderer/91_hints.js), in the same style as test/difficulty.test.js.
//
// Nibbler has no test framework or CI test step, so this uses only Node's built-in "assert" and
// can be run directly with:
//
//     node test/hints.test.js
//
// The pure logic (UCI MultiPV parsing, ranking, White-perspective conversion, stale-result
// rejection) lives in modules/hints.js and is tested directly. The process lifecycle in
// renderer/91_hints.js is tested by loading that file with stubbed renderer globals and running it
// against a fake UCI engine (a small Node script spawned like a real engine).

const assert = require("assert");
const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const hints = require("../modules/hints");
const difficulty = require("../modules/difficulty");

let passed = 0;

function test(name, fn) {
	fn();
	passed++;
	console.log(`ok - ${name}`);
}

async function async_test(name, fn) {
	await fn();
	passed++;
	console.log(`ok - ${name}`);
}

// -----------------------------------------------------------------------------------------------
// MultiPV parsing...

test("parse_info_line() reads rank, depth, score and pv", () => {
	let o = hints.parse_info_line("info depth 18 seldepth 24 multipv 2 score cp -35 nodes 12345 pv d2d4 g8f6 c2c4");
	assert.strictEqual(o.rank, 2);
	assert.strictEqual(o.depth, 18);
	assert.deepStrictEqual(o.score, {type: "cp", value: -35});
	assert.deepStrictEqual(o.pv, ["d2d4", "g8f6", "c2c4"]);
});

test("parse_info_line() treats a missing multipv token as rank 1", () => {
	let o = hints.parse_info_line("info depth 5 score cp 20 pv e2e4");
	assert.strictEqual(o.rank, 1);
});

test("parse_info_line() reads mate scores", () => {
	let o = hints.parse_info_line("info depth 12 multipv 1 score mate -3 pv e1g1");
	assert.deepStrictEqual(o.score, {type: "mate", value: -3});
});

test("parse_info_line() rejects lines with no usable candidate info", () => {
	assert.strictEqual(hints.parse_info_line("info string NNUE evaluation using nn-abcdef.nnue"), null);
	assert.strictEqual(hints.parse_info_line("info depth 4 currmove e2e4 currmovenumber 1"), null);
	assert.strictEqual(hints.parse_info_line("info depth 2 multipv 1 score cp 20 upperbound pv e2e4"), null);
	assert.strictEqual(hints.parse_info_line("bestmove e2e4"), null);
	assert.strictEqual(hints.parse_info_line(undefined), null);
});

// -----------------------------------------------------------------------------------------------
// Score conversion (exactly once) and formatting...

test("white_pov() leaves White-to-move scores alone and flips Black-to-move scores", () => {
	assert.deepStrictEqual(hints.white_pov({type: "cp", value: 35}, "w"), {type: "cp", value: 35});
	assert.deepStrictEqual(hints.white_pov({type: "cp", value: 35}, "b"), {type: "cp", value: -35});
	assert.deepStrictEqual(hints.white_pov({type: "mate", value: 3}, "w"), {type: "mate", value: 3});
	assert.deepStrictEqual(hints.white_pov({type: "mate", value: 3}, "b"), {type: "mate", value: -3});
});

test("format_score() shows pawn units with an explicit sign, and mates distinctly", () => {
	assert.strictEqual(hints.format_score({type: "cp", value: 35}), "+0.35");
	assert.strictEqual(hints.format_score({type: "cp", value: -120}), "\u22121.20");
	assert.strictEqual(hints.format_score({type: "cp", value: 0}), "0.00");
	assert.strictEqual(hints.format_score({type: "mate", value: 3}), "#3");
	assert.strictEqual(hints.format_score({type: "mate", value: -2}), "#-2");
	assert.strictEqual(hints.format_score(null), "?");
});

test("side_to_move_string() labels which side the suggestions are for", () => {
	assert.strictEqual(hints.side_to_move_string("w"), "White to move");
	assert.strictEqual(hints.side_to_move_string("b"), "Black to move");
});

// -----------------------------------------------------------------------------------------------
// The store: ranking, partial results, staleness...

test("store keeps up to three entries, in MultiPV rank order, converted once to White's POV", () => {
	let store = hints.NewStore();
	store.begin(1, "b");			// Black to move, so engine scores get flipped.
	store.receive(1, "info depth 10 multipv 2 score cp 50 pv d7d5 c2c4");
	store.receive(1, "info depth 10 multipv 1 score cp 80 pv g8f6 c2c4");
	store.receive(1, "info depth 10 multipv 3 score mate 4 pv e7e5");

	let list = store.list();
	assert.strictEqual(list.length, 3);
	assert.deepStrictEqual(list.map(o => o.rank), [1, 2, 3]);
	assert.deepStrictEqual(list.map(o => o.pv[0]), ["g8f6", "d7d5", "e7e5"]);
	assert.deepStrictEqual(list[0].score, {type: "cp", value: -80});
	assert.deepStrictEqual(list[2].score, {type: "mate", value: -4});
	assert.strictEqual(store.depth(), 10);
});

test("store handles partial results (fewer than three candidate moves)", () => {
	let store = hints.NewStore();
	store.begin(7, "w");
	store.receive(7, "info depth 9 multipv 1 score cp 12 pv e2e4");
	assert.strictEqual(store.list().length, 1);
});

test("store ignores duplicate first moves and ranks beyond MultiPV", () => {
	let store = hints.NewStore();
	store.begin(1, "w");
	store.receive(1, "info depth 9 multipv 1 score cp 12 pv e2e4 e7e5");
	store.receive(1, "info depth 9 multipv 2 score cp 10 pv e2e4 c7c5");
	assert.strictEqual(store.receive(1, "info depth 9 multipv 4 score cp 5 pv b1c3"), false);
	assert.strictEqual(store.list().length, 1);
});

test("store prefers deeper info and doesn't regress to shallower info for the same rank", () => {
	let store = hints.NewStore();
	store.begin(1, "w");
	store.receive(1, "info depth 20 multipv 1 score cp 30 pv e2e4");
	assert.strictEqual(store.receive(1, "info depth 3 multipv 1 score cp 900 pv a2a3"), false);
	assert.deepStrictEqual(store.list()[0].score, {type: "cp", value: 30});
});

test("store rejects late output from an abandoned search (stale generation)", () => {
	let store = hints.NewStore();
	store.begin(1, "w");
	store.receive(1, "info depth 10 multipv 1 score cp 30 pv e2e4");
	store.begin(2, "b");													// Position changed - old results cleared.
	assert.strictEqual(store.list().length, 0);
	assert.strictEqual(store.receive(1, "info depth 30 multipv 1 score cp 999 pv h2h4"), false);
	assert.strictEqual(store.finish(1), false);								// Late "bestmove" of the old search.
	assert.strictEqual(store.list().length, 0);
	assert.strictEqual(store.finished, false);
	assert.strictEqual(store.receive(2, "info depth 10 multipv 1 score cp 40 pv d7d5"), true);
});

test("store.clear() drops everything and refuses further input until a new search begins", () => {
	let store = hints.NewStore();
	store.begin(3, "w");
	store.receive(3, "info depth 10 multipv 1 score cp 30 pv e2e4");
	store.clear();
	assert.strictEqual(store.list().length, 0);
	assert.strictEqual(store.receive(3, "info depth 10 multipv 1 score cp 30 pv e2e4"), false);
});

// -----------------------------------------------------------------------------------------------
// Isolation from the difficulty / play settings, and from move execution...

const hints_source = fs.readFileSync(path.join(__dirname, "..", "renderer", "91_hints.js"), "utf8");

test("the hint engine never plays moves (no hub.move / receive_bestmove call in its source)", () => {
	assert.strictEqual(hints_source.includes("hub.move"), false);
	assert.strictEqual(hints_source.includes("receive_bestmove"), false);
	assert.strictEqual(hints_source.includes("this.hub"), false);			// The hub is never driven by hint results at all.
});

test("the hint engine never touches engineconfig or the difficulty settings", () => {
	assert.strictEqual(hints_source.includes("engineconfig"), false);
	assert.strictEqual(hints_source.includes("difficulty_io"), false);
	assert.strictEqual(fs.readFileSync(path.join(__dirname, "..", "modules", "hints.js"), "utf8").includes("require("), false);
});

test("hint budget/options are separate constants, not the difficulty presets", () => {
	assert.strictEqual(hints.MULTIPV, 3);
	assert.strictEqual(hints.BUDGET_MS, 1000);
	assert.strictEqual(hints.OPTIONS["MultiPV"], 3);
	assert.strictEqual(hints.OPTIONS["Threads"], 1);
	assert.ok(Object.values(difficulty.PRESETS).every(p => p.ms !== hints.BUDGET_MS));
});

test("config default is off, so existing users see no change until they opt in", () => {
	// modules/config_io.js can't be require()'d outside Electron, so check its defaults textually.
	let config_source = fs.readFileSync(path.join(__dirname, "..", "modules", "config_io.js"), "utf8");
	assert.ok(/"hints_while_playing":\s*false/.test(config_source));
});

// -----------------------------------------------------------------------------------------------
// Lifecycle tests against a fake UCI engine...

const FAKE_ENGINE = `
"use strict";
const readline = require("readline");
const rl = readline.createInterface({input: process.stdin, terminal: false});
const no_multipv = process.argv.includes("--no-multipv");
rl.on("line", (line) => {
	if (line === "uci") {
		console.log("id name FakeFish");
		if (!no_multipv) console.log("option name MultiPV type spin default 1 min 1 max 500");
		console.log("option name Threads type spin default 1 min 1 max 8");
		console.log("option name Hash type spin default 16 min 1 max 1024");
		console.log("uciok");
	} else if (line === "isready") {
		console.log("readyok");
	} else if (line.startsWith("go")) {
		console.log("info string hello");
		console.log("info depth 12 multipv 1 score cp 34 pv e2e4 e7e5 g1f3");
		console.log("info depth 12 multipv 2 score cp 12 pv d2d4 d7d5");
		console.log("info depth 12 multipv 3 score cp -5 pv b1c3 g8f6");
		setTimeout(() => console.log("bestmove e2e4"), 30);
	} else if (line === "stop") {
		console.log("bestmove e2e4");
	} else if (line === "quit") {
		process.exit(0);
	}
});
`;

let fake_engine_dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibbler-hints-test-"));
let fake_engine_path = path.join(fake_engine_dir, "fake_engine.js");
fs.writeFileSync(fake_engine_path, FAKE_ENGINE);

process.on("exit", () => {					// Registered immediately, so the temp dir goes away however we exit.
	try {
		fs.rmSync(fake_engine_dir, {recursive: true, force: true});
	} catch (err) {
		// Pass - a leftover temp directory isn't worth failing the run over.
	}
});

function FakeBoard(active) {
	return {
		active: active,
		fen: () => "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		illegal: () => "",
		nice_string: (s) => s.toUpperCase(),
		move: function() { return this; },
	};
}

function FakeNode(active = "w", history = ["e2e4", "e7e5"]) {
	let node = {
		destroyed: false,
		board: FakeBoard(active),
		terminal_reason: () => "",
		history: () => history,
		history_old_format: () => history,
	};
	node.get_root = () => node;
	return node;
}

function load_hint_engine() {

	// renderer/91_hints.js expects renderer globals rather than require() - supply stubs.

	let hintscontent = {innerHTML: ""};

	let factory = new Function(
		"child_process", "readline", "path", "hints_io", "SafeStringHTML", "hintscontent",
		hints_source + "\nreturn NewHintEngine;"
	);

	let NewHintEngine = factory(child_process, readline, path, hints, (s) => String(s), hintscontent);

	return {engine: NewHintEngine(), hintscontent};
}

function wait_for(predicate, ms = 5000) {
	return new Promise((resolve, reject) => {
		let start = Date.now();
		let check = () => {
			if (predicate()) {
				resolve();
			} else if (Date.now() - start > ms) {
				reject(new Error("timed out waiting for condition"));
			} else {
				setTimeout(check, 10);
			}
		};
		check();
	});
}

async function lifecycle_tests() {

	await async_test("hint engine starts lazily, sets MultiPV=3 only on itself, and reports three ranked candidates", async () => {

		let {engine, hintscontent} = load_hint_engine();
		let sent = [];
		let real_send = engine.send.bind(engine);
		engine.send = (msg) => { sent.push(msg); real_send(msg); };

		engine.activate(process.execPath, [fake_engine_path]);
		await wait_for(() => engine.ready);

		assert.ok(sent.includes("setoption name MultiPV value 3"));
		assert.ok(sent.includes("setoption name Threads value 1"));
		assert.ok(sent.includes("setoption name Hash value 16"));

		let node = FakeNode("w");
		engine.analyse(node);

		await wait_for(() => engine.store.list().length === 3);

		let list = engine.store.list();
		assert.deepStrictEqual(list.map(o => o.rank), [1, 2, 3]);
		assert.deepStrictEqual(list[0].score, {type: "cp", value: 34});

		// Full move history is sent, so repetition context is preserved...

		assert.ok(sent.some(msg => msg.startsWith("position fen ") && msg.includes("moves e2e4 e7e5")));
		assert.ok(sent.includes(`go movetime ${hints.BUDGET_MS}`));

		// The "bestmove" must not play anything - it only ends the search...

		await wait_for(() => engine.searching === false);
		assert.strictEqual(engine.store.finished, true);
		assert.strictEqual(engine.store.list().length, 3);

		engine.draw(true);
		assert.ok(hintscontent.innerHTML.includes("White perspective"));
		assert.ok(hintscontent.innerHTML.includes("White to move"));
		assert.ok(hintscontent.innerHTML.includes("+0.34"));

		engine.deactivate();
	});

	await async_test("a new position clears old hints immediately and discards the old search's output", async () => {

		let {engine} = load_hint_engine();
		engine.activate(process.execPath, [fake_engine_path]);
		await wait_for(() => engine.ready);

		let node1 = FakeNode("w");
		engine.analyse(node1);
		await wait_for(() => engine.store.list().length === 3);

		let old_generation = engine.generation;

		let node2 = FakeNode("b", ["e2e4", "e7e5", "g1f3"]);
		engine.analyse(node2);

		assert.strictEqual(engine.store.list().length, 0);					// Cleared instantly.
		assert.notStrictEqual(engine.generation, old_generation);
		assert.strictEqual(engine.store.receive(old_generation, "info depth 30 multipv 1 score cp 999 pv h2h4"), false);

		await wait_for(() => engine.store.list().length === 3);
		assert.deepStrictEqual(engine.store.list()[0].score, {type: "cp", value: -34});		// Black to move, flipped.

		engine.deactivate();
	});

	await async_test("terminal positions produce a message and no search", async () => {

		let {engine} = load_hint_engine();
		engine.activate(process.execPath, [fake_engine_path]);
		await wait_for(() => engine.ready);

		let node = FakeNode("w");
		node.terminal_reason = () => "Checkmate";
		engine.analyse(node);

		assert.strictEqual(engine.searching, false);
		assert.ok(engine.terminal_message.includes("Checkmate"));
		engine.draw(true);
		assert.strictEqual(engine.store.list().length, 0);

		engine.deactivate();
	});

	await async_test("an engine without MultiPV degrades gracefully and doesn't restart in a loop", async () => {

		let {engine} = load_hint_engine();
		engine.activate(process.execPath, [fake_engine_path, "--no-multipv"]);
		await wait_for(() => engine.supported === false);

		assert.strictEqual(engine.exe, null);
		assert.ok(engine.message.includes("MultiPV"));

		engine.activate(process.execPath, [fake_engine_path, "--no-multipv"]);			// Must not respawn.
		assert.strictEqual(engine.exe, null);

		engine.deactivate();
	});

	await async_test("deactivate() shuts the extra process down and leaves nothing running", async () => {

		let {engine} = load_hint_engine();
		engine.activate(process.execPath, [fake_engine_path]);
		await wait_for(() => engine.ready);

		let pid = engine.exe.pid;
		engine.analyse(FakeNode("w"));
		engine.deactivate();

		assert.strictEqual(engine.exe, null);
		assert.strictEqual(engine.searching, false);
		assert.strictEqual(engine.pending_node, null);
		assert.strictEqual(engine.store.list().length, 0);

		await wait_for(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (err) {
				return true;			// Process is gone.
			}
		});
	});

	await async_test("a failed process start yields a nonfatal message, not a crash", async () => {

		let {engine, hintscontent} = load_hint_engine();
		engine.activate(path.join(os.tmpdir(), "definitely-not-an-engine-" + Date.now()), []);
		await wait_for(() => engine.message.length > 0);
		assert.ok(engine.message.startsWith("Hints:"));

		// The engine-level message must survive a position change (which calls invalidate())...

		engine.analyse(FakeNode("w"));
		assert.ok(engine.message.startsWith("Hints:"));
		engine.draw(true);
		assert.ok(hintscontent.innerHTML.includes("Hints:"));

		engine.deactivate();
		assert.strictEqual(engine.message, "");
	});
}

lifecycle_tests().then(() => {
	console.log(`\n${passed} test(s) passed.`);
	process.exit(0);
}).catch(err => {
	console.log(`\nFAILED: ${err.stack || err}`);
	process.exit(1);
});

// -----------------------------------------------------------------------------------------------
// Manual verification (not automated - requires a running Electron GUI with a real Stockfish):
//
//   1. Load Stockfish, tick "Show hints while playing", then Play > Play this colour. Confirm that
//      on YOUR turn (and after every engine reply) up to three candidate moves appear with scores
//      and continuations, and that Nibbler stays in play mode throughout.
//   2. Move quickly several times in a row; confirm hints for old positions never linger (the
//      panel shows "Analysing..." until fresh results arrive).
//   3. Confirm the engine still replies at the speed set by the Difficulty dropdown, that the
//      Engine menu's MultiPV / Threads / Hash are unchanged, and that engines.json is not modified
//      by the hint feature.
//   4. Untick the checkbox, or leave play mode, and confirm the second engine process disappears
//      (e.g. in Task Manager / "ps"), and that ordinary analysis behaves exactly as before.
//   5. Try an engine with no MultiPV option: a clear message should appear instead of a crash.
