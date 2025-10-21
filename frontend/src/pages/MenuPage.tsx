import { useEffect, useMemo, useRef, useState } from 'react'
import ProductCard from '../components/ProductCard'
import type { CartItem, Producto } from '../context/CartContext'
import { useCart } from '../context/CartContext'

const API_PREFIX = (import.meta.env.VITE_API_BASE as string) || '/api'

function useMesaNumero(): number | null {
  const params = new URLSearchParams(window.location.search)
  const mesa = params.get('mesa')
  return mesa ? Number(mesa) : null
}

export default function MenuPage() {
  const [productos, setProductos] = useState<Producto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mesaNumero = useMesaNumero()
  const { items, decrement, clear, total } = useCart()
  const autoSubmitDelayMs = 5000
  const autoTimerRef = useRef<number | null>(null)

  useEffect(() => {
    fetch(`${API_PREFIX}/productos`)
      .then(r => r.json())
      .then(setProductos)
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [])

  const canSubmit = useMemo(() => items.length > 0 && !!mesaNumero, [items, mesaNumero])

  const enviarPedido = async () => {
    if (!mesaNumero) {
      alert('No se encontró el número de mesa en la URL (ej. /orden?mesa=5)')
      return
    }
    const payload = {
      mesa_numero: mesaNumero,
      items: items.map((i: CartItem) => ({ producto_id: i.producto_id, cantidad: i.cantidad }))
    }
    try {
      const resp = await fetch(`${API_PREFIX}/orden`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json()
      clear()
      alert('Orden enviada correctamente!')
      console.log('Orden creada', data)
    } catch (e: any) {
      alert('Error al enviar orden: ' + e.message)
    }
  }

  // Auto envío tras unos segundos sin cambios en el carrito
  useEffect(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (!canSubmit) return
    autoTimerRef.current = window.setTimeout(() => {
      enviarPedido()
    }, autoSubmitDelayMs)
    return () => {
      if (autoTimerRef.current) {
        clearTimeout(autoTimerRef.current)
        autoTimerRef.current = null
      }
    }
  }, [items, canSubmit])

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Menú</h1>
        <div className="text-sm text-gray-600">Mesa: {mesaNumero ?? '—'}</div>
      </header>

      {loading && <div>Cargando menú...</div>}
      {error && <div className="text-red-600">Error: {error}</div>}

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {productos.map(p => <ProductCard key={p.id} product={p} />)}
      </section>

      <section className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold mb-2">Tu pedido</h2>
        {items.length === 0 ? (
          <div className="text-gray-600">Agrega productos tocando sobre el menú.</div>
        ) : (
          <>
            <ul className="space-y-2">
              {items.map(i => (
                <li key={i.producto_id} className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{i.nombre}</span>
                    <span className="text-gray-600 ml-2">x{i.cantidad}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="px-2 py-1 text-sm bg-gray-200 rounded" onClick={() => decrement(i.producto_id)}>-</button>
                    <span>${(i.precio * i.cantidad).toFixed(2)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-xs text-gray-500">El pedido se enviará automáticamente en {autoSubmitDelayMs / 1000}s si no hay cambios.</div>
          </>
        )}
        <div className="flex items-center justify-between mt-4">
          <div className="font-semibold">Total: ${total.toFixed(2)}</div>
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
            disabled={!canSubmit}
            onClick={enviarPedido}
          >
            Enviar pedido
          </button>
        </div>
      </section>
    </div>
  )
}