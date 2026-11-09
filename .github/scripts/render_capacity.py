"""One Linux capacity run using the public, hash-pinned Kaggle pump CSV.

Only the final JSON report and container log are artifacts. Disposable
credentials remain in memory; CSV, SQLite and model files are never artifacts.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pandas as pd

SOURCE_URL = "https://www.kaggle.com/api/v1/datasets/download/nphantawee/pump-sensor-data"
SOURCE_SHA256 = "436681c673264b6eff959a41e7cd7fcb313e5c747523d951361063482ac62331"
SOURCE_BYTES = 124_058_460
SOURCE_ROWS = 220_320
MEMORY_LIMIT = 512 * 1024 * 1024
ORIGIN = "https://capacity.kkobugi.local"
FEATURES = [f"sensor_{number:02d}" for number in range(50) if number != 15]
REQUEST_HEADERS = {"Origin": ORIGIN, "X-Requested-With": "kkobugi-web"}


def docker(*arguments: str, stdin: str | None = None) -> str:
    result = subprocess.run(["docker", *arguments], input=stdin, capture_output=True,
                            text=True, timeout=120)
    if result.returncode:
        # Never echo exec stdout: account provisioning returns temporary secrets.
        raise RuntimeError(f"docker {arguments[0]} failed with exit {result.returncode}")
    return result.stdout


def container_state(name: str) -> dict:
    item = json.loads(docker("inspect", name))[0]
    return {
        "running": item["State"]["Running"], "oom_killed": item["State"]["OOMKilled"],
        "exit_code": item["State"]["ExitCode"], "pid": item["State"]["Pid"],
        "memory_bytes": item["HostConfig"]["Memory"],
        "memory_plus_swap_bytes": item["HostConfig"]["MemorySwap"],
        "nano_cpus": item["HostConfig"]["NanoCpus"],
    }


class MemoryMonitor:
    def __init__(self, pid: int):
        lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        relative = next(line.split("::", 1)[1] for line in lines if line.startswith("0::"))
        root = Path("/sys/fs/cgroup").resolve()
        self.path = (root / relative.lstrip("/")).resolve()
        if not self.path.is_relative_to(root):
            raise RuntimeError("Unexpected container cgroup path")
        if int((self.path / "memory.max").read_text()) != MEMORY_LIMIT:
            raise RuntimeError("cgroup memory.max is not 512 MiB")
        if int((self.path / "memory.swap.max").read_text()) != 0:
            raise RuntimeError("cgroup permits additional swap")
        quota, period = map(int, (self.path / "cpu.max").read_text().split())
        if quota / period != 0.5:
            raise RuntimeError("cgroup CPU quota is not 0.5")
        self.stop = threading.Event()
        self.phase = "initial"
        self.phases: dict[str, dict] = {}
        self.latest: dict = {}
        self.read_errors = 0
        self.sample()
        if not self.latest:
            raise RuntimeError("Cannot read cgroup memory.peak/current/events")
        self.thread = threading.Thread(target=self.sample_loop, daemon=True)
        self.thread.start()

    def sample(self):
        try:
            current = int((self.path / "memory.current").read_text())
            peak = int((self.path / "memory.peak").read_text())
            events = dict((key, int(value)) for key, value in
                          (line.split() for line in (self.path / "memory.events").read_text().splitlines()))
            self.latest = {"current_bytes": current, "cumulative_peak_bytes": peak, "events": events}
            phase = self.phases.setdefault(self.phase, {"samples": 0, "sampled_current_peak_bytes": 0})
            phase["samples"] += 1
            phase["sampled_current_peak_bytes"] = max(phase["sampled_current_peak_bytes"], current)
            phase["cgroup_cumulative_peak_bytes"] = peak
        except OSError:
            self.read_errors += 1

    def sample_loop(self):
        while not self.stop.wait(0.1):
            self.sample()

    def finish(self) -> dict:
        self.stop.set()
        self.thread.join(timeout=2)
        self.sample()
        return {"method": "Linux cgroup v2 memory.peak/current/events, 100 ms host sampling",
                "latest": self.latest, "phases": self.phases, "read_errors": self.read_errors}


def prepare_fixture(directory: Path, report: dict) -> tuple[Path, str, str]:
    archive_path = directory / "public-pump.zip"
    with httpx.stream("GET", SOURCE_URL, follow_redirects=True, timeout=120) as response:
        if response.status_code != 200 or "application/zip" not in response.headers.get("content-type", ""):
            raise RuntimeError(f"Public Kaggle download failed: HTTP {response.status_code}, not a ZIP response")
        with archive_path.open("wb") as destination:
            for chunk in response.iter_bytes():
                destination.write(chunk)
                if destination.tell() > 100 * 1024 * 1024:
                    raise RuntimeError("Public ZIP exceeds the expected download size")
    raw_path = directory / "sensor.csv"
    digest = hashlib.sha256()
    with zipfile.ZipFile(archive_path) as archive:
        members = [name for name in archive.namelist() if Path(name).name == "sensor.csv"]
        if len(members) != 1:
            raise RuntimeError("Public ZIP does not contain exactly one sensor.csv")
        with archive.open(members[0]) as source, raw_path.open("wb") as destination:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                destination.write(chunk)
    if raw_path.stat().st_size != SOURCE_BYTES or digest.hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Public sensor.csv size or SHA-256 mismatch; no replacement data used")
    specification = Path(__file__).resolve().parents[2] / "docs/feature_spec.json"
    if json.loads(specification.read_text(encoding="utf-8"))["features"]["sensors"] != FEATURES:
        raise RuntimeError("Documented 49-channel feature selection changed")
    frame = pd.read_csv(raw_path, usecols=["timestamp", "machine_status", *FEATURES])
    if len(frame) != SOURCE_ROWS:
        raise RuntimeError("Source row count changed")
    frame[FEATURES] = frame[FEATURES].ffill()
    if frame[FEATURES].isna().any().any():
        raise RuntimeError("Forward fill leaves missing cells; no future fill or invented values used")
    frame["label"] = frame["machine_status"].map({"NORMAL": 0, "BROKEN": 1, "RECOVERING": 1})
    if frame["label"].isna().any():
        raise RuntimeError("Unexpected source label")
    train_end = str(frame.iloc[132_191]["timestamp"])
    validation_end = str(frame.iloc[176_255]["timestamp"])
    prepared = directory / "prepared-49channels.csv"
    frame[["timestamp", *FEATURES, "label"]].to_csv(prepared, index=False)
    report["fixture"] = {
        "public_source_url": SOURCE_URL, "source_sha256": digest.hexdigest(),
        "source_bytes": raw_path.stat().st_size, "downloaded_zip_bytes": archive_path.stat().st_size,
        "rows": len(frame), "feature_count": len(FEATURES), "features": FEATURES,
        "prepared_bytes": prepared.stat().st_size,
        "preparation": "All 220320 rows; documented 49 channels; forward fill only; NORMAL=0, BROKEN/RECOVERING=1.",
        "split_rows": [132_192, 44_064, 44_064],
        "normal_train_rows": int(frame.iloc[:132_192]["label"].eq(0).sum()),
    }
    return prepared, train_end, validation_end


def temporary_accounts(container: str) -> list[dict]:
    script = """
