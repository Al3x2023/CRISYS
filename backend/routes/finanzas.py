import os
import hmac
import base64
import time
import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Pago

router = APIRouter(prefix="/api/finanzas", tags=["finanzas"]) 

# Configuración simple de credenciales
FIN_USER = os.getenv("FINANZAS_USER", "admin")
FIN_PASS = os.getenv("FINANZAS_PASS", "admin123")
SECRET = os.getenv("FINANZAS_SECRET", "supersecret-finanzas")
TOKEN_NAME = "finanzas_token"
TOKEN_TTL = 60 * 60 * 8  # 8 horas


def sign_token(username: str, ts: int) -> str:
    msg = f"{username}:{ts}".encode()
    sig = hmac.new(SECRET.encode(), msg, digestmod="sha256").digest()
    return base64.urlsafe_b64encode(f"{username}:{ts}:{base64.urlsafe_b64encode(sig).decode()}".encode()).decode()


def verify_token(token: str) -> Optional[str]:
    try:
        raw = base64.urlsafe_b64decode(token).decode()
        parts = raw.split(":")
        if len(parts) != 3:
            return None
        username, ts_str, sig_b64 = parts
        ts = int(ts_str)
        if ts + TOKEN_TTL < int(time.time()):
            return None
        expected = hmac.new(SECRET.encode(), f"{username}:{ts}".encode(), digestmod="sha256").digest()
        if base64.urlsafe_b64encode(expected).decode() != sig_b64:
            return None
        return username
    except Exception:
        return None


class LoginPayload(BaseModel):
    user: str
    password: str


@router.post("/login")
def login(payload: LoginPayload, response: Response):
    if payload.user != FIN_USER or payload.password != FIN_PASS:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    ts = int(time.time())
    token = sign_token(payload.user, ts)
    # Cookie HttpOnly, SameSite Lax
    response.set_cookie(
        key=TOKEN_NAME,
        value=token,
        httponly=True,
        max_age=TOKEN_TTL,
        samesite="lax",
        path="/",
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(TOKEN_NAME, path="/")
    return {"ok": True}


def require_auth(request: Request) -> str:
    token = request.cookies.get(TOKEN_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="No autenticado")
    user = verify_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Token inválido")
    return user


@router.get("/me")
def me(user: str = Depends(require_auth)):
    return {"user": user}


class PagoOut(BaseModel):
    id: int
    orden_id: int
    metodo: str
    monto_total: float
    propina: float
    fecha: datetime.datetime

    model_config = {"from_attributes": True}


@router.get("/pagos", response_model=List[PagoOut])
def listar_pagos(request: Request, db: Session = Depends(get_db), user: str = Depends(require_auth), 
                 desde: Optional[str] = None, hasta: Optional[str] = None):
    q = db.query(Pago)
    if desde:
        try:
            d = datetime.datetime.fromisoformat(desde)
            q = q.filter(Pago.fecha >= d)
        except Exception:
            raise HTTPException(status_code=400, detail="Formato 'desde' inválido (ISO)")
    if hasta:
        try:
            h = datetime.datetime.fromisoformat(hasta)
            q = q.filter(Pago.fecha <= h)
        except Exception:
            raise HTTPException(status_code=400, detail="Formato 'hasta' inválido (ISO)")
    q = q.order_by(Pago.fecha.desc())
    return q.all()


class ResumenOut(BaseModel):
    total: float
    propina: float
    cantidad: int


@router.get("/resumen", response_model=ResumenOut)
def resumen_finanzas(db: Session = Depends(get_db), user: str = Depends(require_auth), 
                     desde: Optional[str] = None, hasta: Optional[str] = None):
    q = db.query(Pago)
    if desde:
        try:
            d = datetime.datetime.fromisoformat(desde)
            q = q.filter(Pago.fecha >= d)
        except Exception:
            raise HTTPException(status_code=400, detail="Formato 'desde' inválido (ISO)")
    if hasta:
        try:
            h = datetime.datetime.fromisoformat(hasta)
            q = q.filter(Pago.fecha <= h)
        except Exception:
            raise HTTPException(status_code=400, detail="Formato 'hasta' inválido (ISO)")
    pagos = q.all()
    total = sum(float(p.monto_total) for p in pagos)
    propina = sum(float(p.propina or 0.0) for p in pagos)
    return ResumenOut(total=total, propina=propina, cantidad=len(pagos))