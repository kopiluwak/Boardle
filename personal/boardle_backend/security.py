"""Password hashing (scrypt, PBKDF2 fallback) and session tokens."""
import base64
import hashlib
import hmac
import os
import re
import secrets

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
PBKDF2_ITERS = 600_000
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")
MIN_PASSWORD = 8
MAX_PASSWORD = 256


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    pw = password.encode("utf-8")
    if hasattr(hashlib, "scrypt"):
        try:
            dk = hashlib.scrypt(pw, salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=64 * 1024 * 1024)
            return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(dk)}"
        except (ValueError, MemoryError):
            pass
    dk = hashlib.pbkdf2_hmac("sha256", pw, salt, PBKDF2_ITERS, dklen=32)
    return f"pbkdf2_sha256${PBKDF2_ITERS}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        pw = password.encode("utf-8")
        parts = stored.split("$")
        if parts[0] == "scrypt":
            n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
            salt, want = _unb64(parts[4]), _unb64(parts[5])
            got = hashlib.scrypt(pw, salt=salt, n=n, r=r, p=p, dklen=len(want), maxmem=64 * 1024 * 1024)
        elif parts[0] == "pbkdf2_sha256":
            iters, salt, want = int(parts[1]), _unb64(parts[2]), _unb64(parts[3])
            got = hashlib.pbkdf2_hmac("sha256", pw, salt, iters, dklen=len(want))
        else:
            return False
        return hmac.compare_digest(got, want)
    except Exception:
        return False


# Used to keep login timing similar for unknown usernames
DUMMY_HASH = hash_password(secrets.token_hex(8))


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_username(name) -> str:
    return (name or "").strip().lower() if isinstance(name, str) else ""


def validate_credentials(username: str, password) -> str:
    """Return an error message, or '' when OK."""
    if not USERNAME_RE.match(username or ""):
        return "Username must be 3–32 characters: letters, digits, '.', '_' or '-'."
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if len(password) > MAX_PASSWORD:
        return "Password is too long."
    return ""
