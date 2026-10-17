#!/usr/bin/env python3
"""Bounded Linux resource sampling; never deletes data or changes services.

Default writes: current.json, state.json and an empty .lock file beneath
/var/lib/sanjie-resource-watch. No environment variables or credentials are read.
Only threshold changes, recoveries and 30-minute warning reminders reach syslog.
Run without --summary in a scheduled job to avoid a line of output every run.
"""
from __future__ import print_function

import argparse
import datetime
import fcntl
import json
import math
import os
import stat
import subprocess
import sys
import tempfile
import time


GIB = 1024 ** 3
REMINDER_SECONDS = 30 * 60
MAX_JSON_BYTES = 16 * 1024
DEFAULT_OUTPUT_DIR = "/var/lib/sanjie-resource-watch"


class WatchError(Exception):
    pass


def read_small_text(filename, maximum):
    with open(filename, "r", encoding="ascii") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise WatchError("resource input exceeds its size limit")
    return value


def sample_disk():
    usage = os.statvfs("/")
    unit = usage.f_frsize or usage.f_bsize
    total = usage.f_blocks * unit
    used = (usage.f_blocks - usage.f_bfree) * unit
    available = usage.f_bavail * unit
    # Match df: reserved blocks are excluded from the usable denominator.
    usable = used + available
    used_inodes = usage.f_files - usage.f_ffree
    available_inodes = usage.f_favail
    usable_inodes = used_inodes + available_inodes
    if (total <= 0 or usable <= 0 or usable_inodes <= 0 or
            min(used, available, used_inodes, available_inodes) < 0):
        raise WatchError("root filesystem counters are invalid")
    return {
        "mount": "/", "total_bytes": total, "used_bytes": used,
        "available_bytes": available,
        "use_percent": round(100.0 * used / usable, 2),
        "total_inodes": usage.f_files, "used_inodes": used_inodes,
        "available_inodes": available_inodes,
        "inode_use_percent": round(100.0 * used_inodes / usable_inodes, 2),
    }


def sample_memory():
    counters = {}
    for line in read_small_text("/proc/meminfo", 64 * 1024).splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[2] == "kB":
            try:
                counters[parts[0].rstrip(":")] = int(parts[1]) * 1024
            except ValueError:
                raise WatchError("memory counters are invalid")
    required = ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")
    if any(name not in counters for name in required):
        raise WatchError("required Linux memory counters are unavailable")
    total, available = counters["MemTotal"], counters["MemAvailable"]
    swap_total, swap_free = counters["SwapTotal"], counters["SwapFree"]
    if (total <= 0 or not 0 <= available <= total or
            not 0 <= swap_free <= swap_total):
        raise WatchError("memory counters are outside their valid range")
    return {
        "total_bytes": total, "available_bytes": available,
        "available_percent": round(100.0 * available / total, 2),
        "swap_total_bytes": swap_total, "swap_free_bytes": swap_free,
        "swap_used_bytes": swap_total - swap_free,
        "swap_use_percent": (round(100.0 * (swap_total - swap_free) / swap_total, 2)
                             if swap_total else 0.0),
    }


def sample_memory_psi():
    try:
        source = read_small_text("/proc/pressure/memory", 4096)
    except FileNotFoundError:
        # Older Linux kernels do not provide PSI; this is explicit in the sample.
        return {"supported": False}
    result = {"supported": True}
    for line in source.splitlines():
        parts = line.split()
        if not parts or parts[0] not in ("some", "full"):
            continue
        row = {}
        for part in parts[1:]:
            if "=" not in part:
                continue
            name, raw = part.split("=", 1)
            if name not in ("avg10", "avg60", "avg300", "total"):
                continue
            try:
                value = int(raw) if name == "total" else float(raw)
            except ValueError:
                raise WatchError("memory PSI counters are invalid")
            if not math.isfinite(value) or value < 0:
                raise WatchError("memory PSI counters are outside their valid range")
            row[name] = value
        if set(row) != {"avg10", "avg60", "avg300", "total"}:
            raise WatchError("memory PSI counters are incomplete")
        result[parts[0]] = row
    if "some" not in result:
        raise WatchError("memory PSI counters are unavailable")
    return result


def thresholds(disk, memory):
    reasons = []
    severity = "healthy"

    def add(code, level):
        reasons.append(code)
        ranks = {"healthy": 0, "warning": 1, "critical": 2, "emergency": 3}
        return level if ranks[level] > ranks[severity] else severity

    # Compare original counters so presentation rounding cannot cross a boundary.
    use = 100.0 * disk["used_bytes"] / (disk["used_bytes"] + disk["available_bytes"])
    for boundary, level in ((95, "emergency"), (90, "critical"), (80, "warning")):
        if use >= boundary:
            severity = add("disk_use_ge_%d" % boundary, level)
            break
    free = disk["available_bytes"]
    if free < 5 * GIB:
        severity = add("disk_free_lt_5gib", "critical")
    elif free < 10 * GIB:
        severity = add("disk_free_lt_10gib", "warning")
    inode = 100.0 * disk["used_inodes"] / (disk["used_inodes"] + disk["available_inodes"])
    if inode >= 90:
        severity = add("inode_use_ge_90", "critical")
    elif inode >= 80:
        severity = add("inode_use_ge_80", "warning")
    available = 100.0 * memory["available_bytes"] / memory["total_bytes"]
    if available < 8:
        severity = add("memory_available_lt_8pct", "critical")
    elif available < 15:
        severity = add("memory_available_lt_15pct", "warning")
    return severity, reasons


