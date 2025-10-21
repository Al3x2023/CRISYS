import os
import time
import hmac
import hashlib

from fastapi import HTTPException

ORDER_SECRET = os.getenv("ORDER_SECRET", "dev-secret-change-me")
TOKEN_TTL = int(os.getenv("ORDER_TOKEN_TTL", "900"))  # 15 minutos por default


def _sign(message: str) -> str:
    return hmac.new(ORDER_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


def generate_order_token(mesa_numero: int) -> str:
    # Token: "{mesa}:{exp}.{signature}"
    exp = int(time.time()) + TOKEN_TTL
    msg = f"{mesa_numero}:{exp}"
    signature = _sign(msg)
    return f"{msg}.{signature}"


def verify_order_token(token: str | None, expected_mesa_numero: int) -> None:
    if not token:
        raise HTTPException(status_code=401, detail="Token requerido")
    try:
        msg, signature = token.rsplit('.', 1)
        mesa_str, exp_str = msg.split(':')
        mesa = int(mesa_str)
        exp = int(exp_str)
    except Exception:
        raise HTTPException(status_code=401, detail="Token inválido")

    # Mesa debe coincidir
    if mesa != expected_mesa_numero:
        raise HTTPException(status_code=403, detail="Token no corresponde a la mesa")

    # Verificar firma
    expected_sig = _sign(msg)
    if not hmac.compare_digest(signature, expected_sig):
        raise HTTPException(status_code=401, detail="Firma inválida")

    # Verificar expiración
    now = int(time.time())
    if exp < now:
        raise HTTPException(status_code=401, detail="Token expirado")

    # Si todo OK, no retorna nada