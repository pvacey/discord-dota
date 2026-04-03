#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["clickhouse-connect"]
# ///
import argparse
import json
import clickhouse_connect

URL = "clickhouse.ponder.guru"


def get_nested(data, key_path):
    keys = key_path.split(".")
    for key in keys:
        if isinstance(data, list):
            data = [get_nested(item, key) for item in data]
        elif isinstance(data, dict):
            data = data.get(key)
        else:
            return None
    return data


def main():
    parser = argparse.ArgumentParser(
        description="Query ClickHouse and extract nested JSON keys"
    )
    parser.add_argument("query", help="SQL query")
    parser.add_argument(
        "--key", "-k", required=True, help="Key path like payload.previously.player"
    )
    parser.add_argument("--output", "-o", help="Save results to file as NDJSON")
    args = parser.parse_args()

    client = clickhouse_connect.get_client(host=URL, secure=True)
    result = client.query(args.query)

    data = result.result_rows
    columns = result.column_names

    out = []
    for row in data:
        d = dict(zip(columns, row))
        extracted = get_nested(d, args.key)
        if extracted is not None:
            out.append(extracted)

    print("\n---\n".join(json.dumps(item, indent=2, default=str) for item in out))

    if args.output:
        with open(args.output, "w") as f:
            for item in out:
                f.write(json.dumps(item, default=str) + "\n")
        print(f"\nSaved {len(out)} results to {args.output}")


if __name__ == "__main__":
    main()
