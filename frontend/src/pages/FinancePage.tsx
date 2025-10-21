import { useEffect, useMemo, useState } from 'react'

const API_PREFIX = (import.meta.env.VITE_API_BASE as string) || '/api'

type ResumenOut = {
  total: number
  propina: number
  cantidad: number
}

type PagoOut = {
  id: number
  orden_id: number
  metodo: string
  monto_total: number
  propina: number
  fecha: string
}

export default function FinancePage() {
  const [loading, setLoading] = useState(true)
  const [authChecked, setAuthChecked] = useState(false)
  const [resumen, setResumen] = useState<ResumenOut | null>(null)
  const [pagos, setPagos] = useState<PagoOut[]>([])
  const [desde, setDesde] = useState<string>('')
  const [hasta, setHasta] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (desde) p.set('desde', desde)
    if (hasta) p.set('hasta', hasta)
    const q = p.toString()
    return q ? `?${q}` : ''
  }, [desde, hasta])

  const checkAuth = async () => {
    try {
      const resp = await fetch(`${API_PREFIX}/finanzas/me`, { credentials: 'include' })
      if (resp.status === 401) {
        window.location.href = '/finanzas/login'
        return
      }
    } catch (e) {
      // Si hay fallo de red, mantener en la pantalla pero mostrar error
      setError('No se pudo verificar la sesión')
    } finally {
      setAuthChecked(true)
    }
  }

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API_PREFIX}/finanzas/resumen${qs}`, { credentials: 'include' }),
        fetch(`${API_PREFIX}/finanzas/pagos${qs}`, { credentials: 'include' }),
      ])
      if (!r1.ok) throw new Error(await r1.text())
      if (!r2.ok) throw new Error(await r2.text())
      const resumenData: ResumenOut = await r1.json()
      const pagosData: PagoOut[] = await r2.json()
      setResumen(resumenData)
      setPagos(pagosData)
    } catch (e: any) {
      setError(e.message || 'Error al cargar datos')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkAuth()
  }, [])

  useEffect(() => {
    if (authChecked) {
      loadData()
    }
  }, [authChecked, qs])

  const logout = async () => {
    try {
      await fetch(`${API_PREFIX}/finanzas/logout`, { method: 'POST', credentials: 'include' })
    } catch {}
    window.location.href = '/finanzas/login'
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b p-3 flex items-center justify-between">
        <h1 className="font-semibold">Finanzas</h1>
        <div className="flex items-center gap-2">
          <button onClick={loadData} className="px-2 py-1 text-sm rounded bg-blue-100 text-blue-800 hover:bg-blue-200">Refrescar</button>
          <button onClick={logout} className="px-2 py-1 text-sm rounded bg-gray-200 hover:bg-gray-300">Salir</button>
        </div>
      </div>

      <div className="p-3 space-y-4">
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white rounded shadow p-3">
            <div className="text-sm text-gray-600 mb-1">Filtros</div>
            <div className="flex items-center gap-2">
              <div>
                <label className="block text-xs text-gray-600">Desde</label>
                <input type="date" className="border rounded px-2 py-1" value={desde} onChange={e => setDesde(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-gray-600">Hasta</label>
                <input type="date" className="border rounded px-2 py-1" value={hasta} onChange={e => setHasta(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="bg-white rounded shadow p-3">
            <div className="text-sm text-gray-600 mb-1">Total</div>
            <div className="text-2xl font-semibold">${resumen ? resumen.total.toFixed(2) : (loading ? '...' : '0.00')}</div>
          </div>
          <div className="bg-white rounded shadow p-3">
            <div className="text-sm text-gray-600 mb-1">Propina</div>
            <div className="text-2xl font-semibold">${resumen ? resumen.propina.toFixed(2) : (loading ? '...' : '0.00')}</div>
          </div>
        </div>

        <div className="bg-white rounded shadow p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium">Pagos ({resumen ? resumen.cantidad : 0})</div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="px-2 py-1">ID</th>
                  <th className="px-2 py-1">Orden</th>
                  <th className="px-2 py-1">Método</th>
                  <th className="px-2 py-1">Monto</th>
                  <th className="px-2 py-1">Propina</th>
                  <th className="px-2 py-1">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td className="px-2 py-3" colSpan={6}>Cargando...</td></tr>
                ) : pagos.length === 0 ? (
                  <tr><td className="px-2 py-3" colSpan={6}>Sin pagos en el rango</td></tr>
                ) : pagos.map(p => (
                  <tr key={p.id} className="border-t">
                    <td className="px-2 py-1">{p.id}</td>
                    <td className="px-2 py-1">{p.orden_id}</td>
                    <td className="px-2 py-1">{p.metodo}</td>
                    <td className="px-2 py-1">${p.monto_total.toFixed(2)}</td>
                    <td className="px-2 py-1">${(p.propina || 0).toFixed(2)}</td>
                    <td className="px-2 py-1">{new Date(p.fecha).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}