import { useEffect, useMemo, useState, useRef } from 'react'

const API_PREFIX = (import.meta.env.VITE_API_BASE as string) || '/api'
const WS_URL = (import.meta.env.VITE_WS_URL as string) || ((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws/ordenes')

type OrderItemOut = {
  producto_id: number
  nombre: string
  precio: number
  cantidad: number
  entregado: boolean
  entregados: number
}

type OrderOut = {
  id: number
  mesa_numero: number
  fecha: string
  estado: 'pendiente' | 'en_proceso' | 'entregado'
  items: OrderItemOut[]
  pagado?: boolean
}

// Gestión de productos
type ProductoOut = {
  id: number
  nombre: string
  precio: number
  imagen?: string
}

type ProductoDraft = {
  nombre: string
  precio: string
  imagen?: string
}

export default function AdminPage() {
  const [orders, setOrders] = useState<OrderOut[]>([])
  const [error, setError] = useState<string | null>(null)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true)
  const soundRef = useRef<boolean>(true)
  const [recentDelivered, setRecentDelivered] = useState<{ orderId: number, productoId: number } | null>(null)
  const [nowTs, setNowTs] = useState<number>(Date.now())
  const [cocinaFilter, setCocinaFilter] = useState<string>('todos')
  const [wsConnected, setWsConnected] = useState<boolean>(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef<number>(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const pollTimerRef = useRef<number | null>(null)
  const keepAliveTimerRef = useRef<number | null>(null)

  // Toasts para nuevas órdenes
  const [toasts, setToasts] = useState<{ id: number, text: string }[]>([])
  const toastIdRef = useRef<number>(1)
  const pushToast = (text: string) => {
    const id = toastIdRef.current++
    setToasts(prev => [...prev, { id, text }])
    window.setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4500)
  }
  const dismissToast = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const [activeTab, setActiveTab] = useState<'cocina' | 'tickets' | 'productos' | 'qr'>(() => {
    try {
      const saved = localStorage.getItem('admin_active_tab')
      if (saved === 'cocina' || saved === 'tickets' || saved === 'productos' || saved === 'qr') return saved as any
    } catch {}
    return 'cocina'
  })
  const [cocinaSort, setCocinaSort] = useState<'tiempo' | 'faltantes'>('tiempo')
  const [cocinaCompact, setCocinaCompact] = useState<boolean>(false)
  const [cocinaCriticalOnly, setCocinaCriticalOnly] = useState<boolean>(false)

  const [productos, setProductos] = useState<ProductoOut[]>([])
  const [prodError, setProdError] = useState<string | null>(null)
  const [nuevoProd, setNuevoProd] = useState<ProductoDraft>({ nombre: '', precio: '', imagen: '' })

  // Estado para QR
  const [qrBaseUrl, setQrBaseUrl] = useState<string>('')
  const [qrTotalMesas, setQrTotalMesas] = useState<string>('')
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrBusy, setQrBusy] = useState<boolean>(false)
  const [qrPreviewSrc, setQrPreviewSrc] = useState<string>('')
  const [qrPreviewMesa, setQrPreviewMesa] = useState<string>('')

  const [qrStyle, setQrStyle] = useState<string>('square')
  const [qrFill, setQrFill] = useState<string>('#000000')
  const [qrBack, setQrBack] = useState<string>('#FFFFFF')
  const [qrGradient, setQrGradient] = useState<string>('none')
  const [qrLogoUrl, setQrLogoUrl] = useState<string>('')
  const [qrLabel, setQrLabel] = useState<string>('')
  const [qrLabelPos, setQrLabelPos] = useState<string>('bottom')
  const [qrLabelColor, setQrLabelColor] = useState<string>('#000000')
  // nuevos: estilo y fondo de etiqueta
  const [qrLabelStyle, setQrLabelStyle] = useState<string>('plain')
  const [qrLabelBg, setQrLabelBg] = useState<string>('#000000')

  useEffect(() => {
    // cargar órdenes iniciales
    fetch(`${API_PREFIX}/ordenes`).then(r => r.json()).then((list: OrderOut[]) => {
      setOrders(list)
    }).catch(err => setError(String(err)))

    // cargar productos
    fetch(`${API_PREFIX}/productos`).then(r => r.json()).then((list: ProductoOut[]) => {
      setProductos(list)
    }).catch(err => setProdError(String(err)))

    // conexión WS con reconexión y fallback a polling
    const connect = () => {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => {
        setWsConnected(true)
        reconnectAttemptsRef.current = 0
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
        // enviar un primer mensaje para satisfacer el receive_text del servidor
        try { ws.send('hello') } catch {}
        // activar keep-alive para conexiones que requieren tráfico
        if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null }
        keepAliveTimerRef.current = window.setInterval(() => { try { ws.send('ping') } catch {} }, 25000)
      }
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.type === 'new_order') {
            const order: OrderOut = msg.order
            // Aviso visual
            pushToast(`Mesa ${order.mesa_numero} · #${order.id}`)
            setOrders(prev => {
              const idx = prev.findIndex(o => o.id === order.id)
              if (idx >= 0) { const copy = [...prev]; copy[idx] = order; return sortOrders(copy) }
              if (soundRef.current) beep()
              return sortOrders([...prev, order])
            })
          } else if (msg.type === 'update_status') {
            const { id, estado } = msg.order
            setOrders(prev => prev.map(o => o.id === id ? { ...o, estado } : o))
          } else if (msg.type === 'update_order') {
            const order: OrderOut = msg.order
            setOrders(prev => {
              const idx = prev.findIndex(o => o.id === order.id)
              if (idx >= 0) {
                const prevOrder = prev[idx]
                const prevMissing = prevOrder.items.reduce((a, it) => a + Math.max(0, (it.cantidad ?? 0) - (it.entregados ?? 0)), 0)
                const newMissing = order.items.reduce((a, it) => a + Math.max(0, (it.cantidad ?? 0) - (it.entregados ?? 0)), 0)
                const copy = [...prev]; copy[idx] = order
                if (newMissing > prevMissing && soundRef.current) beep() // nuevos ítems o aumentos en cocina
                return sortOrders(copy)
              }
              if (soundRef.current) beep() // por si llega como nueva
              return sortOrders([...prev, order])
            })
          } else if (msg.type === 'order_paid') {
            const id: number = msg.orden_id
            setOrders(prev => prev.filter(o => o.id !== id))
          }
        } catch (e) {
          console.error('WS parse error', e)
        }
      }
      const handleDown = () => {
        setWsConnected(false)
        const delay = Math.min(15000, 1000 * Math.pow(2, reconnectAttemptsRef.current || 0))
        reconnectAttemptsRef.current = (reconnectAttemptsRef.current || 0) + 1
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
        // desactivar keep-alive mientras reconecta
        if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null }
        // activar polling ligero mientras reconecta
        if (!pollTimerRef.current) {
          pollTimerRef.current = window.setInterval(() => {
            fetch(`${API_PREFIX}/ordenes`).then(r => r.json()).then((list: OrderOut[]) => setOrders(list)).catch(() => {})
          }, 5000)
        }
        reconnectTimerRef.current = window.setTimeout(() => connect(), delay)
      }
      ws.onerror = handleDown
      ws.onclose = handleDown
    }

    connect()

    return () => {
      try { wsRef.current?.close() } catch {}
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
      if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null }
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
      if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null }
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  // Helper: asegura que las fechas ISO sin zona se interpreten como UTC
  const toDateUtc = (iso: string) => new Date(/Z|[+-]\d{2}:\d{2}/.test(iso) ? iso : iso + 'Z')
  const sortOrders = (list: OrderOut[]) => list.sort((a, b) => toDateUtc(a.fecha).getTime() - toDateUtc(b.fecha).getTime())

  // POS: drag & drop removido; se usan botones para cambiar estado

  const tickets = useMemo(() => {
    const byMesa = new Map<number, OrderOut>()
    for (const o of orders) {
      if (o.pagado) continue
      const cur = byMesa.get(o.mesa_numero)
      if (!cur || toDateUtc(o.fecha).getTime() > toDateUtc(cur.fecha).getTime()) {
        byMesa.set(o.mesa_numero, o)
      }
    }
    return Array.from(byMesa.values()).sort((a, b) => a.mesa_numero - b.mesa_numero)
  }, [orders])

  const kitchenOrders = useMemo(() => {
    return orders
      .filter(o => !o.pagado && o.items.some(it => (it.entregados ?? 0) < (it.cantidad ?? 0)))
      .sort((a, b) => toDateUtc(a.fecha).getTime() - toDateUtc(b.fecha).getTime())
  }, [orders])
  const cocinaOrdersSorted = useMemo(() => {
    const arr = [...kitchenOrders]
    if (cocinaSort === 'faltantes') {
      const falt = (o: OrderOut) => o.items.reduce((s, it) => s + Math.max(0, (it.cantidad ?? 0) - (it.entregados ?? 0)), 0)
      return arr.sort((a, b) => falt(b) - falt(a))
    }
    return arr // ya está ordenado por tiempo
  }, [kitchenOrders, cocinaSort])

  const updateEstado = async (id: number, estado: OrderOut['estado']) => {
    try {
      const resp = await fetch(`${API_PREFIX}/orden/${id}/estado`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json() as OrderOut
      setOrders(prev => prev.map(o => o.id === data.id ? { ...o, estado: data.estado, items: data.items } : o))
    } catch (e: any) {
      alert('No se pudo actualizar el estado: ' + e.message)
    }
  }

  const sumOrderTotal = (o: OrderOut) => o.items.reduce((acc, it) => acc + it.precio * it.cantidad, 0)

  const faltantesOrden = (order: OrderOut) => order.items.reduce((acc, it) => acc + Math.max(0, it.cantidad - it.entregados), 0)

  const getCategoria = (nombre: string): string => {
    const n = nombre.toLowerCase()
    if (n.includes('taco')) return 'tacos'
    if (n.includes('quesad')) return 'quesadillas'
    if (n.includes('refresc') || n.includes('bebida') || n.includes('agua') || n.includes('soda')) return 'bebidas'
    return 'otros'
  }
  const categoriaCounts = useMemo(() => {
    const counts: Record<string, number> = { tacos: 0, quesadillas: 0, bebidas: 0, otros: 0 }
    for (const o of kitchenOrders) {
      for (const it of o.items) {
        const falt = Math.max(0, it.cantidad - it.entregados)
        if (falt <= 0) continue
        const c = getCategoria(it.nombre)
        counts[c] = (counts[c] || 0) + falt
      }
    }
    return counts
  }, [kitchenOrders])
  const totalFaltantesCocina = useMemo(() => {
    return kitchenOrders.reduce((sum, o) => sum + o.items.reduce((s, it) => s + Math.max(0, it.cantidad - it.entregados), 0), 0)
  }, [kitchenOrders])

  // Critical count (orders with age >= 7min and pending items under current filter)
  const criticalCount = useMemo(() => {
    return kitchenOrders.filter(o => {
      const ageMin = Math.max(0, Math.floor((nowTs - new Date(o.fecha).getTime()) / 60000))
      if (ageMin < 7) return false
      const itemsPend = o.items
        .filter(it => (it.entregados ?? 0) < (it.cantidad ?? 0))
        .filter(it => cocinaFilter === 'todos' || getCategoria(it.nombre) === cocinaFilter)
      return itemsPend.length > 0
    }).length
  }, [kitchenOrders, nowTs, cocinaFilter])

  const cobrarOrden = async (order: OrderOut) => {
    try {
      const metodo = (prompt('Método de pago (efectivo/tarjeta)', 'efectivo') || '').trim()
      if (!metodo) return
      const propinaStr = prompt('Propina (opcional, 0 si ninguna)', '0') || '0'
      const propina = Number(propinaStr)
      const resp = await fetch(`${API_PREFIX}/orden/${order.id}/cobro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metodo, propina })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const pago = await resp.json() as { monto_total: number, propina: number }
      // Remover del panel tras cobro
      setOrders(prev => prev.filter(o => o.id !== order.id))
      alert(`Cobro realizado: $${pago.monto_total.toFixed(2)} + propina $${(pago.propina || 0).toFixed(2)}`)
    } catch (e: any) {
      alert('No se pudo cobrar: ' + e.message)
    }
  }


  const updateItemEntregados = async (orderId: number, productoId: number, entregados: number) => {
    try {
      const prevOrder = orders.find(o => o.id === orderId)
      const prevItem = prevOrder?.items.find(i => i.producto_id === productoId)
      const resp = await fetch(`${API_PREFIX}/orden/${orderId}/item/${productoId}/entregados`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entregados })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const updated = await resp.json() as OrderOut
      const updatedItem = updated.items.find(i => i.producto_id === productoId)
      // Resaltar y beep si el ítem acaba de completarse
      if (prevItem && updatedItem && prevItem.entregados < prevItem.cantidad && updatedItem.entregados >= updatedItem.cantidad) {
        setRecentDelivered({ orderId, productoId })
        if (soundRef.current) beep()
        setTimeout(() => setRecentDelivered(null), 1200)
      }
      // Beep y aviso si la orden completa queda lista
      const todoEntregado = updated.items.every(i => i.entregados >= i.cantidad)
      if (todoEntregado && updated.estado === 'entregado') {
        if (soundRef.current) beep()
        // Notificación simple
        try { console.log('Orden lista para cobrar') } catch {}
      }
      setOrders(prev => prev.map(o => o.id === updated.id ? updated : o))
    } catch (e: any) {
      alert('No se pudo actualizar entregados: ' + e.message)
    }
  }

  // Gestión de productos
  const handleProdChange = (index: number, field: keyof ProductoOut, value: string) => {
    setProductos(prev => prev.map((p, i) => {
      if (i !== index) return p
      if (field === 'precio') {
        const normalized = value.replace(',', '.').trim()
        const num = Number(normalized)
        return { ...p, precio: isNaN(num) ? p.precio : num } as ProductoOut
      }
      return { ...p, [field]: value } as ProductoOut
    }))
  }

  const saveProducto = async (p: ProductoOut) => {
    try {
      const nombre = p.nombre?.trim()
      if (!nombre) {
        setProdError('El nombre es obligatorio')
        return
      }
      if (typeof p.precio !== 'number' || isNaN(p.precio)) {
        setProdError('Precio inválido')
        return
      }
      const resp = await fetch(`${API_PREFIX}/producto/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, precio: p.precio, imagen: (p.imagen ?? '').trim() || undefined })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json() as ProductoOut
      setProductos(prev => prev.map(x => x.id === data.id ? data : x))
    } catch (e: any) {
      setProdError('No se pudo guardar el producto: ' + e.message)
    }
  }

  const deleteProducto = async (id: number) => {
    if (!confirm('¿Eliminar este producto?')) return
    try {
      const resp = await fetch(`${API_PREFIX}/producto/${id}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error(await resp.text())
      setProductos(prev => prev.filter(p => p.id !== id))
    } catch (e: any) {
      setProdError('No se pudo eliminar: ' + e.message)
    }
  }

  const createProducto = async () => {
    const nombre = nuevoProd.nombre.trim()
    const precio = Number(nuevoProd.precio)
    if (!nombre || isNaN(precio)) {
      setProdError('Nombre y precio son obligatorios')
      return
    }
    try {
      const resp = await fetch(`${API_PREFIX}/producto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, precio, imagen: nuevoProd.imagen?.trim() || undefined })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json() as ProductoOut
      setProductos(prev => [...prev, data])
      setNuevoProd({ nombre: '', precio: '', imagen: '' })
    } catch (e: any) {
      setProdError('No se pudo crear: ' + e.message)
    }
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 880
      const g = ctx.createGain(); g.gain.value = 0.02
      o.connect(g); g.connect(ctx.destination); o.start(); setTimeout(() => o.stop(), 150)
    } catch {}
  }

  // Cargar configuración y helpers de QR cuando se activa la pestaña
  useEffect(() => {
    if (activeTab !== 'qr') return
    ;(async () => {
      try {
        setQrError(null)
        const resp = await fetch(`${API_PREFIX}/admin/qr/config`)
        if (!resp.ok) throw new Error(await resp.text())
        const cfg = await resp.json() as { base_url: string, total_mesas: number }
        setQrBaseUrl(cfg.base_url)
        setQrTotalMesas(String(cfg.total_mesas || ''))
      } catch (e: any) {
        setQrError('No se pudo cargar configuración: ' + e.message)
      }
    })()
  }, [activeTab])

  const generarQrZip = async () => {
    setQrError(null)
    const total = Number(qrTotalMesas)
    if (!qrBaseUrl || isNaN(total) || total < 1) { setQrError('Base URL y total de mesas son requeridos'); return }
    setQrBusy(true)
    try {
      const resp = await fetch(`${API_PREFIX}/admin/qr/generar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: qrBaseUrl.trim(),
          total_mesas: total,
          style: qrStyle,
          fill: qrFill,
          back: qrBack,
          gradient: qrGradient,
          logo_url: qrLogoUrl.trim() || undefined,
          label: qrLabel || undefined,
          label_pos: qrLabelPos,
          label_color: qrLabelColor,
          label_style: qrLabelStyle,
          label_bg: qrLabelBg,
        })
      })
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'qr_mesas.zip'
      document.body.appendChild(a)
      a.click()
      URL.revokeObjectURL(url)
      a.remove()
    } catch (e: any) {
      setQrError('No se pudo generar: ' + e.message)
    } finally {
      setQrBusy(false)
    }
  }

  const previewQr = async () => {
    setQrError(null)
    const mesa = Number(qrPreviewMesa)
    if (!qrBaseUrl || isNaN(mesa) || mesa < 1) { setQrError('Base URL y mesa válida son requeridos'); return }
    try {
      const params = new URLSearchParams()
      params.set('base_url', qrBaseUrl.trim())
      params.set('style', qrStyle)
      params.set('fill', qrFill)
      params.set('back', qrBack)
      params.set('gradient', qrGradient)
      if (qrLogoUrl.trim()) params.set('logo_url', qrLogoUrl.trim())
      if (qrLabel) params.set('label', qrLabel)
      params.set('label_pos', qrLabelPos)
      params.set('label_color', qrLabelColor)
      params.set('label_style', qrLabelStyle)
      params.set('label_bg', qrLabelBg)
      const resp = await fetch(`${API_PREFIX}/admin/qr/mesa/${mesa}?` + params.toString())
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      setQrPreviewSrc(url)
    } catch (e: any) {
      setQrError('No se pudo obtener previsualización: ' + e.message)
    }
  }

  return (
    <div className="w-full max-w-full sm:max-w-6xl mx-auto px-2 sm:p-4 space-y-4">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Panel del encargado</h1>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-sm text-gray-600">
          <span>Órdenes en tiempo real</span>
          <button className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300" onClick={() => { setSoundEnabled(v => { soundRef.current = !v; return !v }) }}>
            {soundEnabled ? '🔔 Sonido' : '🔕 Silencio'}
          </button>
        </div>
      </header>
      {error && <div className="text-red-600">{error}</div>}

      {/* Toasts */}
      <div className="fixed top-3 right-3 z-50 space-y-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto flex items-center gap-2 rounded-lg bg-black/85 text-white px-3 py-2 shadow-lg ring-1 ring-black/20">
            <span className="font-semibold">Nuevo pedido</span>
            <span className="opacity-90">{t.text}</span>
            <button className="ml-2 rounded px-2 py-1 hover:bg-white/10" onClick={() => dismissToast(t.id)}>✕</button>
          </div>
        ))}
      </div>

      {/* Tabs: Cocina, Tickets, Productos */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur p-2 rounded flex items-center gap-2 flex-wrap overflow-x-auto no-scrollbar">
        <button className={`px-3 py-1 rounded border flex items-center gap-2 ${activeTab === 'cocina' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setActiveTab('cocina')}>
          <span>Cocina</span>
          <span className={`px-2 py-0.5 text-xs rounded-full ${activeTab === 'cocina' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-800'}`}>{totalFaltantesCocina}</span>
        </button>
        <button className={`px-3 py-1 rounded border flex items-center gap-2 ${activeTab === 'tickets' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setActiveTab('tickets')}>
          <span>Tickets</span>
          <span className={`px-2 py-0.5 text-xs rounded-full ${activeTab === 'tickets' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-800'}`}>{tickets.length}</span>
        </button>
        <button className={`px-3 py-1 rounded border flex items-center gap-2 ${activeTab === 'productos' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setActiveTab('productos')}>
          <span>Productos</span>
          <span className={`px-2 py-0.5 text-xs rounded-full ${activeTab === 'productos' ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-800'}`}>{productos.length}</span>
        </button>
        <button className={`px-3 py-1 rounded border flex items-center gap-2 ${activeTab === 'qr' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setActiveTab('qr')}>
          <span>QR</span>
        </button>
      </div>

      {activeTab === 'cocina' && (
        <section className="space-y-4">
          <div className="sticky top-1 sm:top-2 z-10 bg-white/90 backdrop-blur p-2 md:p-3 rounded flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <h2 className="font-semibold">
              {cocinaFilter === 'todos' ? 'Cocina' : `Cocina · ${cocinaFilter.charAt(0).toUpperCase()}${cocinaFilter.slice(1)}`}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2 py-0.5 text-xs rounded ${wsConnected ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{wsConnected ? 'Tiempo real' : 'Reconectando...'}</span>
              {/* Sort toggles */}
              <div className="flex items-center gap-1">
                <button className={`px-2 py-0.5 text-xs rounded border ${cocinaSort === 'tiempo' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setCocinaSort('tiempo')}>Tiempo</button>
                <button className={`px-2 py-0.5 text-xs rounded border ${cocinaSort === 'faltantes' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setCocinaSort('faltantes')}>Faltantes</button>
              </div>
              {/* Compact toggle */}
              <button className={`px-2 py-0.5 text-xs rounded border ${cocinaCompact ? 'bg-blue-100 text-blue-800 border-blue-300' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setCocinaCompact(v => !v)}>
                {cocinaCompact ? 'Compacto' : 'Normal'}
              </button>
              {/* Critical filter */}
              <button className={`px-2 py-0.5 text-xs rounded border ${cocinaCriticalOnly ? 'bg-red-600 text-white border-red-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`} onClick={() => setCocinaCriticalOnly(v => !v)}>
                <span>Críticos</span>
                <span className={`ml-1 px-2 py-0.5 text-xs rounded-full ${cocinaCriticalOnly ? 'bg-white/20 text-white' : 'bg-red-100 text-red-800'}`}>{criticalCount}</span>
              </button>
              <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-800">Faltan {totalFaltantesCocina}</span>
            </div>
          </div>
          <div className="sticky top-10 sm:top-14 z-10 bg-white/90 backdrop-blur p-2 md:p-3 rounded flex flex-wrap md:flex-nowrap gap-2 text-xs overflow-x-auto md:overflow-visible no-scrollbar scroll-smooth">
            {['todos','tacos','quesadillas','bebidas','otros'].map(cat => (
              <button key={cat}
                className={`px-2 py-0.5 rounded border ${cocinaFilter === cat ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-700 border-gray-300'}`}
                onClick={() => setCocinaFilter(cat)}>
                {cat === 'todos' ? 'Todos' : cat.charAt(0).toUpperCase() + cat.slice(1)} ({cat === 'todos' ? totalFaltantesCocina : (categoriaCounts[cat] || 0)})
              </button>
            ))}
            <button
              key="clear"
              className="ml-1 px-2 py-0.5 rounded border bg-gray-50 text-gray-700 hover:bg-gray-100"
              onClick={() => setCocinaFilter('todos')}
              aria-label="Limpiar filtros de Cocina">
              Limpiar filtros
            </button>
          </div>
          {cocinaOrdersSorted.map(order => {
            const ageMin = Math.max(0, Math.floor((nowTs - toDateUtc(order.fecha).getTime()) / 60000))
            const ageLabel = ageMin < 1 ? 'hace <1 min' : `hace ${ageMin} min`
            const ageCls = ageMin < 3 ? 'bg-green-100 text-green-800' : ageMin < 7 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
            const itemsPend = order.items.filter(it => it.entregados < it.cantidad).filter(it => cocinaFilter === 'todos' || getCategoria(it.nombre) === cocinaFilter)
            if (itemsPend.length === 0) return null
            // Filter only critical if enabled: age >= 7 and still pending
            if (cocinaCriticalOnly && (ageMin < 7 || faltantesOrden(order) === 0)) return null
            return (
              <div key={`k-${order.id}`} className="bg-white rounded-lg shadow p-4">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-2">
                  <span className="font-medium">Mesa {order.mesa_numero}</span>
                  <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-200">#{order.id}</span>
                </div>
                <div className="text-xs text-gray-600 flex items-center flex-wrap gap-2 justify-between">
                  <span className={`px-2 py-0.5 text-xs rounded ${ageCls}`}>{ageLabel}</span>
                  <span className={`px-2 py-0.5 text-xs rounded ${faltantesOrden(order) > 0 ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>{faltantesOrden(order) > 0 ? `Faltan ${faltantesOrden(order)}` : 'Listo'}</span>
                  {faltantesOrden(order) === 0 && (
                    <button className="ml-2 px-2 py-0.5 text-xs rounded bg-green-600 text-white" onClick={() => { if (confirm(`Marcar orden #${order.id} como lista/entregada?`)) updateEstado(order.id, 'entregado') }}>
                      Listo
                    </button>
                  )}
                </div>
                <ul className="mt-2 text-sm text-gray-700 ml-0">
                  {itemsPend.map(it => (
                    <li key={`k-${order.id}-${it.producto_id}`} className={`flex items-center gap-2 ${cocinaCompact ? 'py-0 text-xs' : 'py-0.5'}`}>
                      <button className="px-2 py-0.5 rounded bg-gray-200 disabled:opacity-50" disabled={it.entregados <= 0} onClick={() => updateItemEntregados(order.id, it.producto_id, Math.max(0, it.entregados - 1))}>-</button>
                      <span className="text-xs text-gray-600">faltan {Math.max(0, it.cantidad - it.entregados)}</span>
                      <button className={`px-2 ${cocinaCompact ? 'py-0.5' : 'py-0.5'} rounded bg-yellow-200 hover:bg-yellow-300 disabled:opacity-50`} disabled={it.entregados >= it.cantidad} onClick={() => updateItemEntregados(order.id, it.producto_id, Math.min(it.cantidad, it.entregados + 1))}>prep +1</button>
                      <span>
                        {it.nombre} x{it.cantidad}{!cocinaCompact ? ` ($${(it.precio * it.cantidad).toFixed(2)})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {kitchenOrders.length === 0 && (<div className="text-gray-500">Sin pendientes en cocina</div>)}
        </section>
      )}

      {activeTab === 'tickets' && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tickets.map(order => (
            <div key={order.id} className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold mb-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                <span>Mesa {order.mesa_numero}</span>
                <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-200">#{order.id}</span>
              </h2>
              <div className="text-xs text-gray-600 flex items-center flex-wrap gap-2 justify-between">
                <span>{toDateUtc(order.fecha).toLocaleString()}</span>
                <span className={`px-2 py-0.5 text-xs rounded ${order.estado === 'pendiente' ? 'bg-gray-200' : order.estado === 'en_proceso' ? 'bg-yellow-200' : 'bg-green-200'}`}>{order.estado}</span>
                <span className={`px-2 py-0.5 text-xs rounded ${faltantesOrden(order) > 0 ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>{faltantesOrden(order) > 0 ? `Faltan ${faltantesOrden(order)}` : 'Listo'}</span>
              </div>
              <ul className="mt-2 text-sm text-gray-700 ml-0">
                {order.items.map(it => (
                  <li key={it.producto_id} className="flex items-center gap-2 py-0.5">
                    <button className="px-2 py-0.5 rounded bg-gray-200 disabled:opacity-50" disabled={it.entregados <= 0} onClick={() => updateItemEntregados(order.id, it.producto_id, Math.max(0, it.entregados - 1))}>-</button>
                    <span className="text-xs text-gray-600">{it.entregados}/{it.cantidad} • faltan {Math.max(0, it.cantidad - it.entregados)}</span>
                    <button className="px-2 py-0.5 rounded bg-gray-200 disabled:opacity-50" disabled={it.entregados >= it.cantidad} onClick={() => updateItemEntregados(order.id, it.producto_id, Math.min(it.cantidad, it.entregados + 1))}>+</button>
                    <span className={(it.entregados >= it.cantidad ? 'line-through text-green-700 ' : '') + ((recentDelivered && recentDelivered.orderId === order.id && recentDelivered.productoId === it.producto_id) ? ' bg-green-100 animate-pulse rounded px-1' : '')}>
                      {it.nombre} x{it.cantidad} (${(it.precio * it.cantidad).toFixed(2)})
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-col sm:flex-row items-start sm:items-center gap-2 justify-between">
                <div className="font-medium">Total: ${sumOrderTotal(order).toFixed(2)}</div>
                <div className="flex flex-wrap gap-2">
                  <button className="px-3 py-1 rounded bg-gray-300" onClick={() => updateEstado(order.id, 'pendiente')}>Pendiente</button>
                  <button className="px-3 py-1 rounded bg-yellow-500 text-white" onClick={() => updateEstado(order.id, 'en_proceso')}>En proceso</button>
                  <button className="px-3 py-1 rounded bg-green-600 text-white disabled:opacity-50" disabled={!order.items.every(it => it.entregados >= it.cantidad)} onClick={() => updateEstado(order.id, 'entregado')}>Entregado</button>
                  {order.estado === 'entregado' && (
                    <button className="ml-auto px-3 py-1 rounded bg-indigo-600 text-white" onClick={() => cobrarOrden(order)}>
                      Cobrar
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {tickets.length === 0 && (<div className="text-gray-500">Sin tickets activos</div>)}
        </section>
      )}

      {/* Gestión de productos (tab) */}
      {activeTab === 'productos' && (
        <section className="bg-white rounded-lg shadow p-4 border-2 border-blue-300">
          <h2 className="font-semibold mb-3">Gestión de productos</h2>
          {prodError && <div className="text-red-600 mb-2">{prodError}</div>}
          <div className="mb-4 border rounded p-3">
            <h3 className="font-medium mb-2">Nuevo producto</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              <input className="border rounded p-2" placeholder="Nombre" value={nuevoProd.nombre} onChange={e => setNuevoProd(p => ({ ...p, nombre: e.target.value }))} />
              <input className="border rounded p-2" placeholder="Precio" value={nuevoProd.precio} onChange={e => setNuevoProd(p => ({ ...p, precio: e.target.value }))} />
              <input className="border rounded p-2 sm:col-span-2 md:col-span-1" placeholder="Imagen (URL opcional)" value={nuevoProd.imagen} onChange={e => setNuevoProd(p => ({ ...p, imagen: e.target.value }))} />
            </div>
            <div className="mt-2 flex sm:justify-end">
              <button className="w-full sm:w-auto px-3 py-1 rounded bg-green-600 text-white" onClick={createProducto}>Crear producto</button>
            </div>
          </div>

          <ul className="space-y-2">
            {productos.map((p, i) => (
              <li key={p.id} className="flex flex-col md:flex-row md:items-center gap-2">
                <input className="border rounded p-2 w-full md:flex-1" value={p.nombre} onChange={e => handleProdChange(i, 'nombre', e.target.value)} />
                <input className="border rounded p-2 w-full md:w-32" value={String(p.precio)} onChange={e => handleProdChange(i, 'precio', e.target.value)} />
                <input className="border rounded p-2 w-full md:flex-1" value={p.imagen || ''} onChange={e => handleProdChange(i, 'imagen', e.target.value)} />
                <div className="flex gap-2 md:ml-0">
                  <button className="w-full md:w-auto px-3 py-1 rounded bg-green-600 text-white" onClick={() => saveProducto(p)}>Guardar</button>
                  <button className="w-full md:w-auto px-3 py-1 rounded bg-red-600 text-white" onClick={() => deleteProducto(p.id)}>Eliminar</button>
                </div>
              </li>
            ))}
            {productos.length === 0 && (<li className="text-gray-500">Sin productos</li>)}
          </ul>
        </section>
      )}

      {activeTab === 'qr' && (
        <section className="bg-white rounded-lg shadow p-4 border-2 border-indigo-300">
          <h2 className="font-semibold mb-3">Generación de QR</h2>
          {qrError && <div className="text-red-600 mb-2">{qrError}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Base URL</span>
              <input className="border rounded p-2" placeholder="https://tu-dominio/orden?mesa=" value={qrBaseUrl} onChange={e => setQrBaseUrl(e.target.value)} />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Total de mesas</span>
              <input className="border rounded p-2" placeholder="ej. 12" value={qrTotalMesas} onChange={e => setQrTotalMesas(e.target.value)} />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 mt-3">
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Estilo</span>
              <select className="border rounded p-2" value={qrStyle} onChange={e => setQrStyle(e.target.value)}>
                <option value="square">Cuadrado</option>
                <option value="rounded">Redondeado</option>
                <option value="circle">Círculos</option>
                <option value="gapped_square">Cuadrado separado</option>
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Color de módulos</span>
              <input type="color" className="border rounded p-2 h-10" value={qrFill} onChange={e => setQrFill(e.target.value)} />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Color de fondo</span>
              <input type="color" className="border rounded p-2 h-10" value={qrBack} onChange={e => setQrBack(e.target.value)} />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Gradiente</span>
              <select className="border rounded p-2" value={qrGradient} onChange={e => setQrGradient(e.target.value)}>
                <option value="none">Sin gradiente</option>
                <option value="linear">Lineal</option>
                <option value="radial">Radial</option>
              </select>
            </label>
            <label className="flex flex-col md:col-span-2">
              <span className="text-xs text-gray-600 mb-1">Logo (URL opcional)</span>
              <input className="border rounded p-2" placeholder="https://..." value={qrLogoUrl} onChange={e => setQrLogoUrl(e.target.value)} />
            </label>
            <label className="flex flex-col md:col-span-2">
              <span className="text-xs text-gray-600 mb-1">Texto/etiqueta</span>
              <input className="border rounded p-2" placeholder="p. ej. Mesa 1" value={qrLabel} onChange={e => setQrLabel(e.target.value)} />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Posición etiqueta</span>
              <select className="border rounded p-2" value={qrLabelPos} onChange={e => setQrLabelPos(e.target.value)}>
                <option value="bottom">Abajo</option>
                <option value="top">Arriba</option>
                <option value="center">Centro</option>
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Color etiqueta</span>
              <input type="color" className="border rounded p-2 h-10" value={qrLabelColor} onChange={e => setQrLabelColor(e.target.value)} />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Estilo etiqueta</span>
              <select className="border rounded p-2" value={qrLabelStyle} onChange={e => setQrLabelStyle(e.target.value)}>
                <option value="plain">Simple</option>
                <option value="banner">Banner</option>
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-600 mb-1">Fondo etiqueta</span>
              <input type="color" className="border rounded p-2 h-10" value={qrLabelBg} onChange={e => setQrLabelBg(e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="px-3 py-1 rounded bg-indigo-600 text-white disabled:opacity-50" disabled={qrBusy} onClick={generarQrZip}>
              {qrBusy ? 'Generando...' : 'Generar ZIP'}
            </button>
            <label className="flex items-center gap-2">
              <span className="text-xs text-gray-600">Vista previa mesa</span>
              <input className="border rounded p-1 w-20" value={qrPreviewMesa} onChange={e => setQrPreviewMesa(e.target.value)} />
              <button className="px-3 py-1 rounded bg-gray-200" onClick={previewQr}>Ver</button>
            </label>
          </div>
          {qrPreviewSrc && (
            <div className="mt-3">
              <img src={qrPreviewSrc} alt="QR preview" className="w-40 border rounded" />
            </div>
          )}
          <p className="mt-3 text-xs text-gray-600">Tip: usa el botón ZIP para descargar todos los PNG en un archivo comprimido.</p>
        </section>
      )}

    </div>
  )
}