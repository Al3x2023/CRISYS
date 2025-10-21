import { CartProvider } from './context/CartContext'
import MenuPage from './pages/MenuPage'
import AdminPage from './pages/AdminPage'
import FinancePage from './pages/FinancePage'
import FinanceLogin from './pages/FinanceLogin'

export default function App() {
  const path = window.location.pathname
  const isAdmin = path.startsWith('/admin')
  const isFinanzas = path.startsWith('/finanzas')
  const isFinLogin = path.startsWith('/finanzas/login')
  return (
    <CartProvider>
      {isAdmin
        ? <AdminPage />
        : isFinanzas
          ? (isFinLogin ? <FinanceLogin /> : <FinancePage />)
          : <MenuPage />}
    </CartProvider>
  )
}