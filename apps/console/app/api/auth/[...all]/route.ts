import { proxyAccountRequest } from '@/lib/account-proxy'
const handleAuthRequest = proxyAccountRequest
export { handleAuthRequest as GET, handleAuthRequest as POST }
