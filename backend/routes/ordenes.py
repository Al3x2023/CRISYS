from typing import List
import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from database import get_db
from models import Mesa, Producto, Orden, OrdenDetalle, Pago


router = APIRouter(prefix="/api", tags=["ordenes"])


class OrderItem(BaseModel):
    producto_id: int
    cantidad: int = Field(gt=0)


class OrderCreate(BaseModel):
    mesa_numero: int
    items: List[OrderItem]


class OrderItemOut(BaseModel):
    producto_id: int
    nombre: str
    precio: float
    cantidad: int
    entregado: bool
    entregados: int


class OrderOut(BaseModel):
    id: int
    mesa_numero: int
    fecha: datetime.datetime
    estado: str
    items: List[OrderItemOut]
    pagado: bool

    model_config = {"from_attributes": True}

def order_to_out(order: Orden, db: Session) -> OrderOut:
    items_out: List[OrderItemOut] = []
    for det in order.detalles:
        prod = db.get(Producto, det.producto_id)
        entregados = int(getattr(det, 'entregados', 0))
        items_out.append(
            OrderItemOut(
                producto_id=prod.id,
                nombre=prod.nombre,
                precio=prod.precio,
                cantidad=det.cantidad,
                entregado=entregados >= det.cantidad,
                entregados=entregados,
            )
        )
    mesa = db.get(Mesa, order.mesa_id)
    pagado = db.query(Pago).filter(Pago.orden_id == order.id).first() is not None
    return OrderOut(
        id=order.id,
        mesa_numero=mesa.numero,
        fecha=order.fecha,
        estado=order.estado,
        items=items_out,
        pagado=pagado,
    )


@router.post("/orden", response_model=OrderOut)
async def crear_orden(payload: OrderCreate, request: Request, db: Session = Depends(get_db)):
    mesa = db.query(Mesa).filter(Mesa.numero == payload.mesa_numero).first()
    if not mesa:
        # Crear mesa automáticamente si no existe
        mesa = Mesa(numero=payload.mesa_numero)
        db.add(mesa)
        db.commit()
        db.refresh(mesa)
    if not payload.items:
        raise HTTPException(status_code=400, detail="La orden debe tener al menos un item")

    # Buscar una orden abierta (no cobrada) para esta mesa
    existing_orders = (
        db.query(Orden)
        .filter(Orden.mesa_id == mesa.id)
        .order_by(Orden.fecha.desc())
        .all()
    )
    open_order = None
    for o in existing_orders:
        if db.query(Pago).filter(Pago.orden_id == o.id).first() is None:
            open_order = o
            break

    if open_order:
        order = open_order
        # Si la orden estaba entregada y llegan nuevos items, vuelve a pendiente
        if order.estado == "entregado":
            order.estado = "pendiente"
        # Mergear/agregar items
        for item in payload.items:
            prod = db.get(Producto, item.producto_id)
            if not prod:
                raise HTTPException(status_code=400, detail=f"Producto {item.producto_id} no existe")
            det = (
                db.query(OrdenDetalle)
                .filter(OrdenDetalle.orden_id == order.id, OrdenDetalle.producto_id == item.producto_id)
                .first()
            )
            if det:
                det.cantidad += item.cantidad
                # Nuevas cantidades implican que aún no están entregadas
                if hasattr(det, 'entregado'):
                    det.entregado = False
            else:
                db.add(OrdenDetalle(orden_id=order.id, producto_id=item.producto_id, cantidad=item.cantidad, entregado=False))
        db.commit()
        db.refresh(order)
        out = order_to_out(order, db)
        await request.app.state.order_manager.broadcast({"type": "update_order", "order": out.model_dump()})
        return out

    # No existe orden abierta: crear nueva
    order = Orden(mesa_id=mesa.id, estado="pendiente")
    db.add(order)
    db.flush()  # obtiene order.id
    for item in payload.items:
        prod = db.get(Producto, item.producto_id)
        if not prod:
            raise HTTPException(status_code=400, detail=f"Producto {item.producto_id} no existe")
        db.add(OrdenDetalle(orden_id=order.id, producto_id=item.producto_id, cantidad=item.cantidad, entregado=False))
    db.commit()
    db.refresh(order)
    out = order_to_out(order, db)
    await request.app.state.order_manager.broadcast({"type": "new_order", "order": out.model_dump()})
    return out


@router.get("/ordenes", response_model=List[OrderOut])
def listar_ordenes(db: Session = Depends(get_db)):
    orders = db.query(Orden).order_by(Orden.fecha.asc()).all()
    visibles = [o for o in orders if db.query(Pago).filter(Pago.orden_id == o.id).first() is None]
    return [order_to_out(o, db) for o in visibles]


class EstadoUpdate(BaseModel):
    estado: str


VALID_ESTADOS = {"pendiente", "en_proceso", "entregado"}


