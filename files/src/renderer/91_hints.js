"use strict";

// The "Show hints while playing" feature: an entirely separate, resource-limited instance of the
// currently selected engine executable, used only to show the top few candidate moves (with scores
// and continuations) for the CURRENT position while a human plays against the engine.
//
// Deliberate design points:
//
//		- It is a different process from hub.engine, so the playing engine's MultiPV, difficulty,
//		  node/time limits, and persisted options are never touched.
//		- MultiPV = 3 (plus modest Threads/Hash) is set on THIS process only.
//		- Its "bestmove" is discarded; it can never play a move for either side.
//		- Every search gets a generation number; output from an abandoned search is discarded, so
//		  rapid moves / undo / new game can't leave stale hints on screen.
//
// The parsing, ranking, and score-conversion logic lives in modules/hints.js so that it can be
// unit tested without Electron; see test/hints.test.js.

function NewHintEngine(hub) {

	let hints = Object.create(null);

	hints.hub = hub;

	hints.exe = null;
	hints.scanner = null;
	hints.err_scanner = null;
	hints.have_quit = false;

	hints.filepath = "";					// The executable we are running (or tried to run).
	hints.failed_filepath = null;			// An executable we already failed with - don't retry it in a loop.
	hints.uciok = false;
	hints.ready = false;					// Received both uciok and readyok, and options have been sent.
	hints.supported = true;					// Set false if the engine has no MultiPV option.
	hints.chess960 = false;
	hints.known_options = Object.create(null);

	hints.searching = false;				// A "go" has been sent and no "bestmove" has come back yet.
	hints.stop_sent = false;				// A "stop" has been sent for the running search - don't send it again.
	hints.generation = 0;					// Incremented for every search (and every invalidation).
	hints.pending_node = null;				// Node we want to search as soon as we're able to.
	hints.node = null;						// Node the current results / pending search refer to.

	hints.store = hints_io.NewStore();
	hints.message = "";						// Non-fatal status message for the UI (e.g. no engine, unsupported engine).
	hints.dirty = true;						// Whether the UI needs redrawing.
	hints.drawn_html = null;
	hints.drawn_enabled = null;

	// -------------------------------------------------------------------------------------------
	// Lifecycle...

	hints.activate = function(filepath, args) {

		// Lazily start the hint process. Safe to call every time the position changes.

		if (this.exe && this.filepath === filepath) {
			return;
		}

		if (this.failed_filepath === filepath) {
			return;							// Already failed with this engine - don't spin up a restart loop.
		}

		if (this.exe) {
			this.shutdown();				// Engine was replaced.
		}

		if (!filepath || typeof filepath !== "string") {
			this.message = "Hints: no engine loaded.";
			this.dirty = true;
			return;
		}

		this.have_quit = false;
		this.uciok = false;
		this.ready = false;
		this.supported = true;
		this.chess960 = false;
		this.known_options = Object.create(null);
		this.searching = false;
		this.stop_sent = false;
		this.message = "Hints: starting engine...";
		this.dirty = true;

		try {
			this.exe = child_process.spawn(filepath, Array.isArray(args) ? args : [], {cwd: path.dirname(filepath)});
		} catch (err) {
			this.exe = null;
			this.failed_filepath = filepath;
			this.message = `Hints: could not start a second engine process (${err.toString()}).`;
			this.dirty = true;
			return;
		}

		this.filepath = filepath;

		this.exe.once("error", (err) => {
			if (this.have_quit) return;
			this.failed_filepath = filepath;
			this.message = `Hints: engine process error (${err.toString()}).`;
			this.shutdown();
		});

		this.exe.once("exit", () => {
			if (this.have_quit) return;
			this.message = "Hints: the hint engine process exited.";
			this.shutdown();
		});

		this.scanner = readline.createInterface({input: this.exe.stdout, output: undefined, terminal: false});
		this.err_scanner = readline.createInterface({input: this.exe.stderr, output: undefined, terminal: false});

		this.err_scanner.on("line", (line) => {
			// Deliberately ignored - the playing engine's stderr is already shown in the infobox.
		});

		this.scanner.on("line", (line) => {
			if (this.have_quit) return;
			this.receive(line);
		});

		this.send("uci");
	};

	hints.deactivate = function() {			// Toggled off, or left play mode.
		if (!this.exe && !this.node && !this.pending_node && !this.message) {
			return;							// Nothing to do - avoid needless churn, since this is called on every position change.
		}
		this.invalidate();
		this.message = "";
		this.shutdown();
	};

	hints.forget_failures = function() {	// Called when the user explicitly (re-)enables hints.
		this.failed_filepath = null;
	};

	hints.shutdown = function() {

		this.have_quit = true;
		this.searching = false;
		this.stop_sent = false;
		this.pending_node = null;
		this.ready = false;
		this.uciok = false;

		let exe = this.exe;

		this.exe = null;
		this.filepath = "";

		if (this.scanner) {
			this.scanner.close();
			this.scanner = null;
		}

		if (this.err_scanner) {
			this.err_scanner.close();
			this.err_scanner = null;
		}

		if (exe) {
			try {
				exe.stdin.write("quit\n");
			} catch (err) {
				// Pass - the process may already be gone.
			}
			setTimeout(() => {
				try {
					exe.kill();
				} catch (err) {
					// Pass.
				}
			}, 2000);
		}

		this.dirty = true;
	};

	// -------------------------------------------------------------------------------------------
	// Talking to the process...

	hints.send = function(msg) {
		if (!this.exe) {
			return;
		}
		try {
			this.exe.stdin.write(msg.trim() + "\n");
		} catch (err) {
			this.message = "Hints: lost contact with the hint engine.";
			this.shutdown();
		}
	};

	hints.receive = function(line) {

		if (line.startsWith("info")) {
			if (this.searching) {
				if (this.store.receive(this.generation, line)) {
					this.dirty = true;
				}
			}
			return;
		}

		if (line.startsWith("bestmove")) {
			// NEVER passed to the hub - hints must not play moves.
			this.searching = false;
			this.stop_sent = false;
			this.store.finish(this.generation);
			this.dirty = true;
			this.maybe_send_pending();
			return;
		}

		if (line.startsWith("option")) {
			let a = line.indexOf(" name ");
			let b = line.indexOf(" type ");
			if (a !== -1 && b !== -1) {
				this.known_options[line.slice(a + 6, b).trim().toLowerCase()] = true;
			}
			return;
		}

		if (line.startsWith("uciok")) {
			this.uciok = true;
			this.handle_uciok();
			return;
		}

		if (line.startsWith("readyok")) {
			if (this.uciok && this.supported) {
				this.ready = true;
				this.message = "";
				this.dirty = true;
				this.maybe_send_pending();
			}
			return;
		}
	};

	hints.handle_uciok = function() {

		if (!this.known_options["multipv"]) {
			this.supported = false;
			this.failed_filepath = this.filepath;
			this.message = "Hints: this engine has no MultiPV option, so hints are unavailable.";
			this.dirty = true;
			this.shutdown();
			return;
		}

		if (this.known_options["uci_chess960"]) {
			this.send("setoption name UCI_Chess960 value true");
			this.chess960 = true;
		}

		for (let [key, value] of Object.entries(hints_io.OPTIONS)) {
			if (this.known_options[key.toLowerCase()]) {
				this.send(`setoption name ${key} value ${value}`);
			}
		}

		this.send("isready");
	};

	// -------------------------------------------------------------------------------------------
	// Searching...

	// Called whenever the position (or anything else relevant) changes. Never plays a move.

	hints.analyse = function(node) {

		if (!node || node.destroyed) {
			this.invalidate();
			return;
		}

		if (this.node === node && (this.searching || this.pending_node === node || this.store.finished)) {
			return;									// Already dealing with this exact position.
		}

		this.invalidate();							// Old hints are cleared immediately, before anything else.
		this.node = node;

		let terminal = node.terminal_reason();

		if (terminal) {
			this.message = `Hints: game over (${terminal}).`;
			this.dirty = true;
			return;
		}

		this.store.begin(this.generation, node.board.active);
		this.pending_node = node;
		this.maybe_send_pending();
	};

	// Drop any results and ensure late output from the running search will be ignored.

	hints.invalidate = function() {
		this.generation++;
		this.store.clear();
		this.pending_node = null;
		this.node = null;
		this.message = "";
		this.dirty = true;
		if (this.searching && !this.stop_sent) {
			this.stop_sent = true;
			this.send("stop");						// The bestmove will arrive later and be discarded.
		}
	};

	hints.maybe_send_pending = function() {

		if (!this.pending_node || this.searching || !this.ready || !this.exe) {
			return;
		}

		let node = this.pending_node;

		if (node.destroyed || node.terminal_reason()) {
			this.pending_node = null;
			return;
		}

		let root_fen = node.get_root().board.fen(!this.chess960);
		let moves = this.chess960 ? node.history() : node.history_old_format();		// Full history, so repetitions are seen.

		if (moves.length === 0) {
			this.send(`position fen ${root_fen}`);
		} else {
			this.send(`position fen ${root_fen} moves ${moves.join(" ")}`);
		}

		this.send(`go movetime ${hints_io.BUDGET_MS}`);

		this.pending_node = null;
		this.searching = true;
		this.stop_sent = false;
	};

	// -------------------------------------------------------------------------------------------
	// Drawing...

	hints.draw = function(enabled) {

		if (!this.dirty && enabled === this.drawn_enabled) {
			return;							// Rendering PVs isn't free, and this is called from the main draw loop.
		}

		this.drawn_enabled = enabled;

		let html = enabled ? this.html() : "";

		if (html !== this.drawn_html) {
			hintscontent.innerHTML = html;
			this.drawn_html = html;
		}

		this.dirty = false;
	};

	hints.html = function() {

		let lines = [];

		let node = this.node;
		let active = node ? node.board.active : "w";

		lines.push(`<span class="hints_header">Hints for the current position &mdash; ${hints_io.side_to_move_string(active)}</span>`);
		lines.push(`<span class="hints_note">White perspective: + favors White, &minus; favors Black</span>`);

		if (this.message) {
			lines.push(`<span class="hints_note">${SafeStringHTML(this.message)}</span>`);
			return lines.join("<br>");
		}

		let entries = node ? this.store.list() : [];

		if (entries.length === 0) {
			lines.push(`<span class="hints_note">${this.searching || this.pending_node ? "Analysing..." : "Waiting for the engine..."}</span>`);
			return lines.join("<br>");
		}

		let depth = this.store.depth();

		lines.push(`<span class="hints_note">${this.store.finished ? "Done" : "Analysing"}${typeof depth === "number" ? ` &mdash; depth ${depth}` : ""}</span>`);

		for (let entry of entries) {
			let pv = this.nice_pv(node.board, entry.pv);
			let move = pv.length > 0 ? pv[0] : "?";
			let rest = pv.slice(1).join(" ");
			lines.push(
				`<span class="hints_rank">${entry.rank}.</span> ` +
				`<span class="hints_move">${SafeStringHTML(move)}</span> ` +
				`<span class="hints_score">${hints_io.format_score(entry.score)}</span> ` +
				`<span class="hints_pv">${SafeStringHTML(rest)}</span>`
			);
		}

		return lines.join("<br>");
	};

	hints.nice_pv = function(board, pv) {

		let result = [];

		for (let move of pv.slice(0, hints_io.MAX_PV_PLIES)) {
			if (board.illegal(move)) {
				break;
			}
			result.push(board.nice_string(move));
			board = board.move(move);
		}

		return result;
	};

	return hints;
}
