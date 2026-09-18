# Nibbler

Nibbler is a real-time analysis GUI for [Leela Chess Zero](http://lczero.org/play/quickstart/) (Lc0), which runs Leela in the background and constantly displays opinions about the current position. You can also compel the engine to evaluate one or more specific moves. Nibbler is loosely inspired by [Lizzie](https://github.com/featurecat/lizzie) and [Sabaki](https://github.com/SabakiHQ/Sabaki).

These days, Nibbler more-or-less works with traditional engines like [Stockfish](https://stockfishchess.org/), too. (Ensure `MultiPV` is `1`, `Threads` (CPU) is set, and `Hash` is set (more is better), for maximum strength.)

For prebuilt binary releases, see the [Releases](https://github.com/rooklift/nibbler/releases) section. For help, the [Discord](https://discordapp.com/invite/pKujYxD) may be your best bet, or open an issue here.

![Screenshot](https://user-images.githubusercontent.com/16438795/270297798-a432ea17-3601-4143-bddb-97420a0d6e6c.png)

## Features

* Display Leela's top choices graphically.
* Winrate graph.
* Optionally shows Leela statistics like N, P, Q, S, U, V, and WDL for each move.
* UCI `searchmoves` functionality.
* Automatic full-game analysis.
* Play against Leela from any position.
* Optional automatic top-three hints (with scores and continuations) while playing.
* Leela self-play from any position.
* PGN loading via menu, clipboard, or drag-and-drop.
* Supports PGN variations of arbitrary depth.
* FEN loading.
* Chess 960.

## Installation - Windows / Linux

Some Windows and Linux standalone releases are uploaded to the [Releases](https://github.com/rooklift/nibbler/releases) section from time to time.

*Alternatively*, it is possible to run Nibbler from source. This requires Electron, but has no other dependencies. If you have Electron installed (e.g. `npm install -g electron`) you can likely enter the `/src` directory, then do `electron .` to run it. Nibbler should be compatible with at least version 5 and above.

You could also build a standalone app. See comments inside the Python script `builder.py` for info.

## Linux install script

Linux users can make use of the following *one-liner* to install the latest version of Nibbler:

```bash
curl -L https://raw.githubusercontent.com/rooklift/nibbler/master/files/scripts/install.sh | bash
```

## Installation - Mac

Mac builds have been made by [twoplan](https://github.com/twoplan/Nibbler-for-macOS) and [Jac-Zac](https://github.com/Jac-Zac/Nibbler_MacOS) and [Zamana](https://github.com/Zamana/nibbler) - the last of which is probably the most up-to-date.

## Mac install script

Alternatively, MacOS users can run the following *one-liner* to assemble Nibbler locally. This (hopefully) removes any codesigning issues (Gatekeeper refusing to open unauthorized apps) by building Nibbler on-the-fly, though I can't test it myself:

```bash
curl -L https://raw.githubusercontent.com/rooklift/nibbler/master/files/scripts/install_mac.sh | bash
```

## Advanced engine options

Most people won't need them, but all of Leela's engine options can be set in two ways:

* Leela automatically loads options from a file called `lc0.config` at startup - see [here](https://lczero.org/play/configuration/flags/#config-file).
* Nibbler will send UCI options specified in Nibbler's own `engines.json` file (which you can find via the Dev menu).

## Playing against the engine, with a difficulty preset

To play against the loaded engine (Leela or Stockfish, etc.):

1. Load and configure an engine (see above).
2. Optionally pick a difficulty from the **Difficulty** dropdown below the board: Easy, Medium, Hard, or Custom.
3. Use **Play &gt; Play this colour**. This makes the engine play whichever colour is *currently* to move (so, to play White yourself, make sure it's Black's turn before selecting it - e.g. play your first move as White, then choose "Play this colour" once it's Black to move, and the engine will reply as Black).

The difficulty presets are simple per-move thinking-time budgets, applied only while playing this way:

| Difficulty | Budget       |
|---|---|
| Easy       | 100 ms/move  |
| Medium     | 500 ms/move  |
| Hard       | 2000 ms/move |
| Custom     | Whatever manual node/time limit you've set in the Engine menu (this is the default, and what existing configs keep using) |

These are relative speed limits only, **not** calibrated Elo ratings or a guarantee of beginner-friendly play - a strong engine such as Stockfish can still play very well even on "Easy". The setting has no effect on analysis, self-play, or automatic full-game analysis, which continue to use the existing Engine-menu node/time limits. Your choice is remembered per engine and survives restarting Nibbler.

## Automatic hints while playing

While playing against the engine you can have Nibbler show you the top three candidate moves for the *current* position, whoever is to move:

1. Start a game as above (**Play &gt; Play this colour**).
2. Tick the **Show hints while playing** checkbox below the board.

The hint panel then refreshes automatically after every move by either side, showing (up to) three distinct candidate moves ranked by the engine's own `MultiPV` ranking, each with its evaluation and a short continuation. Fewer lines are shown if the position has fewer legal moves or if analysis is still in progress; a message is shown instead in checkmate/stalemate and other terminal positions.

* Scores are always given in pawn units from **White's perspective** (`+` favors White, `−` favors Black); mates are shown as `#3` / `#−3`.
* Hints are display-only - they never play a move for you or for the engine.
* When the position changes, old hints are cleared immediately and the panel shows `Analysing...` until fresh results arrive.

**Resource cost:** hints run in a *second*, deliberately small instance of the same engine executable (`MultiPV` 3, `Threads` 1, `Hash` 16 MB, about 1000 ms per position). That process is only started when hints are enabled during play, and is shut down when you untick the box, leave play mode, switch engines, or quit. Because both processes share your CPU, having hints on can still slow the opponent's search a little - this is contention, not a change of settings.

**Independent of difficulty:** the hint engine's `MultiPV`, time budget, `Threads` and `Hash` apply only to itself. The playing engine's difficulty preset, `MultiPV`, node/time limits, and everything stored in `engines.json` are untouched. The checkbox is off by default (including for existing configs) and its state is remembered in `config.json`. If the chosen engine has no `MultiPV` option, a message is shown and hints are simply unavailable.

## Hints and tips

An option to enable the UCI `searchmoves` feature is available in the Analysis menu. Once enabled, one or more moves can be specified as moves to focus on; Leela will ignore other moves. This is useful when you think Leela isn't giving a certain move enough attention.

Leela forgets much of the evaluation if the position changes. To mitigate this, an option in the Analysis menu allows you to hover over a PV (on the right) and see it play out on the board, without changing the position we're actually analysing. You might prefer to halt Leela while doing this, so that the PVs don't change while you're looking at them.

Leela running out of RAM can be a problem if searches go on too long. You might like to set a reasonable node limit (in the Engine menu), perhaps 10 million or so.

## Thanks

Thanks to everyone in Discord and GitHub who's offered advice and suggestions; and thanks to all Lc0 devs and GPU-hours contributors!

The pieces are from [Lichess](https://lichess.org/).

Icon design by [ciriousjoker](https://github.com/ciriousjoker) based on [this](https://www.svgrepo.com/svg/155301/chess).
