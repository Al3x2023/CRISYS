import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import relationship

from database import Base


class Mesa(Base):
    __tablename__ = "mesas"

    id = Column(Integer, primary_key=True, index=True)
    numero = Column(Integer, unique=True, nullable=False)
    qr_url = Column(String, nullable=True)

    ordenes = relationship("Orden", back_populates="mesa")


class Producto(Base):
    __tablename__ = "productos"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String, nullable=False)
    precio = Column(Float, nullable=False)
    imagen = Column(String, nullable=True)

    detalles = relationship("OrdenDetalle", back_populates="producto")


class Orden(Base):
    __tablename__ = "ordenes"

    id = Column(Integer, primary_key=True, index=True)
    mesa_id = Column(Integer, ForeignKey("mesas.id"), nullable=False)
    fecha = Column(DateTime, default=datetime.datetime.now(datetime.timezone.utc))
    estado = Column(String, default="pendiente")

    mesa = relationship("Mesa", back_populates="ordenes")
    detalles = relationship(
        "OrdenDetalle", back_populates="orden", cascade="all, delete-orphan"
    )
    pago = relationship("Pago", uselist=False, back_populates="orden")


class OrdenDetalle(Base):
    __tablename__ = "orden_detalle"

    id = Column(Integer, primary_key=True, index=True)
    orden_id = Column(Integer, ForeignKey("ordenes.id"), nullable=False)
    producto_id = Column(Integer, ForeignKey("productos.id"), nullable=False)
    cantidad = Column(Integer, nullable=False)
    entregado = Column(Boolean, default=False)
    entregados = Column(Integer, default=0)

    orden = relationship("Orden", back_populates="detalles")
    producto = relationship("Producto", back_populates="detalles")

class Pago(Base):
    __tablename__ = "pagos"

    id = Column(Integer, primary_key=True, index=True)
    orden_id = Column(Integer, ForeignKey("ordenes.id"), unique=True, nullable=False)
    metodo = Column(String, nullable=False)  # 'efectivo' | 'tarjeta'
    monto_total = Column(Float, nullable=False)
    propina = Column(Float, default=0.0)
    fecha = Column(DateTime, default=datetime.datetime.now(datetime.timezone.utc))

    orden = relationship("Orden", back_populates="pago")