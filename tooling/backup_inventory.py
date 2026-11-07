#!/usr/bin/env python3
"""List local release-backup receipts and coverage without opening source stores or changing files."""
from pathlib import Path
import argparse, hashlib, json, os, stat

STORES = ("Qwen Local", "WebKit", "HTTPStorages", "preferences.plist")

def small_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 4 * 1024 * 1024:
            raise ValueError("Receipt is not a bounded regular single-link file")
        data = stream.read(4 * 1024 * 1024 + 1)
        after = os.fstat(stream.fileno())
        if len(data) != before.st_size or (before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("Receipt changed during read")
    return json.loads(data), hashlib.sha256(data).hexdigest()

def inventory(root):
    root = Path(root).absolute()
    if root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("Backup root must be a canonical directory")
    entries = sorted(root.iterdir(), key=lambda path: path.name)
    if len(entries) > 2000:
        raise ValueError("More than 2000 backup entries; choose a narrower reviewed backup root")
    rows = []
    for directory in entries:
        info = directory.lstat()
        row = {"name": directory.name, "path": str(directory),
               "contentsRehashed": False, "restoreVerified": False,
               "cleanupEligibility": "not_assessed"}
        if not stat.S_ISDIR(info.st_mode):
            row["status"] = "linked_or_non_directory_entry_skipped"
            rows.append(row)
            continue
        receipt_path = directory / "backup-receipt.json"
        try:
            receipt, digest = small_json(receipt_path)
            if not isinstance(receipt, dict):
                raise ValueError("Unrecognized receipt object")
            copies = receipt.get("backups")
            if not isinstance(copies, dict):
                raise ValueError("Unrecognized receipt coverage schema")
            coverage = {}
            for name in STORES:
                item = copies.get(name)
                if not isinstance(item, dict) or type(item.get("present")) is not bool:
                    coverage[name] = {"declared": False}
                    continue
                record = {"declared": True, "sourceWasPresent": item["present"], "copyMetadataMatches": False}
                if item["present"]:
                    expected = directory / name
                    if item.get("copy") == str(expected):
                        try:
                            copied = expected.lstat()
                            record["copyMetadataMatches"] = (stat.S_ISREG(copied.st_mode) if name == "preferences.plist" else stat.S_ISDIR(copied.st_mode))
                        except FileNotFoundError:
                            pass
                else:
                    record["copyMetadataMatches"] = not os.path.lexists(directory / name)
                coverage[name] = record
            row.update(status="receipt_metadata_read", receipt={"path": str(receipt_path), "sha256": digest},
                       createdAt=receipt.get("at"), coverage=coverage,
                       receiptDeclaresAllFourStores=set(copies) == set(STORES),
                       closedBoundaryReference=receipt.get("closedBoundary"))
        except FileNotFoundError:
            row["status"] = "no_current_schema_receipt"
        except (OSError, ValueError, TypeError) as error:
            row["status"] = "receipt_unreadable_or_unrecognized"
            row["reason"] = type(error).__name__
        rows.append(row)
    return {
        "schemaVersion": 1, "root": str(root), "entries": rows,
        "entryCount": len(rows),
        "scope": "Immediate directory and bounded receipt metadata only; backup payloads and original stores are not opened.",
        "coverageNotice": "Chat JSON exports do not include Tasks histories or complete workspace settings.",
        "restoreNotice": "A receipt is evidence of a past copy, not current restore acceptance. Restoration needs a separately reviewed closed-app workflow.",
        "cleanupNotice": "Do not delete a backup, runtime, intent or staging directory from this inventory alone. Active release and admission dependencies have not been classified.",
        "originalStoresOpened": False, "backupsModified": False,
        "deletions": 0, "restoreAttempted": False,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(inventory(args.backup_root), indent=2))

if __name__ == "__main__":
    main()
