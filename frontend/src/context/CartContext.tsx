import React, { createContext, useContext, useMemo, useState } from 'react'

export type Producto = {
  id: number
  nombre: string
  precio: number
  imagen?: string
}

export type CartItem = {
  producto_id: number
  nombre: string
  precio: number
  cantidad: number
}

export type CartContextType = {
  items: CartItem[]
  increment: (p: Producto) => void
  decrement: (producto_id: number) => void
  clear: () => void
  total: number
}

const CartContext = createContext<CartContextType | undefined>(undefined)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([])

  const increment = (p: Producto) => {
    setItems(prev => {
      const existing = prev.find(i => i.producto_id === p.id)
      if (!existing) return [...prev, { producto_id: p.id, nombre: p.nombre, precio: p.precio, cantidad: 1 }]
      return prev.map(i => i.producto_id === p.id ? { ...i, cantidad: i.cantidad + 1 } : i)
    })
  }

  const decrement = (producto_id: number) => {
    setItems(prev => {
      const existing = prev.find(i => i.producto_id === producto_id)
      if (!existing) return prev
      if (existing.cantidad <= 1) return prev.filter(i => i.producto_id !== producto_id)
      return prev.map(i => i.producto_id === producto_id ? { ...i, cantidad: i.cantidad - 1 } : i)
    })
  }

  const clear = () => setItems([])

  const total = useMemo(() => items.reduce((sum, i) => sum + i.precio * i.cantidad, 0), [items])

  const value: CartContextType = { items, increment, decrement, clear, total }
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}