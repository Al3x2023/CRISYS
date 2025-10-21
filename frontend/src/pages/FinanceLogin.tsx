import { useState } from 'react'

const API_PREFIX = (import.meta.env.VITE_API_BASE as string) || '/api'

export default function FinanceLogin() {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const resp = await fetch(`${API_PREFIX}/finanzas/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ user, password })
      })
      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(txt)
      }
      // Redirigir al panel de finanzas
      window.location.href = '/finanzas'
    } catch (e: any) {
      setError(e.message || 'Error de login')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm bg-white rounded shadow p-6 space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold">Finanzas · Login</h1>
          <p className="text-sm text-gray-600">Acceso restringido</p>
        </div>
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-700 mb-1">Usuario</label>
            <input
              type="text"
              className="w-full border rounded px-3 py-2"
              value={user}
              onChange={e => setUser(e.target.value)}
              placeholder="admin"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">Contraseña</label>
            <input
              type="password"
              className="w-full border rounded px-3 py-2"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >{loading ? 'Ingresando...' : 'Ingresar'}</button>
        </form>
      </div>
    </div>
  )
}