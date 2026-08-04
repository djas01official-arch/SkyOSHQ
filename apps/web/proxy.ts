export { auth as proxy } from '@/auth';

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/ai/:path*',
    '/knowledge/:path*',
    '/tasks/:path*',
    '/settings/:path*',
  ],
};
