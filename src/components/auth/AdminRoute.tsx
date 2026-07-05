import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { isAdminRole } from '@/types/auth'

interface AdminRouteProps {
  children: React.ReactNode
}

export function AdminRoute({ children }: AdminRouteProps) {
  const { authSession } = useAuth()

  if (!authSession || !isAdminRole(authSession.roles)) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
