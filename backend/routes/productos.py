from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db
from models import Producto, OrdenDetalle


class ProductoOut(BaseModel):
    id: int
    nombre: str
    precio: float
    imagen: Optional[str] = None

    model_config = {"from_attributes": True}


router = APIRouter(prefix="/api", tags=["productos"])


@router.get("/productos", response_model=List[ProductoOut])
def listar_productos(db: Session = Depends(get_db)):
    return db.query(Producto).all()

# --- Nuevos endpoints CRUD ---
class ProductoCreate(BaseModel):
    nombre: str
    precio: float
    imagen: Optional[str] = None


class ProductoUpdate(BaseModel):
    nombre: Optional[str] = None
    precio: Optional[float] = None
    imagen: Optional[str] = None


@router.post("/producto", response_model=ProductoOut)
def crear_producto(payload: ProductoCreate, db: Session = Depends(get_db)):
    p = Producto(nombre=payload.nombre, precio=payload.precio, imagen=payload.imagen)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.patch("/producto/{producto_id}", response_model=ProductoOut)
def actualizar_producto(producto_id: int, payload: ProductoUpdate, db: Session = Depends(get_db)):
    p = db.get(Producto, producto_id)
    if not p:
        raise HTTPException(status_code=404, detail="Producto no encontrado")
    if payload.nombre is not None:
        p.nombre = payload.nombre
    if payload.precio is not None:
        p.precio = payload.precio
    if payload.imagen is not None:
        p.imagen = payload.imagen
    db.commit()
    db.refresh(p)
    return p


@router.delete("/producto/{producto_id}")
def eliminar_producto(producto_id: int, db: Session = Depends(get_db)):
    p = db.get(Producto, producto_id)
    if not p:
        raise HTTPException(status_code=404, detail="Producto no encontrado")
    # Evitar eliminar si está referenciado en órdenes
    refs = db.query(OrdenDetalle).filter(OrdenDetalle.producto_id == producto_id).count()
    if refs > 0:
        raise HTTPException(status_code=400, detail="No se puede eliminar: producto con órdenes asociadas")
    db.delete(p)
    db.commit()
    return {"ok": True}