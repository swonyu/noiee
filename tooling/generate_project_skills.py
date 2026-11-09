#!/usr/bin/env python3
"""Embed reviewed Markdown in existing runtime files; --check never writes."""
from pathlib import Path
import argparse
import base64
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source"
START = "    // BEGIN GENERATED PROJECT SKILLS\n"
END = "    // END GENERATED PROJECT SKILLS\n"
JS_START = "// BEGIN GENERATED PROJECT SKILL IDS\n"
JS_END = "// END GENERATED PROJECT SKILL IDS\n"


def catalog():
    directory = ROOT / "tooling/bundled-skills"
    manifest = json.loads((directory / "catalog.json").read_text())
    if set(manifest) != {"version", "ids"} or type(manifest["version"]) is not int or manifest["version"] != 1:
        raise ValueError("Unsupported bundled skill manifest")
    ids = manifest["ids"]
    if not isinstance(ids, list) or not ids or len(ids) > 128 or any(not isinstance(id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", id) or len(id) > 64 for id in ids) or len(ids) != len(set(ids)):
        raise ValueError("Invalid or duplicate bundled skill IDs")
    if set(p.name for p in directory.iterdir()) != {"catalog.json", *ids}:
        raise ValueError("Unlisted bundled skill input")
    rows = []
    for id in ids:
        folder = directory / id
        path = folder / "SKILL.md"
        if folder.is_symlink() or path.is_symlink() or not path.is_file() or set(p.name for p in folder.iterdir()) != {"SKILL.md"}:
            raise ValueError("Only reviewed regular SKILL.md text is supported: " + id)
        data = path.read_bytes()
        text = data.decode("utf-8")
        if not 0 < len(data) <= 64 * 1024 or "\0" in text or "\r" in text or not text.endswith("\n"):
            raise ValueError("Invalid bounded UTF-8/LF skill: " + id)
        if not re.match(r"\A---\nname: " + re.escape(id) + r"\ndescription: [^\n]+\n---\n", text):
            raise ValueError("Skill metadata does not match catalog: " + id)
        rows.append((id, hashlib.sha256(data).hexdigest(), base64.b64encode(data).decode()))
    return rows


def replace_region(text, start, end, content):
    if text.count(start) != 1 or text.count(end) != 1 or text.index(start) >= text.index(end):
        raise ValueError("Generated region is missing or ambiguous")
    before, rest = text.split(start)
    _, after = rest.split(end)
    return before + start + content + end + after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if committed runtime payloads differ from the reviewed Markdown.")
    args = parser.parse_args()
    rows = catalog()
    native = "    private static let bundled:[(String,String,String)]=[\n" + ",\n".join("        (" + ",".join(json.dumps(v) for v in row) + ")" for row in rows) + "\n    ]\n"
    js = "export const PROJECT_SKILL_IDS = Object.freeze(" + json.dumps([row[0] for row in rows], separators=(",", ":")) + ");\n"
    changed = []
    for path, start, end, content in [(SOURCE / "ProjectSkills.swift", START, END, native), (SOURCE / "agent.mjs", JS_START, JS_END, js)]:
        current = path.read_text()
        expected = replace_region(current, start, end, content)
        if current != expected:
            changed.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(expected)
    if args.check and changed:
        raise ValueError("Bundled skill drift; run tooling/generate_project_skills.py and review: " + ", ".join(changed))
    print(json.dumps({"checked": args.check, "skills": [{"id": row[0], "sha256": row[1]} for row in rows], "changed": changed}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
