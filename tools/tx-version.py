#!/usr/bin/env python3
"""
tx-version — single source of truth for TimrX front-end cache-bust strings.

WHY THIS EXISTS
---------------
Every JS module and stylesheet is loaded with a `?v=` query string so browsers
re-fetch it after a deploy. ES module imports are cached *by URL*, so a module's
version must be identical in every file that imports it. Keeping those strings
in sync by hand has failed repeatedly:

  * 2026-08-12 — history.js content changed but `?v=` did not, so browsers kept
    a stale copy. The navbar, credits pill, BUY button and Assets history all
    went dead with `does not provide an export named 'syncAssetsToolbarFilters'`.
  * 2026-08-13 — a rebase nearly shipped mismatched versions across main.js and
    api.js for the same module.

The failure is silent: nothing errors at build time, and the page only breaks
for users whose cache holds the old file. This tool makes it loud.

USAGE
-----
  tx-version.py check                  # audit; exit 1 on any mismatch
  tx-version.py list                   # print the version of every asset
  tx-version.py bump FILE [FILE ...]   # give these assets a new version and
                                       # update every reference to them
  tx-version.py bump --changed         # bump whatever git says is modified
  tx-version.py bump --changed --tag library    # use a custom version suffix

`bump` also walks the *importer* chain: bumping history.js re-versions api.js
and main.js too, because their bytes changed when their import line changed,
and a browser holding a cached main.js would never see the new history.js URL.

Run from anywhere inside the front-end tree (or pass --root).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# Files we scan for references. Everything else is ignored.
SCAN_SUFFIXES = {".html", ".js", ".css"}

# Directories that never contain first-party source.
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "vendor", "__pycache__"}

# One reference = one (path, version) pair. Three syntaxes carry them:
#   <script src="js/main.js?v=X">      /  <link href="css/a.css?v=X">
#   import x from './history.js?v=X'
#   @import url('css/history.css?v=X')
REFERENCE_RE = re.compile(
    r"""(?P<path>[A-Za-z0-9_./@-]+\.(?:js|css|mjs))\?v=(?P<version>[A-Za-z0-9._-]+)"""
)


def find_root(start: Path) -> Path:
    """Walk up until we find the front-end root (the dir holding 3dprint.html)."""
    cur = start.resolve()
    for candidate in [cur, *cur.parents]:
        if (candidate / "3dprint.html").exists():
            return candidate
    return cur


def iter_source_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if Path(name).suffix in SCAN_SUFFIXES:
                yield Path(dirpath) / name


def resolve_target(referrer: Path, raw_path: str, root: Path) -> Path | None:
    """Map a reference string to a real file on disk, or None if unresolvable."""
    raw = raw_path.lstrip("/")
    candidates = []
    if raw_path.startswith("./") or raw_path.startswith("../"):
        candidates.append((referrer.parent / raw_path).resolve())
    else:
        # Bare paths are relative to the referrer first, then to the root.
        candidates.append((referrer.parent / raw).resolve())
        candidates.append((root / raw).resolve())
    for c in candidates:
        if c.exists() and c.is_file():
            return c
    return None


def collect(root: Path):
    """Return {target_path: {version: [(referrer, line_no), ...]}} plus unresolved refs."""
    refs = defaultdict(lambda: defaultdict(list))
    unresolved = []
    for src in iter_source_files(root):
        try:
            text = src.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            for m in REFERENCE_RE.finditer(line):
                target = resolve_target(src, m.group("path"), root)
                if target is None:
                    unresolved.append((src.relative_to(root), line_no, m.group(0)))
                    continue
                refs[target][m.group("version")].append((src.relative_to(root), line_no))
    return refs, unresolved


def rel(p: Path, root: Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def cmd_list(root: Path, args) -> int:
    refs, unresolved = collect(root)
    for target in sorted(refs, key=lambda p: rel(p, root)):
        versions = refs[target]
        marker = "  " if len(versions) == 1 else "!!"
        joined = ", ".join(sorted(versions))
        print(f"{marker} {rel(target, root):<48} {joined}")
    if unresolved:
        print(f"\n{len(unresolved)} reference(s) did not resolve to a file on disk:")
        for src, line_no, frag in unresolved:
            print(f"   {src}:{line_no}  {frag}")
    return 0


def cmd_check(root: Path, args) -> int:
    refs, unresolved = collect(root)
    problems = 0

    for target in sorted(refs, key=lambda p: rel(p, root)):
        versions = refs[target]
        if len(versions) <= 1:
            continue
        problems += 1
        print(f"MISMATCH  {rel(target, root)} is referenced with {len(versions)} different versions:")
        for version in sorted(versions):
            for src, line_no in versions[version]:
                print(f"            v={version:<24} {src}:{line_no}")
        print("            → browsers will cache one copy per URL; the stale one wins for")
        print("              anyone whose cache already holds it.")

    if unresolved and not args.allow_unresolved:
        problems += len(unresolved)
        print(f"\nUNRESOLVED  {len(unresolved)} reference(s) point at files that do not exist:")
        for src, line_no, frag in unresolved:
            print(f"            {src}:{line_no}  {frag}")

    if problems:
        print(f"\n{problems} problem(s). Fix with: tx-version.py bump <file>")
        return 1

    print(f"OK — {len(refs)} versioned asset(s), every reference agrees.")
    return 0


def build_importer_index(root: Path):
    """{target: {files that reference it}} — used to walk the bump chain upward."""
    refs, _ = collect(root)
    index = defaultdict(set)
    for target, versions in refs.items():
        for referrer_list in versions.values():
            for src, _line in referrer_list:
                index[target].add((root / src).resolve())
    return index


def expand_chain(seeds: set[Path], root: Path) -> set[Path]:
    """
    A changed module invalidates everything that imports it, transitively.

    main.js imports api.js imports history.js. Changing history.js rewrites
    api.js's import line, which changes api.js's bytes, which means main.js's
    reference to api.js must move too — otherwise a cached main.js keeps
    pointing at the old api.js URL and the new history.js is never reached.
    """
    index = build_importer_index(root)
    out = set(seeds)
    frontier = set(seeds)
    while frontier:
        nxt = set()
        for target in frontier:
            for importer in index.get(target, ()):
                # Only source modules carry their own version; entry-point HTML
                # is not itself referenced by anything, so the chain stops there.
                if importer.suffix in {".js", ".css"} and importer not in out:
                    out.add(importer)
                    nxt.add(importer)
        frontier = nxt
    return out


def git_changed_files(root: Path) -> list[Path]:
    try:
        proc = subprocess.run(
            ["git", "--no-optional-locks", "status", "--porcelain", "--", "."],
            cwd=root, capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"could not read git status: {exc}", file=sys.stderr)
        return []
    out = []
    for line in proc.stdout.splitlines():
        path = line[3:].strip().strip('"')
        if "->" in path:  # rename
            path = path.split("->")[-1].strip()
        candidate = (root / path).resolve()
        if candidate.suffix in {".js", ".css"} and candidate.exists():
            out.append(candidate)
    return out


def next_version(tag: str | None) -> str:
    stamp = _dt.date.today().strftime("%Y%m%d")
    return f"{stamp}{tag}" if tag else stamp


def cmd_bump(root: Path, args) -> int:
    seeds: set[Path] = set()
    if args.changed:
        seeds.update(git_changed_files(root))
    for name in args.files:
        p = (Path.cwd() / name).resolve()
        if not p.exists():
            p = (root / name).resolve()
        if not p.exists():
            print(f"no such file: {name}", file=sys.stderr)
            return 2
        seeds.add(p)

    if not seeds:
        print("nothing to bump (pass files, or --changed with a dirty tree)")
        return 0

    targets = expand_chain(seeds, root)
    version = args.version or next_version(args.tag)

    print(f"version → {version}")
    print("assets being re-versioned (seed + everything that imports them):")
    for t in sorted(targets, key=lambda p: rel(p, root)):
        why = "changed" if t in seeds else "imports a changed module"
        print(f"  {rel(t, root):<48} ({why})")

    target_set = {t.resolve() for t in targets}
    touched_files = set()

    for src in iter_source_files(root):
        try:
            text = src.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        original = text

        def replace(m: re.Match) -> str:
            resolved = resolve_target(src, m.group("path"), root)
            if resolved is None or resolved.resolve() not in target_set:
                return m.group(0)
            if m.group("version") == version:
                return m.group(0)
            return f"{m.group('path')}?v={version}"

        text = REFERENCE_RE.sub(replace, text)
        if text != original:
            if args.dry_run:
                print(f"  would update {rel(src, root)}")
            else:
                src.write_text(text, encoding="utf-8")
            touched_files.add(src)

    verb = "would rewrite" if args.dry_run else "rewrote"
    print(f"{verb} references in {len(touched_files)} file(s)")

    if args.dry_run:
        return 0

    print()
    return cmd_check(root, args)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", help="front-end root (defaults to the dir containing 3dprint.html)")
    ap.add_argument("--allow-unresolved", action="store_true",
                    help="do not fail on references whose target file is missing")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("check", help="fail if any asset is referenced with more than one version")
    sub.add_parser("list", help="print every versioned asset and its version(s)")

    b = sub.add_parser("bump", help="re-version assets and every reference to them")
    b.add_argument("files", nargs="*", help="assets that changed")
    b.add_argument("--changed", action="store_true", help="seed from `git status`")
    b.add_argument("--tag", help="suffix appended to today's date, e.g. --tag library")
    b.add_argument("--version", help="use this exact version string instead of a date")
    b.add_argument("--dry-run", action="store_true")

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return 0
    if not hasattr(args, "allow_unresolved"):
        args.allow_unresolved = False

    root = Path(args.root).resolve() if args.root else find_root(Path.cwd())
    if not (root / "3dprint.html").exists():
        print(f"{root} does not look like the front-end root (no 3dprint.html).", file=sys.stderr)
        print("Pass --root explicitly.", file=sys.stderr)
        return 2

    return {"check": cmd_check, "list": cmd_list, "bump": cmd_bump}[args.cmd](root, args)


if __name__ == "__main__":
    raise SystemExit(main())