@router.patch("/orden/{orden_id}/estado", response_model=OrderOut)
async def actualizar_estado(orden_id: int, payload: EstadoUpdate, request: Request, db: Session = Depends(get_db)):
    if payload.estado not in VALID_ESTADOS:
        raise HTTPException(status_code=400, detail="Estado inválido")
    order = db.get(Orden, orden_id)
    if not order:
        raise HTTPException(status_code=404, detail="Orden no encontrada")

    order.estado = payload.estado
    db.commit()
    db.refresh(order)

    out = order_to_out(order, db)
    await request.app.state.order_manager.broadcast(
        {"type": "update_status", "order": {"id": out.id, "estado": out.estado}}
    )
    return out


class CobroPayload(BaseModel):
    metodo: str
    propina: float = 0.0

VALID_METODOS = {"efectivo", "tarjeta"}

class PagoOut(BaseModel):
    id: int
    orden_id: int
    metodo: str
    monto_total: float
    propina: float
    fecha: datetime.datetime

    model_config = {"from_attributes": True}

@router.post("/orden/{orden_id}/cobro", response_model=PagoOut)
async def cobrar_orden(orden_id: int, payload: CobroPayload, request: Request, db: Session = Depends(get_db)):
    if payload.metodo not in VALID_METODOS:
        raise HTTPException(status_code=400, detail="Método inválido")
    order = db.get(Orden, orden_id)
    if not order:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    if order.estado != "entregado":
        raise HTTPException(status_code=400, detail="La orden debe estar 'entregado' para cobrar")
    existing = db.query(Pago).filter(Pago.orden_id == orden_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Orden ya cobrada")

    total = 0.0
    for det in order.detalles:
        prod = db.get(Producto, det.producto_id)
        total += float(prod.precio) * det.cantidad

    p = Pago(
        orden_id=orden_id,
        metodo=payload.metodo,
        monto_total=total,
        propina=float(payload.propina or 0.0),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    # Notificar a paneles que la orden fue pagada (para removerla)
    await request.app.state.order_manager.broadcast({"type": "order_paid", "orden_id": orden_id})
    return p


# --- Nuevo: marcar un ítem como entregado/no entregado ---
class ItemEntregaUpdate(BaseModel):
    entregado: bool

@router.patch("/orden/{orden_id}/item/{producto_id}/entregado", response_model=OrderOut)
async def marcar_item_entregado(orden_id: int, producto_id: int, payload: ItemEntregaUpdate, request: Request, db: Session = Depends(get_db)):
    order = db.get(Orden, orden_id)
    if not order:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    det = (
        db.query(OrdenDetalle)
        .filter(OrdenDetalle.orden_id == orden_id, OrdenDetalle.producto_id == producto_id)
        .first()
    )
    if not det:
        raise HTTPException(status_code=404, detail="Item no encontrado en la orden")

    # Actualizar estado del item
    det.entregado = bool(payload.entregado)

    # Derivar estado de la orden
    all_delivered = all(bool(getattr(d, 'entregado', False)) for d in order.detalles)
    any_delivered = any(bool(getattr(d, 'entregado', False)) for d in order.detalles)
    order.estado = "entregado" if all_delivered else ("en_proceso" if any_delivered else "pendiente")

    db.commit()
    db.refresh(order)

    out = order_to_out(order, db)
    await request.app.state.order_manager.broadcast({"type": "update_order", "order": out.model_dump()})
    return out


# --- Nuevo: actualizar cantidad entregada por ítem ---
class ItemEntregadosUpdate(BaseModel):
    entregados: int = Field(ge=0)

@router.patch("/orden/{orden_id}/item/{producto_id}/entregados", response_model=OrderOut)
async def actualizar_item_entregados(orden_id: int, producto_id: int, payload: ItemEntregadosUpdate, request: Request, db: Session = Depends(get_db)):
    order = db.get(Orden, orden_id)
    if not order:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    det = (
        db.query(OrdenDetalle)
        .filter(OrdenDetalle.orden_id == orden_id, OrdenDetalle.producto_id == producto_id)
        .first()
    )
    if not det:
        raise HTTPException(status_code=404, detail="Item no encontrado en la orden")

    nuevo = max(0, min(int(payload.entregados), det.cantidad))
    det.entregados = nuevo
    det.entregado = det.entregados >= det.cantidad

    all_delivered = all(int(getattr(d, 'entregados', 0)) >= d.cantidad for d in order.detalles)
    any_delivered = any(int(getattr(d, 'entregados', 0)) > 0 for d in order.detalles)
    order.estado = "entregado" if all_delivered else ("en_proceso" if any_delivered else "pendiente")

    db.commit()
    db.refresh(order)

    out = order_to_out(order, db)
    await request.app.state.order_manager.broadcast({"type": "update_order", "order": out.model_dump()})
    return out