def checked_regular_file(filename):
    try:
        metadata = os.lstat(filename)
    except FileNotFoundError:
        return
    if (not stat.S_ISREG(metadata.st_mode) or
            metadata.st_uid != os.geteuid()):
        raise WatchError("output file is not an owned regular file")


def prepare_directory(directory):
    if not os.path.isabs(directory):
        raise WatchError("output directory must be absolute")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    metadata = os.lstat(directory)
    if (not stat.S_ISDIR(metadata.st_mode) or
            metadata.st_uid != os.geteuid()):
        raise WatchError("output directory is not an owned regular directory")
    os.chmod(directory, 0o700)


def load_state(directory):
    filename = os.path.join(directory, "state.json")
    checked_regular_file(filename)
    try:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"schema": 1, "reasons": [], "last_notification_unix": 0}
    with os.fdopen(descriptor, "r", encoding="ascii") as handle:
        source = handle.read(MAX_JSON_BYTES + 1)
    if len(source) > MAX_JSON_BYTES:
        raise WatchError("persistent state exceeds its size limit")
    try:
        value = json.loads(source)
    except ValueError:
        raise WatchError("persistent state contains invalid JSON")
    valid_codes = {
        "disk_use_ge_80", "disk_use_ge_90", "disk_use_ge_95",
        "disk_free_lt_10gib", "disk_free_lt_5gib",
        "inode_use_ge_80", "inode_use_ge_90",
        "memory_available_lt_15pct", "memory_available_lt_8pct",
    }
    if (not isinstance(value, dict) or value.get("schema") != 1 or
            set(value) != {"schema", "reasons", "last_notification_unix"} or
            not isinstance(value.get("reasons"), list) or
            len(value["reasons"]) > 4 or
            any(not isinstance(code, str) or code not in valid_codes
                for code in value["reasons"]) or
            not isinstance(value.get("last_notification_unix"), (int, float)) or
            not math.isfinite(value["last_notification_unix"]) or
            value["last_notification_unix"] < 0):
        raise WatchError("persistent state does not match its schema")
    return value


def atomic_json(directory, name, value):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("ascii")
    if len(data) > MAX_JSON_BYTES:
        raise WatchError("output JSON exceeds its size limit")
    destination = os.path.join(directory, name)
    checked_regular_file(destination)
    descriptor, temporary = tempfile.mkstemp(prefix="." + name + "-", dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        # Only an uncommitted temporary file created by this invocation is removed.
        # User files, logs, caches and service data are never cleanup targets.
        if os.path.exists(temporary):
            os.unlink(temporary)


def notification_kind(previous, reasons, now):
    if reasons != previous["reasons"]:
        return "alert" if reasons else "recovery"
    last = previous["last_notification_unix"]
    if reasons and (now - last >= REMINDER_SECONDS or now < last):
        return "reminder"
    return "none"


def log_notification(kind, severity, reasons, disk, memory):
    logger = next((name for name in ("/usr/bin/logger", "/bin/logger")
                   if os.path.isfile(name) and os.access(name, os.X_OK)), None)
    if not logger:
        raise WatchError("system logger is unavailable")
    message = ("%s severity=%s reasons=%s root_use=%.2f%% root_free_gib=%.2f "
               "inode_use=%.2f%% mem_available=%.2f%%") % (
                   kind, severity, ",".join(reasons) or "none",
                   disk["use_percent"], disk["available_bytes"] / float(GIB),
                   disk["inode_use_percent"], memory["available_percent"])
    priority = "daemon.notice" if kind == "recovery" else "daemon.warning"
    try:
        outcome = subprocess.run([logger, "-p", priority, "-t", "sanjie-resource-watch",
                                  "--", message], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        raise WatchError("system logger execution failed")
    if outcome.returncode:
        raise WatchError("system logger returned a failure")


def run(directory, summary=False):
    prepare_directory(directory)
    lock_file = os.path.join(directory, ".lock")
    checked_regular_file(lock_file)
    lock = os.open(lock_file, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(lock, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise WatchError("another sampler is already running")
        previous = load_state(directory)
        now = time.time()
        disk, memory = sample_disk(), sample_memory()
        psi = sample_memory_psi()
        severity, reasons = thresholds(disk, memory)
        kind = notification_kind(previous, reasons, now)
        current = {
            "schema": 1,
            "sampled_at_utc": datetime.datetime.utcfromtimestamp(now).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
            "severity": severity, "reasons": reasons, "notification": kind,
            "disk": disk, "memory": memory, "memory_psi": psi,
        }
        atomic_json(directory, "current.json", current)
        if kind != "none":
            log_notification(kind, severity, reasons, disk, memory)
        atomic_json(directory, "state.json", {
            "schema": 1, "reasons": reasons,
            "last_notification_unix": (now if kind != "none"
                                       else previous["last_notification_unix"]),
        })
        if summary:
            print("severity=%s root_use=%.2f%% root_free_gib=%.2f "
                  "inode_use=%.2f%% mem_available=%.2f%% notification=%s" % (
                      severity, disk["use_percent"],
                      disk["available_bytes"] / float(GIB),
                      disk["inode_use_percent"], memory["available_percent"], kind))
        return current
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                        help="absolute directory for fixed JSON files (default: %(default)s)")
    parser.add_argument("--summary", action="store_true",
                        help="print one short summary; omit in scheduled jobs")
    arguments = parser.parse_args()
    try:
        run(arguments.output_dir, arguments.summary)
    except WatchError as error:
        print("resource-watch: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, OverflowError):
        # Do not print raw operating-system errors, paths or input content.
        print("resource-watch: resource sampling or private-state I/O failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