import json,secrets
from sqlalchemy import select,func
from app.config import Settings
from app.db import Database
from app.models import User
from app.security import hash_password
database=Database(Settings().database_path)
accounts=[]
try:
    with database.session_factory() as session:
        if session.scalar(select(func.count()).select_from(User)) != 0:
            raise RuntimeError('Capacity fixture requires a fresh empty user table')
        for index in range(5):
            username=f'capacityuser{index}'
            password=secrets.token_urlsafe(18)
            session.add(User(username=username,display_name=f'Capacity {index}',password_hash=hash_password(password)))
            accounts.append({'username':username,'password':password})
        session.commit()
finally:
    database.dispose()
print(json.dumps(accounts))
"""
    accounts = json.loads(docker("exec", "--user", "app", "-i", container, "python", "-", stdin=script))
    if len(accounts) != 5:
        raise RuntimeError("Disposable account provisioning failed")
    return accounts


def expect(response: httpx.Response, status: int, operation: str) -> httpx.Response:
    if response.status_code != status:
        raise RuntimeError(f"{operation}: HTTP {response.status_code}, expected {status}")
    return response


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:10000")
    parser.add_argument("--report-dir", required=True, type=Path)
    args = parser.parse_args()
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"status": "running", "scope": "Linux full-dataset capacity, not model quality",
                    "training": [], "health_checks": [], "local_user_data_transferred": False,
                    "artifact_policy": "JSON summary and container log only; no CSV, DB, model, credential or session files"}
    monitor = None
    failure = None
    started = time.monotonic()

    def phase(name: str):
        report["phase"] = name
        if monitor is not None:
            monitor.phase = name
        print("PHASE " + name, flush=True)

    def health(client: httpx.Client):
        response = client.get("/api/v1/health", timeout=10)
        report["health_checks"].append({"phase": report.get("phase"), "http_status": response.status_code})
        expect(response, 200, "health")

    def login(account: dict) -> tuple[int, str | None]:
        with httpx.Client(base_url=args.base_url, timeout=90) as client:
            response = client.post("/api/v1/auth/login", json=account, headers=REQUEST_HEADERS)
            return response.status_code, response.cookies.get("kkobugi_session")

    def concurrent_requests(client: httpx.Client, operation):
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(operation, index) for index in range(5)]
            while not all(future.done() for future in futures):
                health(client)
                time.sleep(0.5)
            return [future.result() for future in futures]

    try:
        state = container_state(args.container)
        report["initial_container"] = state
        if not state["running"] or state["memory_bytes"] != MEMORY_LIMIT or state["memory_plus_swap_bytes"] != MEMORY_LIMIT or state["nano_cpus"] != 500_000_000:
            raise RuntimeError("Container does not have the required 512 MiB/no-extra-swap/0.5 CPU limits")
        monitor = MemoryMonitor(state["pid"])
        with tempfile.TemporaryDirectory(prefix="kkobugi-public-capacity-") as directory:
            phase("public_download_and_full_fixture")
            prepared, train_end, validation_end = prepare_fixture(Path(directory), report)
            phase("five_disposable_accounts")
            accounts = temporary_accounts(args.container)
            status, token = login(accounts[0])
            report["initial_login_http_status"] = status
            if status != 200 or not token:
                raise RuntimeError(f"Initial disposable login: HTTP {status}")
            headers = {**REQUEST_HEADERS, "Cookie": "kkobugi_session=" + token}
            with httpx.Client(base_url=args.base_url, headers=headers, timeout=90) as client:
                health(client)
                catalog = expect(client.get("/api/v1/models"), 200, "model catalog").json()["items"]
                ae = next(item for item in catalog if item["key"] == "autoencoder")["parameters"]
                if ae["max_iter"] != 100 or ae["early_stopping"] is not False or ae["shuffle"] is not False:
                    raise RuntimeError("AutoEncoder API defaults changed")
                report["autoencoder_default_parameters"] = ae
                phase("upload_220320_rows_49_channels")
                with prepared.open("rb") as source:
                    uploaded = expect(client.post("/api/v1/datasets", files={"file": (prepared.name, source, "text/csv")},
                                                 data={"normal_label": "0", "abnormal_label": "1"}), 201, "full CSV upload").json()
                if not uploaded["inspection"]["is_valid"] or uploaded["inspection"]["row_count"] != SOURCE_ROWS:
                    raise RuntimeError("Full CSV inspection failed or row count changed")
                dataset_id = uploaded["dataset"]["id"]
                report["upload_http_status"] = 201
                for model in ["xgboost", "autoencoder"]:
                    phase("train_" + model)
                    training = {"model": model, "status": "starting"}
                    report["training"].append(training)
                    submitted = expect(client.post("/api/v1/runs", json={"dataset_id": dataset_id,
                        "feature_columns": FEATURES, "models": [model], "train_end": train_end,
                        "validation_end": validation_end, "ranking_metric": "f1"}), 202, model + " submission").json()
                    run_id = submitted["run"]["id"]
                    model_started = time.monotonic()
                    deadline = model_started + 180
                    while time.monotonic() < deadline:
                        detail = expect(client.get(f"/api/v1/runs/{run_id}", timeout=10), 200, model + " status").json()
                        training["status"] = detail["run"]["status"]
                        if training["status"] == "failed":
                            training["error"] = detail["run"].get("error_message")
                            raise RuntimeError(model + " training failed")
                        health(client)
                        if training["status"] == "completed":
                            training["split"] = detail["split"]
                            if [detail["split"][part]["row_count"] for part in ["train", "validation", "test"]] != [132_192, 44_064, 44_064]:
                                raise RuntimeError("Time split differs from 60/20/20")
                            results = expect(client.get(f"/api/v1/runs/{run_id}/results"), 200, model + " results").json()["items"]
                            if len(results) != 1 or results[0]["model_key"] != model:
                                raise RuntimeError("Completed run does not contain the requested model")
                            if model == "autoencoder" and results[0]["parameters"]["max_iter"] != 100:
                                raise RuntimeError("Completed AutoEncoder does not use the default 100 iterations")
                            training["model_results"] = [{key: item.get(key) for key in ["model_key", "parameters", "training_seconds", "warnings"]} for item in results]
                            break
                        time.sleep(0.5)
                    else:
                        training["status"] = "timed_out_after_180_seconds"
                        raise RuntimeError(model + " training exceeded 180 seconds")
                    training["wall_seconds"] = round(time.monotonic() - model_started, 3)

                phase("five_concurrent_logins")
                logins = concurrent_requests(client, lambda index: login(accounts[index]))
                report["concurrent_login_http_statuses"] = [item[0] for item in logins]
                if any(status != 200 or not session for status, session in logins):
                    raise RuntimeError("One or more concurrent logins failed")
                owner_headers = {**REQUEST_HEADERS, "Cookie": "kkobugi_session=" + logins[0][1]}

                def graph(index: int) -> dict:
                    with httpx.Client(base_url=args.base_url, headers=owner_headers, timeout=90) as graph_client:
                        response = graph_client.get(f"/api/v1/datasets/{dataset_id}/series", params=
                            [("channels", channel) for channel in FEATURES[:8]] + [("max_points", "2000")])
                        item = {"http_status": response.status_code}
                        if response.status_code == 200:
                            data = response.json()
                            item.update(matched_count=data["matched_count"], returned_count=data["returned_count"])
                        return item

                phase("five_concurrent_full_range_graphs")
                report["graph_scope"] = "Five requests using one disposable dataset owner, not cross-user sharing; all 220320 rows, first 8 channels, max_points=2000."
                report["concurrent_graphs"] = concurrent_requests(client, graph)
                if any(item["http_status"] != 200 or item.get("matched_count") != SOURCE_ROWS for item in report["concurrent_graphs"]):
                    raise RuntimeError("One or more graph requests failed (including any 503); no successful substitute used")
                phase("final_health")
                health(client)
                report["status"] = "passed"
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
        report.update(status="failed", error=failure)
    finally:
        if monitor is not None:
            report["cgroup_memory"] = monitor.finish()
        try:
            report["final_container"] = container_state(args.container)
            events = report.get("cgroup_memory", {}).get("latest", {}).get("events", {})
            if report["final_container"]["oom_killed"] or not report["final_container"]["running"] or events.get("oom", 0) or events.get("oom_kill", 0):
                failure = failure or "Container stopped or cgroup reported OOM"
                report.update(status="failed", error=failure)
        except Exception as error:
            failure = failure or f"Final container inspection failed: {type(error).__name__}"
            report.update(status="failed", error=failure)
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        (args.report_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": report["status"], "elapsed_seconds": report["elapsed_seconds"],
                          "error": report.get("error"), "report": str(args.report_dir / "report.json")}), flush=True)
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
