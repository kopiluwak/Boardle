"""DynamoDB storage for AWS (BOARDLE_STORAGE=dynamodb). Requires boto3.

Single table, string partition key `pk` + string sort key `sk`:

  pk = "USER#<username>"     sk = "PROFILE"   pw_hash, created_at
  pk = "USER#<username>"     sk = "HISTORY"   data_z (Binary, zlib JSON), rev (N), updated_at (N)
  pk = "SESSION#<sha256>"    sk = "SESSION"   username, expires_at (N), ttl (N, DynamoDB TTL attribute)
  pk = "RATE#<sha256>"       sk = "W#<window>" hits (N), ttl (N)   -- failed-login counter (DynamoRateLimiter)

History is zlib-compressed to stay well under the 400 KB item limit.
Writes to HISTORY use a conditional expression on `rev` (optimistic locking).
"""
import hashlib
import json
import time
import zlib
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from .store_base import Conflict, Store


def _num(v):
    return float(v) if isinstance(v, Decimal) else v


class DynamoStore(Store):
    def __init__(self, table_name="boardle", region=None, endpoint_url=None, resource=None):
        res = resource or boto3.resource("dynamodb", region_name=region, endpoint_url=endpoint_url)
        self.table = res.Table(table_name)

    def create_user(self, username, pw_hash, now):
        try:
            self.table.put_item(
                Item={"pk": f"USER#{username}", "sk": "PROFILE", "pw_hash": pw_hash, "created_at": Decimal(str(round(now, 3)))},
                ConditionExpression=Attr("pk").not_exists(),
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise

    def get_user(self, username):
        it = self.table.get_item(Key={"pk": f"USER#{username}", "sk": "PROFILE"}, ConsistentRead=True).get("Item")
        if not it:
            return None
        return {"username": username, "pw_hash": it["pw_hash"], "created_at": _num(it.get("created_at"))}

    def create_session(self, th, username, expires_at):
        self.table.put_item(Item={
            "pk": f"SESSION#{th}", "sk": "SESSION", "username": username,
            "expires_at": Decimal(str(round(expires_at, 3))), "ttl": int(expires_at),
        })

    def get_session(self, th, now):
        it = self.table.get_item(Key={"pk": f"SESSION#{th}", "sk": "SESSION"}).get("Item")
        if not it:
            return None
        if _num(it["expires_at"]) < now:  # TTL deletion is lazy, so check expiry ourselves
            self.delete_session(th)
            return None
        return it["username"]

    def delete_session(self, th):
        self.table.delete_item(Key={"pk": f"SESSION#{th}", "sk": "SESSION"})

    def get_history(self, username):
        it = self.table.get_item(Key={"pk": f"USER#{username}", "sk": "HISTORY"}, ConsistentRead=True).get("Item")
        if not it:
            return {}, 0, None
        raw = it["data_z"]
        raw = raw.value if hasattr(raw, "value") else raw
        return json.loads(zlib.decompress(bytes(raw)).decode("utf-8")), int(it["rev"]), _num(it.get("updated_at"))

    def put_history(self, username, data, base_rev, now):
        blob = zlib.compress(json.dumps(data, separators=(",", ":")).encode("utf-8"), 9)
        new_rev = int(base_rev) + 1
        cond = Attr("pk").not_exists() if int(base_rev) == 0 else Attr("rev").eq(int(base_rev))
        try:
            self.table.put_item(
                Item={"pk": f"USER#{username}", "sk": "HISTORY", "data_z": blob, "rev": new_rev,
                      "updated_at": Decimal(str(round(now, 3)))},
                ConditionExpression=cond,
            )
            return new_rev
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            data_now, rev_now, upd = self.get_history(username)
            raise Conflict(data_now, rev_now, upd)

    def close(self):
        pass


class DynamoRateLimiter:
    """Failed-login limiter shared by every Lambda container (fixed window per key).

    Same interface as api.RateLimiter. Keys are hashed so no IP/username is stored in
    clear. Items expire through the table's TTL. Any DynamoDB error fails *open*
    (never locks people out because of a throttled table) and is logged.
    """

    def __init__(self, table, limit=10, window=900):
        self.table, self.limit, self.window = table, limit, window

    def _key(self, key, now):
        w = int(now // self.window)
        return {"pk": "RATE#" + hashlib.sha256(key.encode("utf-8")).hexdigest(), "sk": f"W#{w}"}, w

    def blocked(self, key):
        k, _ = self._key(key, time.time())
        try:
            it = self.table.get_item(Key=k, ConsistentRead=True).get("Item")
        except ClientError as e:  # pragma: no cover
            print(f"rate-limit read failed: {e!r}")
            return False
        return bool(it) and int(it.get("hits", 0)) >= self.limit

    def fail(self, key):
        k, w = self._key(key, time.time())
        try:
            self.table.update_item(Key=k, UpdateExpression="ADD hits :one SET #t = :ttl",
                                   ExpressionAttributeNames={"#t": "ttl"},
                                   ExpressionAttributeValues={":one": 1, ":ttl": (w + 2) * self.window})
        except ClientError as e:  # pragma: no cover
            print(f"rate-limit write failed: {e!r}")

    def clear(self, key):
        k, _ = self._key(key, time.time())
        try:
            self.table.delete_item(Key=k)
        except ClientError as e:  # pragma: no cover
            print(f"rate-limit clear failed: {e!r}")


def create_table(table_name="boardle", region=None, endpoint_url=None, resource=None):
    """Helper for tests / first deploy: on-demand table with pk+sk and TTL on `ttl`."""
    res = resource or boto3.resource("dynamodb", region_name=region, endpoint_url=endpoint_url)
    t = res.create_table(
        TableName=table_name,
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    t.wait_until_exists()
    try:
        res.meta.client.update_time_to_live(TableName=table_name, TimeToLiveSpecification={"Enabled": True, "AttributeName": "ttl"})
    except ClientError:
        pass
    return t
