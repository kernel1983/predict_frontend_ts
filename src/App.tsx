import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from '@/components/guards/ProtectedRoute'
import ChessDebugPage from '@/pages/ChessDebugPage'
import CasualChessPage from '@/pages/CasualChessPage'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import MarketPage from '@/pages/MarketPage'
import PortfolioPage from '@/pages/PortfolioPage'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<HomePage />} />
      <Route path="/chess/:gameId" element={<ChessDebugPage />} />
      <Route path="/casual-chess" element={<CasualChessPage />} />
      <Route path="/casual-chess/:gameId" element={<CasualChessPage />} />
      <Route
        path="/portfolio"
        element={
          <ProtectedRoute>
            <PortfolioPage />
          </ProtectedRoute>
        }
      />
      <Route path="/market/:marketId" element={<MarketPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
