"""Storage interface shared by the SQLite and DynamoDB adapters."""
import os


class Conflict(Exception):
    """Raised by put_history when base_rev does not match the stored revision."""

    def __init__(self, data, rev, updated_at):
        super().__init__("revision conflict")
        self.data, self.rev, self.updated_at = data, rev, updated_at


class Store:
    def create_user(self, username: str, pw_hash: str, now: float) -> bool: ...  # False if taken
    def get_user(self, username: str): ...  # {"username", "pw_hash", "created_at"} | None
    def create_session(self, th: str, username: str, expires_at: float) -> None: ...
    def get_session(self, th: str, now: float): ...  # username | None
    def delete_session(self, th: str) -> None: ...
    def get_history(self, username: str): ...  # (data: dict, rev: int, updated_at: float|None)
    def put_history(self, username: str, data: dict, base_rev: int, now: float) -> int: ...  # new rev / Conflict
    def close(self) -> None: ...


def make_store():
    kind = os.environ.get("BOARDLE_STORAGE", "sqlite").strip().lower()
    if kind in ("dynamodb", "dynamo", "ddb"):
        from .store_dynamodb import DynamoStore
        return DynamoStore(
            table_name=os.environ.get("BOARDLE_DDB_TABLE", "boardle"),
            region=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
            endpoint_url=os.environ.get("BOARDLE_DDB_ENDPOINT") or None,
        )
    from .store_sqlite import SqliteStore
    default = os.path.join(os.path.expanduser("~"), ".boardle", "boardle.sqlite3")
    return SqliteStore(os.environ.get("BOARDLE_DB_PATH", default))
