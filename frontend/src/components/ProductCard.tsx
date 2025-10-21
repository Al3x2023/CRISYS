import type { Producto } from '../context/CartContext'
import { useCart } from '../context/CartContext'

export default function ProductCard({ product }: { product: Producto }) {
  const { increment, items } = useCart()
  const qty = items.find(i => i.producto_id === product.id)?.cantidad ?? 0

  return (
    <button
      onClick={() => increment(product)}
      className="bg-white rounded-lg shadow hover:shadow-md transition p-4 flex flex-col items-center gap-2 border border-gray-100"
    >
      {product.imagen && (
        <img src={product.imagen} alt={product.nombre} className="w-24 h-24 object-cover rounded" />
      )}
      <div className="text-center">
        <div className="font-semibold">{product.nombre}</div>
        <div className="text-sm text-gray-600">${product.precio.toFixed(2)}</div>
      </div>
      {qty > 0 && (
        <div className="text-xs text-white bg-blue-600 rounded-full px-2 py-0.5">x{qty}</div>
      )}
    </button>
  )
}