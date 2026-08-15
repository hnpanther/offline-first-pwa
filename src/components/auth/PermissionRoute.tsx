import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import type { AuthSession } from '@/types/auth'

interface PermissionRouteProps {
  children: React.ReactNode
  /**
   * What the user must be able to do to reach this route. Taking a predicate rather than a
   * role name is the whole point: a role duplicated from ADMIN carries ADMIN's permissions but
   * not its code, and a route guarded by the code would turn it away from screens the server
   * would happily serve it.
   */
  allow: (session: AuthSession | null) => boolean
}

/**
 * Route guard driven by what the session may do.
 *
 * <p>This is a UI convenience, never the enforcement: every screen behind it calls endpoints
 * the server checks independently. Its job is to avoid offering a door that leads to a 403.
 */
export function PermissionRoute({ children, allow }: PermissionRouteProps) {
  const { authSession } = useAuth()

  if (!authSession || !allow(authSession)) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
