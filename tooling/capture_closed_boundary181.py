"""Read-only current stopped-boundary capture for Noiee Build180 to Build181.

Adapted from the committed Build180 capture (17af50a); see release_helpers/PROVENANCE.json.

This helper reads the installed predecessor and the four original data stores.
It never opens SQLite, invokes the app/model, changes a lease, or changes data.
The only write is one exclusive JSON receipt beneath this release directory.
The receipt is a current preservation baseline, not historical normal-Quit,
owner-recovery, native acceptance, or release-admission evidence.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import plistlib
import stat
import subprocess
import sys
import types

sys.dont_write_bytecode = True

PROJECT = Path(__file__).resolve().parents[1]
RELEASE = Path('/Users/saleh/Documents/Noiee/releases/build181')
APP = Path("/Users/saleh/Applications/Saleh Uncensored.app")
STAGE180 = Path('/Users/saleh/Library/Application Support/Saleh Uncensored Release Staging/Noiee180-e_lowahb')
HELPER = Path(__file__).resolve().parent / "release_helpers/build-candidate.py"
HELPER_SHA = "185fd10cf66b9a87054db4d3a13b6cdfa82c22190ad219b6492bc9ee5528ae03"
BUNDLE_SHA = '4ee21b56a7a3bcf13257b06ec9cabc9d504f4b3c05bf28b7f749c63c912e1782'
PACKAGE_SHA = 'dd0ed11426e7debb6d939d6ccc600be7bb9fe46f35106f795dd00cffc2a4570d'
BINARY_SHA = '6eb5b560ccc9c8b7e16ff74108018aeabbf004c89e9afe3a2fc41fded1a7f578'
EXTRA_SERVERS = (
    str(PROJECT / "source/server.mjs"),
    "/Users/saleh/Documents/Noiee/source/server.mjs",
    "/Users/saleh/Library/Caches/SalehParity171/combined-tv_m1qqk/source/server.mjs",
)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular_bytes(path, limit, expected=None, private=False):
    path = Path(path)
    require(path.resolve(strict=True) == path and not path.is_symlink(),
            "Noncanonical artifact: " + str(path))
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_uid == os.getuid() and before.st_size <= limit,
            "Unsafe artifact: " + str(path))
    if private:
        require(not stat.S_IMODE(before.st_mode) & 0o077,
                "Artifact is not private: " + str(path))
    raw = path.read_bytes()
    after = path.lstat()
    fields = ("st_dev", "st_ino", "st_uid", "st_mode", "st_nlink",
              "st_size", "st_mtime_ns", "st_ctime_ns")
    require(all(getattr(before, key) == getattr(after, key) for key in fields)
            and len(raw) == before.st_size, "Artifact changed while reading")
    require(expected is None or digest(raw) == expected,
            "Pinned artifact changed: " + str(path))
    return raw


def helpers():
    raw = regular_bytes(HELPER, 1024 * 1024, HELPER_SHA)
    module = types.ModuleType("noiee_readonly_build40_guards")
    module.__file__ = str(HELPER)
    # The pinned helper has only definitions/constant assignments on import;
    # its compiler entry is protected by its __main__ condition.
    exec(compile(raw, str(HELPER), "exec"), module.__dict__)
    h = module.__dict__
    h.update(BASE=RELEASE, SOURCE=PROJECT / "source")
    require(h["APP"] == APP, "Pinned predecessor app path differs")
    return h


def require_stopped(h):
    h["require_stopped"]()
    result = subprocess.run(
        ["/bin/ps", "-ww", "-axo", "pid=,ppid=,command="],
        capture_output=True, text=True, timeout=15, check=True)
    require(bool(result.stdout.strip()), "Process inventory unavailable")
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        require(len(parts) == 3, "Incomplete process inventory")
        require(not any(marker in parts[2] for marker in EXTRA_SERVERS),
                "A Noiee candidate backend is running")
    require(not os.path.lexists(h["CODING"] / "coding-owners.lock"),
            "Coding owner lease remains; this helper never removes/relabels it")


def catalog_state(h):
    path = h["CODING"] / "coding-owners.json"
    raw = regular_bytes(path, 4 * 1024 * 1024, private=True)
    value = json.loads(raw)
    require(type(value) is dict and type(value.get("version")) is int
            and value["version"] == 13 and type(value.get("owners")) is list,
            "Unexpected ownership catalog schema; review is required")
    legacy = value.get("legacy")
    require(legacy is None or (type(legacy) is dict
            and legacy.get("nativeOpen") is False),
            "Legacy native reader closure is unconfirmed")
    for row in value["owners"]:
        require(type(row) is dict, "Invalid owner record")
        generation = row.get("generation")
        require(generation is None or (type(generation) is dict
                and generation.get("nativeOpen") is False),
                "A retained native owner is not closed")
    return {
        "path": str(path), "sha256": digest(raw), "bytes": len(raw),
        "version": 13, "ownerCount": len(value["owners"]),
        "allSavedNativeReadersClosed": True,
        "leaseAbsent": True,
    }


def observe(h, expected_bundle):
    require_stopped(h)
    boot_before = h["boot_session"]()
    catalog = catalog_state(h)
    installed_requirement = h["requirement"](APP)
    bundle = h["manifest"](APP)
    require(bundle == expected_bundle, 'Installed signed Build180 bundle differs')
    info = plistlib.loads(regular_bytes(APP / "Contents/Info.plist", 1024 * 1024))
    require(info.get("CFBundleIdentifier") == "com.saleh.qwenlocal.chat"
            and info.get("CFBundleVersion") == '180'
            and info.get("CFBundleExecutable") == "QwenLocal",
            "Unexpected predecessor bundle identity/build")
    contents, identities = h["data_snapshot"]()
    require_stopped(h)
    require(boot_before == h["boot_session"](), "Boot changed during observation")
    require(catalog == catalog_state(h), "Ownership catalog changed")
    return {
        "bootSession": boot_before,
        "installedBuild": '180',
        "bundleIdentifier": info["CFBundleIdentifier"],
        "bundlePath": str(APP),
        "designatedRequirement": installed_requirement,
        "bundleManifest": bundle,
        "dataManifests": contents,
        "dataIdentities": identities,
        "ownership": catalog,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(PROJECT == Path("/Users/saleh/Documents/Noiee/project"),
            "Run the reviewed integrated checkout, not a development worktree")
    out = args.output
    require(out.is_absolute() and out.parent == RELEASE
            and out.suffix == ".json" and not os.path.lexists(out),
            "Output must be a new .json directly beneath the release directory")
    require(RELEASE.resolve(strict=True) == RELEASE and not RELEASE.is_symlink(),
            "Release directory must be canonical")
    release_info = RELEASE.lstat()
    require(stat.S_ISDIR(release_info.st_mode)
            and release_info.st_uid == os.getuid()
            and not stat.S_IMODE(release_info.st_mode) & 0o077,
            "Release directory must be owned and private")
    h = helpers()
    package = json.loads(regular_bytes(STAGE180 / "candidate-receipt.json",
                                      1024 * 1024, PACKAGE_SHA))
    expected_bundle = json.loads(regular_bytes(
        STAGE180 / "candidate-bundle-manifest.json", 4 * 1024 * 1024, BUNDLE_SHA))
    require(package.get("build") == 180
            and package.get("candidateBundleManifest") == {
                "path": str(STAGE180 / "candidate-bundle-manifest.json"), "sha256": BUNDLE_SHA}
            and package.get("binarySHA256") == BINARY_SHA
            and expected_bundle["Contents/MacOS/QwenLocal"]["sha256"] == BINARY_SHA
            and all(package.get(k) is True for k in (
                "signatureVerified", "sameDesignatedRequirement",
                "archiveRoundtripVerified")),
            "Pinned predecessor release evidence differs")
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    first = observe(h, expected_bundle)
    second = observe(h, expected_bundle)
    require(first == second, "Stopped boundary or original stores changed")
    require_stopped(h)
    require(first["bootSession"] == h["boot_session"](), "Boot changed")
    result = {
        "version": 1,
        "phase": "observed-current-stopped-preservation-baseline",
        "capturedFrom": started,
        "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "captureSource": {
            "path": str(Path(__file__).resolve()),
            "sha256": digest(Path(__file__).read_bytes()),
        },
        "pinnedGuards": {"path": str(HELPER), "sha256": HELPER_SHA},
        "predecessorPackage": {
            "path": str(STAGE180 / "candidate-receipt.json"),
            "sha256": PACKAGE_SHA,
        },
        "twoCompleteObservationsEqual": True,
        "processAndPortChecksPassed": True,
        "sourceStoresOpenedBySQLite": False,
        "appOrModelInvoked": False,
        "originalDataWritten": False,
        "backupCreated": False,
        "historicalNormalQuitClaimed": False,
        "ownerRecoveryClaimed": False,
        "releaseAdmissionClaimed": False,
        "nativeAcceptancePassed": False,
        **first,
    }
    h["write_new"](out, json.dumps(result, indent=2).encode() + b"\n", 0o600)
    print(json.dumps({
        "checkpoint": str(out), "sha256": h["sha"](out),
        "bootSession": first["bootSession"],
        "installedBuild": first["installedBuild"],
        "originalDataWritten": False, "backupCreated": False,
        "releaseAdmissionClaimed": False,
    }))


if __name__ == "__main__":
    main()
