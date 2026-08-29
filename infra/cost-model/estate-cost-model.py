#!/usr/bin/env python3
"""
Estate cost model — GCP (as restored) vs the Hetzner baseline.

DESIGN RULE (the whole point of this file): every number is MEASURED at run time
from an authority, never transcribed from a doc, a memory, or a vendor web page.

  * GCP unit prices  <- Cloud Billing Catalog API (cloudbilling.googleapis.com),
                        the same catalog the invoice is priced from.
  * GCP inventory    <- gcloud compute / gcloud storage on the live project.
  * Hetzner prices   <- api.hetzner.cloud /v1/pricing (the ACCOUNT's own currency
                        and location pricing, not a public price list).
  * Hetzner traffic  <- api.hetzner.cloud /v1/servers/{id}/metrics, the provider's
                        own accounting, over an explicitly-named window.

If a rate changes, re-running this file changes the answer. That is the property
a hand-written cost table cannot have, and why this is a script rather than prose.

Usage:
    python3 infra/cost-model/estate-cost-model.py            # full model
    python3 infra/cost-model/estate-cost-model.py --json     # machine-readable

Requires: gcloud authenticated on the estate project; ~/.papercusp/hcloud-token.
Both are read-only paths — this script mutates nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

HOURS_PER_MONTH = 730.0  # GCP's own convention for monthly-equivalent pricing
GIB = 1073741824

HCLOUD_TOKEN_PATH = os.path.expanduser("~/.papercusp/hcloud-token")
GCE_SERVICE = "6F81-5844-456A"  # Compute Engine
GCS_SERVICE = "95FF-2EF5-5EA1"  # Cloud Storage
REGION = "us-central1"


# --------------------------------------------------------------------------
# plumbing
# --------------------------------------------------------------------------

def sh(cmd: list[str], timeout: int = 120) -> str:
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True, timeout=timeout
    ).stdout.strip()


def http_json(url: str, headers: dict[str, str], timeout: int = 60) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def hcloud(path: str) -> dict:
    with open(HCLOUD_TOKEN_PATH) as fh:
        token = fh.read().strip()
    return http_json(
        f"https://api.hetzner.cloud/v1/{path}",
        {"Authorization": f"Bearer {token}"},
    )


# --------------------------------------------------------------------------
# GCP unit prices, straight from the billing catalog
# --------------------------------------------------------------------------

def _tiers(sku: dict) -> list[tuple[float, float]]:
    expr = sku["pricingInfo"][-1]["pricingExpression"]
    out = []
    for rate in expr["tieredRates"]:
        unit = rate["unitPrice"]
        out.append(
            (
                float(rate.get("startUsageAmount", 0)),
                int(unit.get("units", 0)) + int(unit.get("nanos", 0)) / 1e9,
            )
        )
    return out


def fetch_skus(service: str) -> list[dict]:
    token = sh(["gcloud", "auth", "print-access-token"])
    skus, page = [], ""
    while True:
        url = f"https://cloudbilling.googleapis.com/v1/services/{service}/skus?pageSize=5000"
        if page:
            url += f"&pageToken={page}"
        data = http_json(url, {"Authorization": f"Bearer {token}"})
        skus.extend(data.get("skus", []))
        page = data.get("nextPageToken") or ""
        if not page:
            return skus


def find_sku(skus: list[dict], description: str, usage_type: str | None = "OnDemand",
             region: str | None = None) -> dict:
    """Exact-description lookup. Deliberately exact: a substring match is how you
    silently price a Spot or Committed SKU as if it were on-demand."""
    hits = [
        s for s in skus
        if s.get("description") == description
        and (usage_type is None or s.get("category", {}).get("usageType") == usage_type)
        and (region is None or region in s.get("serviceRegions", []))
    ]
    if len(hits) != 1:
        raise SystemExit(
            f"SKU lookup for {description!r} matched {len(hits)} rows, expected exactly 1. "
            "The catalog changed shape — fix the lookup rather than guessing a price."
        )
    return hits[0]


def flat(sku: dict) -> float:
    return _tiers(sku)[0][1]


def tiered_cost(tiers: list[tuple[float, float]], qty: float) -> float:
    """Cost of `qty` units under GCP's tiered rates. Tiers are (start, unit_price);
    a tier's price applies to usage between its start and the next tier's start."""
    total = 0.0
    for i, (start, price) in enumerate(tiers):
        end = tiers[i + 1][0] if i + 1 < len(tiers) else float("inf")
        if qty > start:
            total += (min(qty, end) - start) * price
    return total


# --------------------------------------------------------------------------
# measurement
# --------------------------------------------------------------------------

def _machine_shape(machine_type: str, zone: str) -> tuple[int, int]:
    """(vCPU, memory MB) for a machine type.

    Custom types encode the shape in the name (`n2d-custom-8-16384`); predefined
    types (`e2-standard-4`) do not, so ask the API rather than pattern-matching a
    name — a family whose naming convention differs would otherwise be priced with
    a silently wrong shape instead of failing.
    """
    parts = machine_type.split("-")
    if "custom" in parts:
        try:
            return int(parts[-2]), int(parts[-1])
        except ValueError:
            pass
    described = json.loads(sh([
        "gcloud", "compute", "machine-types", "describe", machine_type,
        f"--zone={zone}", "--format=json(guestCpus,memoryMb)",
    ]))
    return int(described["guestCpus"]), int(described["memoryMb"])


def measure_gcp_inventory() -> dict:
    instances = json.loads(sh([
        "gcloud", "compute", "instances", "list",
        "--format=json(name,machineType,status)",
    ]))
    disks = json.loads(sh([
        "gcloud", "compute", "disks", "list", "--format=json(name,sizeGb,type)",
    ]))
    snapshots = json.loads(sh([
        "gcloud", "compute", "snapshots", "list",
        "--format=json(name,storageBytes,storageLocations)",
    ]))
    addresses = json.loads(sh([
        "gcloud", "compute", "addresses", "list", "--format=json(name,status)",
    ]))

    vms = []
    for inst in instances:
        mt = inst["machineType"].rsplit("/", 1)[-1]
        zone = inst["machineType"].rsplit("/zones/", 1)[-1].split("/", 1)[0]
        vcpu, mem_mb = _machine_shape(mt, zone)
        vms.append({
            "name": inst["name"], "machine_type": mt, "status": inst["status"],
            "vcpu": vcpu, "mem_gib": mem_mb / 1024,
        })
    return {
        "vms": vms,
        "disk_gib": sum(int(d["sizeGb"]) for d in disks),
        "disks": [{"name": d["name"], "gib": int(d["sizeGb"]),
                   "type": d["type"].rsplit("/", 1)[-1]} for d in disks],
        "snapshot_gib": sum(int(s.get("storageBytes", 0)) for s in snapshots) / GIB,
        "snapshot_count": len(snapshots),
        "external_ips": sum(1 for a in addresses if a.get("status") == "IN_USE"),
    }


def measure_bucket(bucket: str) -> dict | None:
    try:
        out = sh(["gcloud", "storage", "du", "-s", f"gs://{bucket}"], timeout=180)
        return {"bucket": bucket, "bytes": int(out.split()[0])}
    except Exception:
        return None


def measure_hetzner(window_days: int = 17, skip_recent_days: int = 11) -> dict:
    """Hetzner's own traffic accounting.

    `skip_recent_days` exists because the migration itself moved the estate OFF
    these hosts; a window ending today measures the migration, not production.
    Default window therefore ends before the rescue and reads real serving load.
    """
    servers = hcloud("servers?per_page=50")["servers"]
    pricing = hcloud("pricing")["pricing"]
    end = datetime.now(timezone.utc) - timedelta(days=skip_recent_days)
    start = end - timedelta(days=window_days)

    rows = []
    for srv in servers:
        stype = srv["server_type"]
        loc = ((srv.get("datacenter") or {}).get("location") or {}).get("name")
        prices = [p for p in stype["prices"] if p.get("location") == loc] or stype["prices"]
        price = prices[0]

        egress_gb = None
        try:
            m = hcloud(
                f"servers/{srv['id']}/metrics?type=network"
                f"&start={start:%Y-%m-%dT%H:%M:%SZ}&end={end:%Y-%m-%dT%H:%M:%SZ}&step=3600"
            )["metrics"]
            vals = [float(v[1]) for v in m["time_series"]["network.0.bandwidth.out"]["values"]
                    if v[1] not in (None, "")]
            if vals:
                seconds = len(vals) * float(m["step"])
                egress_gb = sum(vals) * float(m["step"]) / 1e9 / (seconds / 86400) * 30.4
        except Exception:
            pass

        rows.append({
            "name": srv["name"], "id": srv["id"], "status": srv["status"],
            "type": stype["name"], "vcpu": stype["cores"], "mem_gib": stype["memory"],
            "location": loc, "monthly": float(price["price_monthly"]["net"]),
            "included_traffic_tib": (srv.get("included_traffic") or 0) / 1024**4,
            "egress_gb_per_30d": egress_gb,
        })

    # same server type in the cheapest location, to expose any location premium
    cheapest = {}
    for stype in pricing["server_types"]:
        rates = [float(p["price_monthly"]["net"]) for p in stype["prices"]]
        if rates:
            cheapest[stype["name"]] = min(rates)

    return {
        "currency": pricing.get("currency"),
        "vat_rate": float(pricing.get("vat_rate", 0)),
        "servers": rows,
        "window": f"{start:%Y-%m-%d} .. {end:%Y-%m-%d}",
        "cheapest_monthly_by_type": cheapest,
    }


# --------------------------------------------------------------------------
# the model
# --------------------------------------------------------------------------

def build(args) -> dict:
    gce = fetch_skus(GCE_SERVICE)
    gcs = fetch_skus(GCS_SERVICE)

    rates = {
        "core_hr": flat(find_sku(gce, "N2D AMD Custom Instance Core running in Americas", region=REGION)),
        "ram_gib_hr": flat(find_sku(gce, "N2D AMD Custom Instance Ram running in Americas", region=REGION)),
        "core_hr_1yr": flat(find_sku(gce, "Commitment v1: N2D AMD Cpu in Americas for 1 Year", "Commit1Yr", REGION)),
        "ram_gib_hr_1yr": flat(find_sku(gce, "Commitment v1: N2D AMD Ram in Americas for 1 Year", "Commit1Yr", REGION)),
        "core_hr_3yr": flat(find_sku(gce, "Commitment v1: N2D AMD Cpu in Americas for 3 Year", "Commit3Yr", REGION)),
        "ram_gib_hr_3yr": flat(find_sku(gce, "Commitment v1: N2D AMD Ram in Americas for 3 Year", "Commit3Yr", REGION)),
        "pd_balanced_gib_mo": flat(find_sku(gce, "Balanced PD Capacity", region=REGION)),
        "snapshot_gib_mo": flat(find_sku(gce, "Storage PD Snapshot in US", region="us")),
        "gcs_standard_gib_mo": flat(find_sku(gcs, "Standard Storage US Multi-region", region="us")),
        "gcs_nearline_gib_mo": flat(find_sku(gcs, "Nearline Storage US Multi-region", region="us")),
        "vm_to_gcs_gib": flat(find_sku(gce, "Network Data Transfer to Google Services from Americas to Americas", region=REGION)),
    }
    egress_tiers = _tiers(find_sku(
        gce, "Network Internet Data Transfer Out from Americas to Americas", region=REGION))
    ip_tiers = _tiers(find_sku(gce, "External IP Charge on a Standard VM"))

    inv = measure_gcp_inventory()
    hz = measure_hetzner()
    bucket = measure_bucket(args.bucket) if args.bucket else None

    def compute(vcpu: float, mem_gib: float, term: str = "od") -> float:
        c, r = {
            "od": (rates["core_hr"], rates["ram_gib_hr"]),
            "1yr": (rates["core_hr_1yr"], rates["ram_gib_hr_1yr"]),
            "3yr": (rates["core_hr_3yr"], rates["ram_gib_hr_3yr"]),
        }[term]
        return (vcpu * c + mem_gib * r) * HOURS_PER_MONTH

    as_built_compute = sum(compute(v["vcpu"], v["mem_gib"]) for v in inv["vms"])
    disk = inv["disk_gib"] * rates["pd_balanced_gib_mo"]
    snapshot = inv["snapshot_gib"] * rates["snapshot_gib_mo"]

    # Backup bucket steady state under the live lifecycle (Standard -> Nearline
    # at 14d, deleted at 45d). Daily volume is measured, not assumed.
    gcs_cost = None
    if bucket and args.daily_backup_gib:
        d = args.daily_backup_gib
        gcs_cost = 14 * d * rates["gcs_standard_gib_mo"] + 31 * d * rates["gcs_nearline_gib_mo"]

    hz_egress_gb = sum(s["egress_gb_per_30d"] or 0 for s in hz["servers"]
                       if s["name"] in ("papercup-prod-1", "papercusp-mesh-1"))
    egress_gib = hz_egress_gb * 1e9 / GIB
    egress_cost = tiered_cost(egress_tiers, egress_gib)

    ip_hours = inv["external_ips"] * HOURS_PER_MONTH
    ip_cost = tiered_cost(ip_tiers, ip_hours)

    # Egress headroom: how much traffic before egress alone equals one baseline server.
    baseline_server = max((s["monthly"] for s in hz["servers"]
                           if s["name"] == "papercup-prod-1"), default=0.0)
    lo, hi = 0.0, 1e7
    for _ in range(80):
        mid = (lo + hi) / 2
        if tiered_cost(egress_tiers, mid) < baseline_server:
            lo = mid
        else:
            hi = mid

    return {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rates": rates,
        "egress_tiers": egress_tiers,
        "ip_tiers": ip_tiers,
        "gcp_inventory": inv,
        "hetzner": hz,
        "bucket": bucket,
        "gcp_monthly": {
            "compute_as_built": as_built_compute,
            "disk": disk,
            "snapshot_current_generation": snapshot,
            "gcs_backups": gcs_cost,
            "egress": egress_cost,
            "external_ips": ip_cost,
        },
        "egress": {
            "measured_gb_per_30d": hz_egress_gb,
            "window": hz["window"],
            "break_even_gib_vs_one_baseline_server": lo,
            "headroom_multiple": (lo / egress_gib) if egress_gib else None,
        },
        "scenarios": {
            "as_built_on_demand": as_built_compute,
            "right_sized_on_demand": None,   # filled by caller-supplied shapes
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--bucket", default="papercusp-estate-backups-active-alcove-504205-q3")
    ap.add_argument("--daily-backup-gib", type=float, default=None,
                    help="measured GiB written per day; omit to skip the GCS line")
    args = ap.parse_args()

    model = build(args)
    if args.json:
        print(json.dumps(model, indent=2, default=str))
        return 0

    m = model["gcp_monthly"]
    print(f"# Estate cost model — measured {model['measured_at']}\n")
    print("## GCP unit rates (Cloud Billing Catalog)")
    for k, v in model["rates"].items():
        print(f"  {k:28s} ${v}")
    print(f"\n## GCP monthly (as built)")
    total = 0.0
    for k, v in m.items():
        if v is None:
            print(f"  {k:28s}  (not measured)")
            continue
        total += v
        print(f"  {k:28s} ${v:9.2f}")
    print(f"  {'TOTAL':28s} ${total:9.2f}")

    print(f"\n## Hetzner baseline ({model['hetzner']['currency']}, "
          f"VAT {model['hetzner']['vat_rate']}%)")
    for s in model["hetzner"]["servers"]:
        eg = f"{s['egress_gb_per_30d']:.2f} GB/30d" if s["egress_gb_per_30d"] is not None else "n/a"
        cheap = model["hetzner"]["cheapest_monthly_by_type"].get(s["type"])
        prem = f" ({s['monthly'] / cheap:.1f}x cheapest location)" if cheap else ""
        print(f"  {s['name']:20s} {s['type']:7s} {s['status']:8s} "
              f"${s['monthly']:7.2f}/mo{prem}  egress {eg}")
    print(f"  {'TOTAL BILLING NOW':20s} "
          f"${sum(s['monthly'] for s in model['hetzner']['servers']):7.2f}/mo")

    e = model["egress"]
    print(f"\n## Egress (window {e['window']})")
    print(f"  measured                 {e['measured_gb_per_30d']:.2f} GB/30d")
    print(f"  break-even vs 1 baseline {e['break_even_gib_vs_one_baseline_server']:.0f} GiB/mo "
          f"({e['headroom_multiple']:.0f}x current)" if e["headroom_multiple"] else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
